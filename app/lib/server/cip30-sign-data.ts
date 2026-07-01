import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import * as CSL from "@emurgo/cardano-serialization-lib-browser";

type CborScalar = number | bigint | string | Uint8Array | null | boolean;
type CborValue = CborScalar | CborValue[] | Map<CborScalar, CborValue>;

type CoseSign1 = {
  protectedBytes: Uint8Array;
  payload: Uint8Array | null;
  signature: Uint8Array;
};

type CoseKey = {
  publicKey: Uint8Array;
};

function hexToBytes(hex: string) {
  const normalized = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error("Expected hex bytes.");
  }
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

function bytesToHex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex");
}

function utf8ToBytes(value: string) {
  return new TextEncoder().encode(value);
}

function cborRead(bytes: Uint8Array, offset = 0): { value: CborValue; offset: number } {
  if (offset >= bytes.length) throw new Error("Unexpected end of CBOR.");
  const initial = bytes[offset++]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;

  const readLength = () => {
    if (additional < 24) return additional;
    const byteLength = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (!byteLength) throw new Error("Unsupported CBOR length encoding.");
    if (offset + byteLength > bytes.length) throw new Error("Truncated CBOR length.");
    let length = 0n;
    for (let index = 0; index < byteLength; index += 1) {
      length = (length << 8n) | BigInt(bytes[offset + index]!);
    }
    offset += byteLength;
    return length <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(length) : length;
  };

  const readSlice = (length: number | bigint) => {
    const size = typeof length === "bigint" ? Number(length) : length;
    if (!Number.isFinite(size) || size < 0 || offset + size > bytes.length) {
      throw new Error("Truncated CBOR byte/string data.");
    }
    const value = bytes.slice(offset, offset + size);
    offset += size;
    return value;
  };

  if (major === 0) {
    const value = readLength();
    return { value: typeof value === "bigint" ? value : Number(value), offset };
  }
  if (major === 1) {
    const value = readLength();
    const magnitude = typeof value === "bigint" ? value : BigInt(value);
    const negative = -1n - magnitude;
    return {
      value: negative >= BigInt(Number.MIN_SAFE_INTEGER) && negative <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(negative) : negative,
      offset,
    };
  }
  if (major === 2) return { value: readSlice(readLength()), offset };
  if (major === 3) return { value: new TextDecoder().decode(readSlice(readLength())), offset };
  if (major === 4) {
    const length = readLength();
    const count = typeof length === "bigint" ? Number(length) : length;
    const items: CborValue[] = [];
    for (let index = 0; index < count; index += 1) {
      const parsed = cborRead(bytes, offset);
      items.push(parsed.value);
      offset = parsed.offset;
    }
    return { value: items, offset };
  }
  if (major === 5) {
    const length = readLength();
    const count = typeof length === "bigint" ? Number(length) : length;
    const map = new Map<CborScalar, CborValue>();
    for (let index = 0; index < count; index += 1) {
      const key = cborRead(bytes, offset);
      offset = key.offset;
      const value = cborRead(bytes, offset);
      offset = value.offset;
      if (
        typeof key.value === "number" ||
        typeof key.value === "bigint" ||
        typeof key.value === "string" ||
        key.value instanceof Uint8Array ||
        key.value === null ||
        typeof key.value === "boolean"
      ) {
        map.set(key.value, value.value);
      } else {
        throw new Error("Unsupported CBOR map key.");
      }
    }
    return { value: map, offset };
  }
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }
  throw new Error("Unsupported CBOR value.");
}

function cborEncodeLength(major: number, length: number) {
  if (length < 24) return Uint8Array.from([(major << 5) | length]);
  if (length < 0x100) return Uint8Array.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Uint8Array.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const output = new Uint8Array(5);
  output[0] = (major << 5) | 26;
  output[1] = (length >>> 24) & 0xff;
  output[2] = (length >>> 16) & 0xff;
  output[3] = (length >>> 8) & 0xff;
  output[4] = length & 0xff;
  return output;
}

function concatBytes(parts: Uint8Array[]) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

type CborEncodable = string | Uint8Array | null | CborEncodable[];

function cborEncode(value: CborEncodable): Uint8Array {
  if (typeof value === "string") {
    const bytes = utf8ToBytes(value);
    return concatBytes([cborEncodeLength(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concatBytes([cborEncodeLength(2, value.length), value]);
  }
  if (value === null) {
    return Uint8Array.from([0xf6]);
  }
  const items: Uint8Array[] = value.map((item) => cborEncode(item));
  return concatBytes([cborEncodeLength(4, items.length), ...items]);
}

function parseCoseSign1(signatureHex: string): CoseSign1 {
  const parsed = cborRead(hexToBytes(signatureHex));
  if (parsed.offset !== hexToBytes(signatureHex).length || !Array.isArray(parsed.value) || parsed.value.length !== 4) {
    throw new Error("Invalid COSE_Sign1 signature payload.");
  }
  const [protectedBytes, _unprotected, payload, signature] = parsed.value;
  if (!(protectedBytes instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new Error("Invalid COSE_Sign1 fields.");
  }
  if (!(payload instanceof Uint8Array) && payload !== null) {
    throw new Error("Unsupported COSE_Sign1 payload.");
  }
  return { protectedBytes, payload, signature };
}

function parseCoseKey(keyHex: string): CoseKey {
  const parsed = cborRead(hexToBytes(keyHex));
  if (!(parsed.value instanceof Map)) throw new Error("Invalid COSE key payload.");
  const publicKey = parsed.value.get(-2);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new Error("COSE key did not include an Ed25519 public key.");
  }
  return { publicKey };
}

function ed25519Spki(publicKey: Uint8Array) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return Buffer.concat([prefix, Buffer.from(publicKey)]);
}

function keyHashFromPublicKey(publicKey: Uint8Array) {
  return createHash("blake2b512").update(publicKey).digest("hex").slice(0, 56);
}

export function keyHashFromAddressHex(addressHex: string) {
  const address = CSL.Address.from_bytes(Buffer.from(hexToBytes(addressHex)));
  const credential =
    CSL.BaseAddress.from_address(address)?.payment_cred() ??
    CSL.EnterpriseAddress.from_address(address)?.payment_cred() ??
    CSL.RewardAddress.from_address(address)?.payment_cred();
  const keyHash = credential?.to_keyhash()?.to_hex();
  if (!keyHash) throw new Error("Address did not contain a key credential for CIP-30 auth.");
  return keyHash;
}

export function challengeHexFromJson(payload: Record<string, unknown>) {
  return bytesToHex(utf8ToBytes(JSON.stringify(payload)));
}

export function verifyCip30SignData(args: {
  addressHex: string;
  payloadHex: string;
  signatureHex: string;
  keyHex: string;
}) {
  const sign1 = parseCoseSign1(args.signatureHex);
  const coseKey = parseCoseKey(args.keyHex);
  const payloadBytes = hexToBytes(args.payloadHex);
  const signatureStructure = cborEncode(["Signature1", sign1.protectedBytes, new Uint8Array(), payloadBytes]);
  const publicKey = createPublicKey({ key: ed25519Spki(coseKey.publicKey), format: "der", type: "spki" });
  const verified = verifySignature(null, Buffer.from(signatureStructure), publicKey, Buffer.from(sign1.signature));
  if (!verified) {
    throw new Error("Wallet signature verification failed.");
  }
  const expectedKeyHash = keyHashFromAddressHex(args.addressHex);
  const actualKeyHash = keyHashFromPublicKey(coseKey.publicKey);
  if (expectedKeyHash !== actualKeyHash) {
    throw new Error("Wallet signature public key did not match the claimed Cardano address.");
  }
  return {
    keyHash: actualKeyHash,
    addressHex: args.addressHex.toLowerCase(),
    payloadHex: args.payloadHex.toLowerCase(),
  };
}
