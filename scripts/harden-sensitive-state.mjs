import { createCipheriv, createHash, randomBytes } from "node:crypto";
import process from "node:process";
import pg from "pg";

const databaseUrl = (process.env.DATABASE_URL || "").trim();
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sessionSecret = (process.env.CARDANO_MULTISIG_SESSION_SECRET || process.env.CARDANO_MULTISIG_ACCOUNT_SECRET || "").trim();
const dataSecret = (process.env.CARDANO_MULTISIG_DATA_ENCRYPTION_SECRET || sessionSecret).trim();
if (!sessionSecret || !dataSecret) {
  console.error("Server session and data encryption secrets are required.");
  process.exit(1);
}
if ((process.env.NODE_ENV || "").trim().toLowerCase() === "production" && Buffer.byteLength(dataSecret, "utf8") < 32) {
  console.error("The data encryption secret must be at least 32 bytes in production.");
  process.exit(1);
}

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

function containsCustodialSecret(value, depth = 0) {
  if (depth > 30) return true;
  if (typeof value === "string") return /^xprv/i.test(value.trim());
  if (Array.isArray(value)) return value.some((item) => containsCustodialSecret(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const populated = child !== null && child !== undefined && child !== "";
    return (populated && SENSITIVE_KEYS.has(normalized)) || containsCustodialSecret(child, depth + 1);
  });
}

function encryptWitness(value) {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(`${sessionSecret}:witnesses`).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

function encryptCapabilities(value) {
  const purpose = "account-relay-capabilities";
  const iv = randomBytes(12);
  const key = createHash("sha256").update(`${dataSecret}:${purpose}:v1`).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return `sec1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

const pool = new pg.Pool({ connectionString: databaseUrl, application_name: "cardano-multisig-sensitive-state-hardening" });
const client = await pool.connect();
let transactionCount = 0;
let witnessCount = 0;
let capabilityCount = 0;

try {
  await client.query("begin");
  const wallets = await client.query(`select network, subject, wallet_id, wallet_json from cm_account_wallets for update`);
  for (const row of wallets.rows) {
    if (containsCustodialSecret(row.wallet_json)) {
      throw new Error(`Refusing to continue: wallet ${row.wallet_id} contains custodial key material.`);
    }
  }

  const transactions = await client.query(`select network, subject, tx_id, tx_json from cm_account_transactions for update`);
  for (const row of transactions.rows) {
    const tx = row.tx_json && typeof row.tx_json === "object" ? structuredClone(row.tx_json) : {};
    if (containsCustodialSecret(tx)) {
      throw new Error(`Refusing to continue: transaction ${row.tx_id} contains custodial key material.`);
    }
    let changed = false;
    if (Array.isArray(tx.signatures)) {
      tx.signatures = tx.signatures.map((signature) => {
        if (!signature || typeof signature !== "object" || !signature.witnessCbor || signature.witnessCiphertext) return signature;
        const { witnessCbor, ...rest } = signature;
        witnessCount += 1;
        changed = true;
        return { ...rest, witnessCiphertext: encryptWitness(String(witnessCbor)) };
      });
    }
    if (tx.relayRoom && typeof tx.relayRoom === "object" && !tx.relayRoom.capabilityCiphertext) {
      const { coordinatorToken, sharedInviteUrl, signerInvites, ...publicRef } = tx.relayRoom;
      const capabilities = {
        ...(coordinatorToken ? { coordinatorToken } : {}),
        ...(sharedInviteUrl ? { sharedInviteUrl } : {}),
        ...(Array.isArray(signerInvites) && signerInvites.length ? { signerInvites } : {}),
      };
      if (Object.keys(capabilities).length) {
        tx.relayRoom = { ...publicRef, capabilityCiphertext: encryptCapabilities(capabilities) };
        capabilityCount += 1;
        changed = true;
      }
    }
    if (!changed) continue;
    await client.query(
      `update cm_account_transactions set tx_json = $4::jsonb
       where network = $1 and subject = $2 and tx_id = $3`,
      [row.network, row.subject, row.tx_id, JSON.stringify(tx)],
    );
    transactionCount += 1;
  }
  await client.query("commit");
  console.log(JSON.stringify({ ok: true, transactionCount, witnessCount, capabilityCount }));
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
