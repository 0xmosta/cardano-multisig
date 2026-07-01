import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Pool } from "pg";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const databaseUrl = (process.env.DATABASE_URL || "").trim();
const dataDir = path.resolve((process.env.CARDANO_MULTISIG_DATA_DIR || path.join(root, "data", "cardano-multisig")).trim());

if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, application_name: "cardano-multisig-import-file-store" });

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function accountFiles() {
  const accountsRoot = path.join(dataDir, "accounts");
  const networks = await readdir(accountsRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of networks) {
    if (!entry.isDirectory()) continue;
    const networkDir = path.join(accountsRoot, entry.name);
    const children = await readdir(networkDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".json")) files.push(path.join(networkDir, child.name));
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

const client = await pool.connect();
try {
  await client.query("begin");

  for (const file of await accountFiles()) {
    const account = await readJson(file);
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
      await client.query(
        `insert into cm_account_transactions (network, subject, tx_id, tx_json, status, tx_hash, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz)`,
        [account.network, account.subject, tx.id, JSON.stringify(tx), tx.status || null, tx.txHash || null, tx.updatedAt || account.updatedAt],
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

  for (const file of await sessionFiles("sessions")) {
    const session = await readJson(file);
    await client.query(
      `insert into cm_account_sessions (id, network, subject, csrf_token, identity_kind, identity_key_hash, identity_address_hex, created_at, last_authenticated_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz)
       on conflict (id) do update set network = excluded.network, subject = excluded.subject, csrf_token = excluded.csrf_token,
       identity_kind = excluded.identity_kind, identity_key_hash = excluded.identity_key_hash, identity_address_hex = excluded.identity_address_hex,
       created_at = excluded.created_at, last_authenticated_at = excluded.last_authenticated_at, expires_at = excluded.expires_at`,
      [session.id, session.network, session.subject, session.csrfToken, session.identity.kind, session.identity.keyHash, session.identity.addressHex, session.createdAt, session.lastAuthenticatedAt, session.expiresAt],
    );
  }

  for (const file of await sessionFiles("challenges")) {
    const challenge = await readJson(file);
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

  for (const file of await roomFiles()) {
    const room = await readJson(file);
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
        [room.id, witness.id, witness.source, witness.signerKeyHashClaim || null, witness.matchedSignerKeyHash || null, witness.witnessCbor, witness.walletName || null, witness.signerName || null, witness.signedAt, witness.receivedAt, witness.matchStatus],
      );
    }
  }

  await client.query("commit");
  console.log(`Imported file-backed state from ${dataDir}`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
