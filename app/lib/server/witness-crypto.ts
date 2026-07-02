import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ENCRYPTED_WITNESS_PREFIX = "enc1:";

function witnessSecret() {
  const value = (process.env.CARDANO_MULTISIG_SESSION_SECRET || process.env.CARDANO_MULTISIG_ACCOUNT_SECRET || "").trim();
  if (!value) {
    throw new Error("CARDANO_MULTISIG_SESSION_SECRET or CARDANO_MULTISIG_ACCOUNT_SECRET must be set for witness encryption.");
  }
  return value;
}

function witnessEncryptionKey() {
  return createHash("sha256").update(`${witnessSecret()}:witnesses`).digest();
}

export function encryptWitness(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", witnessEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_WITNESS_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptWitness(value: string) {
  if (!value.startsWith(ENCRYPTED_WITNESS_PREFIX)) return value;
  const bytes = Buffer.from(value.slice(ENCRYPTED_WITNESS_PREFIX.length), "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", witnessEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isEncryptedWitness(value: string | null | undefined) {
  return Boolean(value && value.startsWith(ENCRYPTED_WITNESS_PREFIX));
}

export { ENCRYPTED_WITNESS_PREFIX };
