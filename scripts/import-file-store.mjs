import { readdir, readFile } from "node:fs/promises";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";
import { encryptWitness, isEncryptedWitness } from "./witness-crypto.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = (process.env.DATABASE_URL || "").trim();
const dataDir = path.resolve((process.env.CARDANO_MULTISIG_DATA_DIR || path.join(root, "data", "cardano-multisig")).trim());
const allowCrossNetworkImport = process.env.CARDANO_MULTISIG_IMPORT_ALL_NETWORKS === "1";
const configuredNetwork = normalizeNetwork(
  process.env.CARDANO_MULTISIG_IMPORT_NETWORK_OVERRIDE || process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod",
);

if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, application_name: "cardano-multisig-import-file-store" });

function normalizeNetwork(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

function importScopeError(foundNetwork, filePath) {
  const location = filePath ? ` (${filePath})` : "";
  return new Error(
    `Refusing to import ${foundNetwork} state${location} while target import network is ${configuredNetwork}. ` +
      `Set CARDANO_MULTISIG_IMPORT_NETWORK_OVERRIDE=${foundNetwork} to target that network, or CARDANO_MULTISIG_IMPORT_ALL_NETWORKS=1 for an intentional cross-network import.`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listNetworkDirectories(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function assertImportNetwork(network, filePath) {
  const normalized = normalizeNetwork(network);
  if (allowCrossNetworkImport || normalized === configuredNetwork) return normalized;
  throw importScopeError(normalized, filePath);
}

async function accountFiles() {
  const accountsRoot = path.join(dataDir, "accounts");
  const networkDirs = await listNetworkDirectories(accountsRoot);
  const files = [];
  for (const networkDir of networkDirs) {
    assertImportNetwork(networkDir, path.join(accountsRoot, networkDir));
    if (!allowCrossNetworkImport && networkDir !== configuredNetwork) continue;
    const dirPath = path.join(accountsRoot, networkDir);
    const children = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".json")) files.push(path.join(dirPath, child.name));
    }
  }
  return files;
}

async function roomFiles() {
  const rootDir = path.join(dataDir, "rooms");
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(rootDir, entry.name));
}

async function sessionFiles(kind) {
  const rootDir = path.join(dataDir, kind);
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(rootDir, entry.name));
}

async function loadScopedRecords(filePaths) {
  const records = [];
  for (const filePath of filePaths) {
    const record = await readJson(filePath);
    assertImportNetwork(record?.network, filePath);
    records.push({ filePath, record });
  }
  return records;
}

function sanitizeImportedSignature(signature) {
  const { witnessCbor, witnessCiphertext, ...rest } = signature || {};
  const normalizedWitnessCiphertext = typeof witnessCiphertext === "string" && witnessCiphertext.trim()
    ? witnessCiphertext
    : typeof witnessCbor === "string" && witnessCbor.trim()
      ? isEncryptedWitness(witnessCbor)
        ? witnessCbor
        : encryptWitness(witnessCbor)
      : undefined;
  return normalizedWitnessCiphertext
    ? { ...rest, witnessCiphertext: normalizedWitnessCiphertext }
    : { ...rest };
}

function encryptImportedCapabilities(value) {
  const purpose = "account-relay-capabilities";
  const secret = (
    process.env.CARDANO_MULTISIG_DATA_ENCRYPTION_SECRET ||
    process.env.CARDANO_MULTISIG_SESSION_SECRET ||
    process.env.CARDANO_MULTISIG_ACCOUNT_SECRET ||
    ""
  ).trim();
  if (!secret) throw new Error("A server encryption secret is required before importing relay capabilities.");
  const iv = randomBytes(12);
  const key = createHash("sha256").update(`${secret}:${purpose}:v1`).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return `sec1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

function sanitizeImportedRelayRoom(relayRoom) {
  if (!relayRoom || typeof relayRoom !== "object") return undefined;
  if (typeof relayRoom.capabilityCiphertext === "string" && relayRoom.capabilityCiphertext.startsWith("sec1:")) {
    return { ...relayRoom };
  }
  const { coordinatorToken, sharedInviteUrl, signerInvites, ...publicRef } = relayRoom;
  const capabilities = {
    ...(coordinatorToken ? { coordinatorToken } : {}),
    ...(sharedInviteUrl ? { sharedInviteUrl } : {}),
    ...(Array.isArray(signerInvites) && signerInvites.length ? { signerInvites } : {}),
  };
  return {
    ...publicRef,
    ...(Object.keys(capabilities).length ? { capabilityCiphertext: encryptImportedCapabilities(capabilities) } : {}),
  };
}

function sanitizeImportedTransaction(tx) {
  return {
    ...tx,
    relayRoom: sanitizeImportedRelayRoom(tx?.relayRoom),
    assets: Array.isArray(tx?.assets) ? tx.assets.map((asset) => ({ ...asset })) : tx?.assets,
    signatures: Array.isArray(tx?.signatures) ? tx.signatures.map(sanitizeImportedSignature) : [],
  };
}

const accountImports = await loadScopedRecords(await accountFiles());
const sessionImports = await loadScopedRecords(await sessionFiles("sessions"));
const challengeImports = await loadScopedRecords(await sessionFiles("challenges"));
const roomImports = await loadScopedRecords(await roomFiles());

const client = await pool.connect();
try {
  await client.query("begin");

  for (const { record: account } of accountImports) {
    await client.query(
      `insert into cm_accounts (network, subject, created_at, updated_at)
       values ($1, $2, $3::timestamptz, $4::timestamptz)
       on conflict (network, subject)
       do update set created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [account.network, account.subject, account.createdAt, account.updatedAt],
    );
    await client.query(`delete from cm_account_identities where network = $1 and subject = $2`, [account.network, account.subject]);
    await client.query(`delete from cm_account_wallets where network = $1 and subject = $2`, [account.network, account.subject]);
    await client.query(`delete from cm_account_transactions where network = $1 and subject = $2`, [account.network, account.subject]);
    await client.query(`delete from cm_account_audit_events where network = $1 and subject = $2`, [account.network, account.subject]);

    for (const identity of account.identities || []) {
      await client.query(
        `insert into cm_account_identities (network, subject, kind, key_hash, address_hex, created_at, last_authenticated_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [account.network, account.subject, identity.kind, identity.keyHash, identity.addressHex, identity.createdAt, identity.lastAuthenticatedAt],
      );
    }
    for (const wallet of account.wallets || []) {
      await client.query(
        `insert into cm_account_wallets (network, subject, wallet_id, wallet_json, updated_at)
         values ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [account.network, account.subject, wallet.id, JSON.stringify(wallet), wallet.updatedAt || account.updatedAt],
      );
    }
    for (const tx of account.transactions || []) {
      const sanitizedTx = sanitizeImportedTransaction(tx);
      await client.query(
        `insert into cm_account_transactions (network, subject, tx_id, tx_json, status, tx_hash, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz)`,
        [account.network, account.subject, sanitizedTx.id, JSON.stringify(sanitizedTx), sanitizedTx.status || null, sanitizedTx.txHash || null, sanitizedTx.updatedAt || account.updatedAt],
      );
    }
    for (const event of account.auditEvents || []) {
      await client.query(
        `insert into cm_account_audit_events (network, subject, id, event_type, created_at, details_json)
         values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)`,
        [account.network, account.subject, event.id, event.type, event.createdAt, JSON.stringify(event.details || null)],
      );
    }
  }

  for (const { record: session } of sessionImports) {
    await client.query(
      `insert into cm_account_sessions (id, network, subject, csrf_token, identity_kind, identity_key_hash, identity_address_hex, created_at, last_authenticated_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz)
       on conflict (id) do update set network = excluded.network, subject = excluded.subject, csrf_token = excluded.csrf_token,
       identity_kind = excluded.identity_kind, identity_key_hash = excluded.identity_key_hash, identity_address_hex = excluded.identity_address_hex,
       created_at = excluded.created_at, last_authenticated_at = excluded.last_authenticated_at, expires_at = excluded.expires_at`,
      [session.id, session.network, session.subject, session.csrfToken, session.identity.kind, session.identity.keyHash, session.identity.addressHex, session.createdAt, session.lastAuthenticatedAt, session.expiresAt],
    );
  }

  for (const { record: challenge } of challengeImports) {
    await client.query(
      `insert into cm_account_challenges (id, network, origin, subject, identity_kind, identity_key_hash, identity_address_hex, identity_created_at, identity_last_authenticated_at, payload_hex, nonce, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12::timestamptz, $13::timestamptz)
       on conflict (id) do update set network = excluded.network, origin = excluded.origin, subject = excluded.subject,
       identity_kind = excluded.identity_kind, identity_key_hash = excluded.identity_key_hash, identity_address_hex = excluded.identity_address_hex,
       identity_created_at = excluded.identity_created_at, identity_last_authenticated_at = excluded.identity_last_authenticated_at,
       payload_hex = excluded.payload_hex, nonce = excluded.nonce, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      [challenge.id, challenge.network, challenge.origin, challenge.subject, challenge.identity.kind, challenge.identity.keyHash, challenge.identity.addressHex, challenge.identity.createdAt, challenge.identity.lastAuthenticatedAt, challenge.payloadHex, challenge.nonce, challenge.createdAt, challenge.expiresAt],
    );
  }

  for (const { record: room } of roomImports) {
    await client.query(
      `insert into cm_relay_rooms (
        id, network, status, created_at, updated_at, expires_at, tx_json,
        coordinator_token_hash, coordinator_last_seen_at,
        shared_signer_token_hash, shared_signer_last_seen_at,
        submission_tx_hash, submission_submitted_at, submission_failure_error, submission_failure_failed_at
      ) values (
        $1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::jsonb,
        $8, $9::timestamptz, $10, $11::timestamptz, $12, $13::timestamptz, $14, $15::timestamptz
      ) on conflict (id) do update set
        network = excluded.network, status = excluded.status, created_at = excluded.created_at, updated_at = excluded.updated_at,
        expires_at = excluded.expires_at, tx_json = excluded.tx_json, coordinator_token_hash = excluded.coordinator_token_hash,
        coordinator_last_seen_at = excluded.coordinator_last_seen_at, shared_signer_token_hash = excluded.shared_signer_token_hash,
        shared_signer_last_seen_at = excluded.shared_signer_last_seen_at, submission_tx_hash = excluded.submission_tx_hash,
        submission_submitted_at = excluded.submission_submitted_at, submission_failure_error = excluded.submission_failure_error,
        submission_failure_failed_at = excluded.submission_failure_failed_at`,
      [room.id, room.network, room.status, room.createdAt, room.updatedAt, room.expiresAt, JSON.stringify(room.tx), room.coordinator.tokenHash, room.coordinator.lastSeenAt || null, room.sharedSigner?.tokenHash || null, room.sharedSigner?.lastSeenAt || null, room.submission?.txHash || null, room.submission?.submittedAt || null, room.submissionFailure?.error || null, room.submissionFailure?.failedAt || null],
    );
    await client.query(`delete from cm_relay_room_signers where room_id = $1`, [room.id]);
    await client.query(`delete from cm_relay_room_witnesses where room_id = $1`, [room.id]);
    for (const signer of room.signers || []) {
      await client.query(
        `insert into cm_relay_room_signers (room_id, key_hash, label, token_hash, created_at, last_seen_at, delivered_at)
         values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
        [room.id, signer.keyHash, signer.label || null, signer.tokenHash, signer.createdAt, signer.lastSeenAt || null, signer.deliveredAt || null],
      );
    }
    for (const witness of room.witnesses || []) {
      await client.query(
        `insert into cm_relay_room_witnesses (room_id, witness_id, source, signer_key_hash_claim, matched_signer_key_hash, witness_cbor, wallet_name, signer_name, signed_at, received_at, match_status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11)`,
        [room.id, witness.id, witness.source, witness.signerKeyHashClaim || null, witness.matchedSignerKeyHash || null, encryptWitness(witness.witnessCbor), witness.walletName || null, witness.signerName || null, witness.signedAt, witness.receivedAt, witness.matchStatus],
      );
    }
  }

  await client.query("commit");
  const scopeLabel = allowCrossNetworkImport ? "all allowed networks" : configuredNetwork;
  console.log(`Imported ${scopeLabel} file-backed state from ${dataDir}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
