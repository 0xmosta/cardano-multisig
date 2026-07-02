import { createCipheriv, createHash, randomBytes } from "node:crypto";

export const ENCRYPTED_WITNESS_PREFIX = "enc1:";

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

export function encryptWitness(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", witnessEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_WITNESS_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function isEncryptedWitness(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_WITNESS_PREFIX);
}
