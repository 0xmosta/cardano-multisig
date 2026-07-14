import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const SENSITIVE_DATA_PREFIX = "sec1:";

function configuredEncryptionSecret() {
  const value = (
    process.env.CARDANO_MULTISIG_DATA_ENCRYPTION_SECRET ||
    process.env.CARDANO_MULTISIG_SESSION_SECRET ||
    process.env.CARDANO_MULTISIG_ACCOUNT_SECRET ||
    ""
  ).trim();
  if (!value) throw new Error("A server encryption secret is required for sensitive account data.");
  if ((process.env.NODE_ENV || "").trim().toLowerCase() === "production" && Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("The server encryption secret must be at least 32 bytes in production.");
  }
  return value;
}

function decryptionSecrets() {
  const candidates = [
    configuredEncryptionSecret(),
    ...(process.env.CARDANO_MULTISIG_DATA_ENCRYPTION_SECRET_PREVIOUS || "").split(","),
    process.env.CARDANO_MULTISIG_SESSION_SECRET || "",
    process.env.CARDANO_MULTISIG_ACCOUNT_SECRET || "",
  ].map((value) => value.trim()).filter(Boolean);
  return [...new Set(candidates)];
}

function encryptionKey(secret: string, purpose: string) {
  return createHash("sha256").update(`${secret}:${purpose}:v1`).digest();
}

export function encryptSensitiveJson(value: unknown, purpose: string) {
  const iv = randomBytes(12);
  const aad = Buffer.from(purpose, "utf8");
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(configuredEncryptionSecret(), purpose), iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SENSITIVE_DATA_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptSensitiveJson<T>(value: string, purpose: string): T {
  if (!value.startsWith(SENSITIVE_DATA_PREFIX)) throw new Error("Sensitive data envelope has an unsupported format.");
  const bytes = Buffer.from(value.slice(SENSITIVE_DATA_PREFIX.length), "base64");
  if (bytes.length < 29) throw new Error("Sensitive data envelope is invalid.");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const aad = Buffer.from(purpose, "utf8");
  let lastError: unknown;

  for (const secret of decryptionSecrets()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret, purpose), iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Sensitive data could not be decrypted${lastError ? "." : ""}`);
}

export function isSensitiveDataEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SENSITIVE_DATA_PREFIX);
}
