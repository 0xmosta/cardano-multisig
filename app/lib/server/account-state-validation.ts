import type {
  AssetLine,
  MultisigWallet,
  NativeScript,
  Network,
  RelayRoomRef,
  SignatureRecord,
  Signer,
  TxDraft,
  WalletDiscovery,
} from "../multisig";
import { isKeyHash, isRecord, normalizeKeyHash } from "../multisig";

const MAX_WALLETS = 500;
const MAX_TRANSACTIONS = 2_000;
const MAX_SIGNERS = 64;
const MAX_ASSETS = 200;
const MAX_SIGNATURES = 64;
const MAX_SCRIPT_DEPTH = 20;
const MAX_SCRIPT_NODES = 256;
const MAX_ID_CHARS = 256;
const MAX_LABEL_CHARS = 500;
const MAX_NOTE_CHARS = 2_000;
const MAX_ADDRESS_CHARS = 512;
const MAX_CBOR_CHARS = 500_000;

const SENSITIVE_KEYS = new Set([
  "rootkey",
  "privatekey",
  "privatekeys",
  "secretkey",
  "signingkey",
  "seed",
  "seedphrase",
  "mnemonic",
  "recoveryphrase",
  "xprv",
  "encryptedkey",
]);

function boundedString(value: unknown, field: string, maxLength: number, required = true) {
  const next = typeof value === "string" ? value.trim() : "";
  if (required && !next) throw new Error(`${field} is required.`);
  if (next.length > maxLength) throw new Error(`${field} is too long.`);
  return next;
}

function optionalString(value: unknown, field: string, maxLength: number) {
  const next = boundedString(value, field, maxLength, false);
  return next || undefined;
}

function integer(value: unknown, field: string, minimum: number, maximum: number) {
  const next = Number(value);
  if (!Number.isInteger(next) || next < minimum || next > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return next;
}

export function assertNoCustodialSecrets(value: unknown, path = "account state", depth = 0) {
  if (depth > 30) throw new Error(`${path} is nested too deeply.`);
  if (typeof value === "string" && /^xprv/i.test(value.trim())) {
    throw new Error(`${path} contains a private extended key. Private keys cannot be stored.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCustodialSecrets(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const populated = child !== null && child !== undefined && child !== "";
    if (populated && SENSITIVE_KEYS.has(normalized)) {
      throw new Error(`${path}.${key} contains custodial key material and cannot be stored.`);
    }
    assertNoCustodialSecrets(child, `${path}.${key}`, depth + 1);
  }
}

function sanitizeAsset(raw: unknown, index: number, field: string): AssetLine {
  if (!isRecord(raw)) throw new Error(`${field}[${index}] is invalid.`);
  const unit = boundedString(raw.unit, `${field}[${index}].unit`, 256);
  const quantity = boundedString(raw.quantity, `${field}[${index}].quantity`, 128);
  if (!/^-?\d+$/.test(quantity)) throw new Error(`${field}[${index}].quantity must be an integer string.`);
  const maxQuantity = optionalString(raw.maxQuantity, `${field}[${index}].maxQuantity`, 128);
  if (maxQuantity && !/^-?\d+$/.test(maxQuantity)) throw new Error(`${field}[${index}].maxQuantity must be an integer string.`);
  const decimals = raw.decimals === undefined ? undefined : integer(raw.decimals, `${field}[${index}].decimals`, 0, 30);
  return {
    id: optionalString(raw.id, `${field}[${index}].id`, MAX_ID_CHARS) || `${unit}-${index}`,
    unit,
    label: boundedString(raw.label, `${field}[${index}].label`, MAX_LABEL_CHARS),
    quantity,
    ...(maxQuantity ? { maxQuantity } : {}),
    ...(decimals === undefined ? {} : { decimals }),
  };
}

function sanitizeAssets(raw: unknown, field: string) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array.`);
  if (raw.length > MAX_ASSETS) throw new Error(`${field} cannot contain more than ${MAX_ASSETS} assets.`);
  return raw.map((asset, index) => sanitizeAsset(asset, index, field));
}

function sanitizeNativeScript(raw: unknown, field: string, depth = 0, counter = { value: 0 }): NativeScript {
  if (!isRecord(raw)) throw new Error(`${field} must be a native script object.`);
  if (depth > MAX_SCRIPT_DEPTH) throw new Error(`${field} exceeds the maximum native-script depth.`);
  counter.value += 1;
  if (counter.value > MAX_SCRIPT_NODES) throw new Error(`${field} contains too many native-script nodes.`);
  const type = boundedString(raw.type, `${field}.type`, 32);
  if (!["sig", "all", "any", "atLeast", "before", "after"].includes(type)) {
    throw new Error(`${field}.type is unsupported.`);
  }
  const script: NativeScript = { type };
  if (type === "sig") {
    const keyHash = normalizeKeyHash(boundedString(raw.keyHash, `${field}.keyHash`, 56));
    if (!isKeyHash(keyHash)) throw new Error(`${field}.keyHash must be a 56-character key hash.`);
    script.keyHash = keyHash;
  }
  if (type === "atLeast") script.required = integer(raw.required, `${field}.required`, 1, MAX_SIGNERS);
  if (type === "before" || type === "after") script.slot = integer(raw.slot, `${field}.slot`, 0, Number.MAX_SAFE_INTEGER);
  if (["all", "any", "atLeast"].includes(type)) {
    if (!Array.isArray(raw.scripts) || !raw.scripts.length) throw new Error(`${field}.scripts must contain child scripts.`);
    if (raw.scripts.length > MAX_SIGNERS) throw new Error(`${field}.scripts contains too many children.`);
    script.scripts = raw.scripts.map((child, index) => sanitizeNativeScript(child, `${field}.scripts[${index}]`, depth + 1, counter));
    if (type === "atLeast" && (script.required || 0) > script.scripts.length) {
      throw new Error(`${field}.required cannot exceed its child count.`);
    }
  }
  return script;
}

function sanitizeSigner(raw: unknown, index: number, field: string): Signer {
  if (!isRecord(raw)) throw new Error(`${field}[${index}] is invalid.`);
  const keyHash = normalizeKeyHash(boundedString(raw.keyHash, `${field}[${index}].keyHash`, 56));
  if (!isKeyHash(keyHash)) throw new Error(`${field}[${index}].keyHash must be a 56-character key hash.`);
  const source = raw.source === "payment" || raw.source === "stake" || raw.source === "manual" ? raw.source : undefined;
  return {
    id: optionalString(raw.id, `${field}[${index}].id`, MAX_ID_CHARS) || `signer-${index + 1}`,
    label: boundedString(raw.label, `${field}[${index}].label`, MAX_LABEL_CHARS),
    keyHash,
    ...(source ? { source } : {}),
  };
}

function sanitizeDiscovery(raw: unknown, field: string): WalletDiscovery | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} is invalid.`);
  if (raw.kind !== "script" && raw.kind !== "address") throw new Error(`${field}.kind is invalid.`);
  const outputs = raw.outputs === undefined ? undefined : integer(raw.outputs, `${field}.outputs`, 0, Number.MAX_SAFE_INTEGER);
  const handle = isRecord(raw.handle)
    ? {
        name: boundedString(raw.handle.name, `${field}.handle.name`, MAX_LABEL_CHARS),
        address: boundedString(raw.handle.address, `${field}.handle.address`, MAX_ADDRESS_CHARS),
      }
    : undefined;
  return {
    kind: raw.kind,
    ...(optionalString(raw.address, `${field}.address`, MAX_ADDRESS_CHARS) ? { address: optionalString(raw.address, `${field}.address`, MAX_ADDRESS_CHARS) } : {}),
    ...(optionalString(raw.source, `${field}.source`, MAX_LABEL_CHARS) ? { source: optionalString(raw.source, `${field}.source`, MAX_LABEL_CHARS) } : {}),
    ...(outputs === undefined ? {} : { outputs }),
    ...(sanitizeAssets(raw.assets, `${field}.assets`) ? { assets: sanitizeAssets(raw.assets, `${field}.assets`) } : {}),
    ...(handle ? { handle } : {}),
  };
}

function sanitizeWallet(raw: unknown, index: number, network: Network): MultisigWallet {
  if (!isRecord(raw)) throw new Error(`wallets[${index}] is invalid.`);
  if (raw.network !== network) throw new Error(`wallets[${index}] targets a different network.`);
  const signersRaw = raw.signers === undefined ? [] : raw.signers;
  if (!Array.isArray(signersRaw) || signersRaw.length > MAX_SIGNERS) throw new Error(`wallets[${index}].signers is invalid.`);
  const paymentScript = raw.paymentScript ? sanitizeNativeScript(raw.paymentScript, `wallets[${index}].paymentScript`) : undefined;
  const stakeScript = raw.stakeScript ? sanitizeNativeScript(raw.stakeScript, `wallets[${index}].stakeScript`) : raw.stakeScript === null ? null : undefined;
  const legacyScript = raw.script ? sanitizeNativeScript(raw.script, `wallets[${index}].script`) : undefined;
  const discovery = sanitizeDiscovery(raw.discovery, `wallets[${index}].discovery`);
  if (!paymentScript && !legacyScript && !discovery?.address && discovery?.kind !== "address") {
    throw new Error(`wallets[${index}] must include a native script or watch address.`);
  }
  return {
    id: boundedString(raw.id, `wallets[${index}].id`, MAX_ID_CHARS),
    name: boundedString(raw.name, `wallets[${index}].name`, MAX_LABEL_CHARS),
    network,
    threshold: integer(raw.threshold, `wallets[${index}].threshold`, 0, MAX_SIGNERS),
    signers: signersRaw.map((signer, signerIndex) => sanitizeSigner(signer, signerIndex, `wallets[${index}].signers`)),
    ...(paymentScript ? { paymentScript } : {}),
    ...(stakeScript === undefined ? {} : { stakeScript }),
    ...(legacyScript ? { script: legacyScript } : {}),
    createdAt: boundedString(raw.createdAt, `wallets[${index}].createdAt`, 64),
    imported: Boolean(raw.imported),
    ...(optionalString(raw.handle, `wallets[${index}].handle`, 128) ? { handle: optionalString(raw.handle, `wallets[${index}].handle`, 128) } : {}),
    ...(discovery ? { discovery } : {}),
  };
}

function sanitizeSignature(raw: unknown, index: number, field: string): SignatureRecord {
  if (!isRecord(raw)) throw new Error(`${field}[${index}] is invalid.`);
  const witnessCbor = boundedString(raw.witnessCbor, `${field}[${index}].witnessCbor`, MAX_CBOR_CHARS);
  if (!/^[0-9a-f]+$/i.test(witnessCbor) || witnessCbor.length % 2 !== 0) throw new Error(`${field}[${index}].witnessCbor must be hex CBOR.`);
  const matchedSignerKeyHash = optionalString(raw.matchedSignerKeyHash, `${field}[${index}].matchedSignerKeyHash`, 56);
  if (matchedSignerKeyHash && !isKeyHash(matchedSignerKeyHash)) throw new Error(`${field}[${index}].matchedSignerKeyHash is invalid.`);
  const source = raw.source === "relay" || raw.source === "manual" ? raw.source : undefined;
  const matchStatus = raw.matchStatus === "matched" || raw.matchStatus === "unmatched" ? raw.matchStatus : undefined;
  return {
    signerKeyHash: boundedString(raw.signerKeyHash, `${field}[${index}].signerKeyHash`, 128),
    signerName: boundedString(raw.signerName, `${field}[${index}].signerName`, MAX_LABEL_CHARS),
    walletName: boundedString(raw.walletName, `${field}[${index}].walletName`, MAX_LABEL_CHARS),
    witnessCbor: witnessCbor.toLowerCase(),
    signedAt: boundedString(raw.signedAt, `${field}[${index}].signedAt`, 64),
    ...(source ? { source } : {}),
    ...(matchStatus ? { matchStatus } : {}),
    ...(matchedSignerKeyHash ? { matchedSignerKeyHash: normalizeKeyHash(matchedSignerKeyHash) } : {}),
    ...(optionalString(raw.relayWitnessId, `${field}[${index}].relayWitnessId`, MAX_ID_CHARS) ? { relayWitnessId: optionalString(raw.relayWitnessId, `${field}[${index}].relayWitnessId`, MAX_ID_CHARS) } : {}),
  };
}

function sanitizeInviteUrl(value: unknown, field: string) {
  const url = boundedString(value, field, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(url, "https://cardano.invalid");
  } catch {
    throw new Error(`${field} is invalid.`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${field} must use HTTP or HTTPS.`);
  const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("r");
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error(`${field} does not contain a valid relay capability.`);
  return url;
}

function sanitizeRelayRoom(raw: unknown, field: string): RelayRoomRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} is invalid.`);
  const status = raw.status === "open" || raw.status === "submitted" || raw.status === "cancelled" || raw.status === "expired" ? raw.status : undefined;
  const coordinatorToken = optionalString(raw.coordinatorToken, `${field}.coordinatorToken`, 256);
  if (coordinatorToken && !/^[A-Za-z0-9_-]{32,128}$/.test(coordinatorToken)) throw new Error(`${field}.coordinatorToken is invalid.`);
  const signerInvites = raw.signerInvites === undefined
    ? undefined
    : Array.isArray(raw.signerInvites) && raw.signerInvites.length <= MAX_SIGNERS
      ? raw.signerInvites.map((invite, index) => {
          if (!isRecord(invite)) throw new Error(`${field}.signerInvites[${index}] is invalid.`);
          const keyHash = normalizeKeyHash(boundedString(invite.keyHash, `${field}.signerInvites[${index}].keyHash`, 56));
          if (!isKeyHash(keyHash)) throw new Error(`${field}.signerInvites[${index}].keyHash is invalid.`);
          return {
            keyHash,
            ...(optionalString(invite.label, `${field}.signerInvites[${index}].label`, MAX_LABEL_CHARS) ? { label: optionalString(invite.label, `${field}.signerInvites[${index}].label`, MAX_LABEL_CHARS) } : {}),
            inviteUrl: sanitizeInviteUrl(invite.inviteUrl, `${field}.signerInvites[${index}].inviteUrl`),
          };
        })
      : (() => { throw new Error(`${field}.signerInvites is invalid.`); })();
  return {
    roomId: boundedString(raw.roomId, `${field}.roomId`, MAX_ID_CHARS),
    ...(coordinatorToken ? { coordinatorToken } : {}),
    createdAt: boundedString(raw.createdAt, `${field}.createdAt`, 64),
    ...(optionalString(raw.lastSyncAt, `${field}.lastSyncAt`, 64) ? { lastSyncAt: optionalString(raw.lastSyncAt, `${field}.lastSyncAt`, 64) } : {}),
    ...(status ? { status } : {}),
    ...(raw.sharedInviteUrl ? { sharedInviteUrl: sanitizeInviteUrl(raw.sharedInviteUrl, `${field}.sharedInviteUrl`) } : {}),
    ...(signerInvites ? { signerInvites } : {}),
  };
}

function sanitizeTransaction(raw: unknown, index: number, network: Network): TxDraft {
  if (!isRecord(raw)) throw new Error(`transactions[${index}] is invalid.`);
  if (raw.network !== network) throw new Error(`transactions[${index}] targets a different network.`);
  if (!Array.isArray(raw.signerKeyHashes) || raw.signerKeyHashes.length > MAX_SIGNERS) throw new Error(`transactions[${index}].signerKeyHashes is invalid.`);
  const signerKeyHashes = [...new Set(raw.signerKeyHashes.map((value, signerIndex) => {
    const keyHash = normalizeKeyHash(boundedString(value, `transactions[${index}].signerKeyHashes[${signerIndex}]`, 56));
    if (!isKeyHash(keyHash)) throw new Error(`transactions[${index}].signerKeyHashes[${signerIndex}] is invalid.`);
    return keyHash;
  }))];
  const signaturesRaw = raw.signatures === undefined ? [] : raw.signatures;
  if (!Array.isArray(signaturesRaw) || signaturesRaw.length > MAX_SIGNATURES) throw new Error(`transactions[${index}].signatures is invalid.`);
  const unsignedTxCbor = boundedString(raw.unsignedTxCbor, `transactions[${index}].unsignedTxCbor`, MAX_CBOR_CHARS, false).toLowerCase();
  if (unsignedTxCbor && (!/^[0-9a-f]+$/.test(unsignedTxCbor) || unsignedTxCbor.length % 2 !== 0)) {
    throw new Error(`transactions[${index}].unsignedTxCbor must be hex CBOR.`);
  }
  const requiredSignatures = integer(raw.requiredSignatures, `transactions[${index}].requiredSignatures`, 1, MAX_SIGNERS);
  if (signerKeyHashes.length && requiredSignatures > signerKeyHashes.length) throw new Error(`transactions[${index}].requiredSignatures exceeds signer count.`);
  const status = raw.status === "pending" || raw.status === "succeeded" || raw.status === "failed" ? raw.status : undefined;
  const txHash = optionalString(raw.txHash, `transactions[${index}].txHash`, 64);
  if (txHash && !/^[0-9a-f]{64}$/i.test(txHash)) throw new Error(`transactions[${index}].txHash is invalid.`);
  return {
    id: boundedString(raw.id, `transactions[${index}].id`, MAX_ID_CHARS),
    ...(optionalString(raw.walletId, `transactions[${index}].walletId`, MAX_ID_CHARS) ? { walletId: optionalString(raw.walletId, `transactions[${index}].walletId`, MAX_ID_CHARS) } : {}),
    title: boundedString(raw.title, `transactions[${index}].title`, MAX_LABEL_CHARS),
    walletName: boundedString(raw.walletName, `transactions[${index}].walletName`, MAX_LABEL_CHARS),
    network,
    recipient: boundedString(raw.recipient, `transactions[${index}].recipient`, MAX_ADDRESS_CHARS),
    lovelace: boundedString(raw.lovelace, `transactions[${index}].lovelace`, 128),
    note: boundedString(raw.note, `transactions[${index}].note`, MAX_NOTE_CHARS, false),
    unsignedTxCbor,
    requiredSignatures,
    signerKeyHashes,
    signatures: signaturesRaw.map((signature, signatureIndex) => sanitizeSignature(signature, signatureIndex, `transactions[${index}].signatures`)),
    createdAt: boundedString(raw.createdAt, `transactions[${index}].createdAt`, 64),
    ...(sanitizeAssets(raw.assets, `transactions[${index}].assets`) ? { assets: sanitizeAssets(raw.assets, `transactions[${index}].assets`) } : {}),
    ...(status ? { status } : {}),
    ...(optionalString(raw.updatedAt, `transactions[${index}].updatedAt`, 64) ? { updatedAt: optionalString(raw.updatedAt, `transactions[${index}].updatedAt`, 64) } : {}),
    ...(txHash ? { txHash: txHash.toLowerCase() } : {}),
    ...(optionalString(raw.failureReason, `transactions[${index}].failureReason`, MAX_NOTE_CHARS) ? { failureReason: optionalString(raw.failureReason, `transactions[${index}].failureReason`, MAX_NOTE_CHARS) } : {}),
    ...(sanitizeRelayRoom(raw.relayRoom, `transactions[${index}].relayRoom`) ? { relayRoom: sanitizeRelayRoom(raw.relayRoom, `transactions[${index}].relayRoom`) } : {}),
  };
}

export function sanitizeAccountSnapshotInput(input: { wallets?: unknown; transactions?: unknown }, network: Network) {
  assertNoCustodialSecrets(input);
  const wallets = input.wallets === undefined ? [] : input.wallets;
  const transactions = input.transactions === undefined ? [] : input.transactions;
  if (!Array.isArray(wallets) || wallets.length > MAX_WALLETS) throw new Error(`wallets cannot contain more than ${MAX_WALLETS} entries.`);
  if (!Array.isArray(transactions) || transactions.length > MAX_TRANSACTIONS) throw new Error(`transactions cannot contain more than ${MAX_TRANSACTIONS} entries.`);
  return {
    wallets: wallets.map((wallet, index) => sanitizeWallet(wallet, index, network)),
    transactions: transactions.map((tx, index) => sanitizeTransaction(tx, index, network)),
  };
}
