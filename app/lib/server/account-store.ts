import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import type { MultisigWallet, Network, RelayRoomRef, SignatureRecord, TxDraft } from "../multisig";
import { normalizeKeyHash } from "../multisig";
import { sanitizeAccountSnapshotInput } from "./account-state-validation";
import {
  assertPersistenceMode,
  configuredNetwork,
  json,
  parseJson,
  postgresEnabled,
  withClient,
  withTransaction,
} from "./postgres";
import { decryptWitness, encryptWitness } from "./witness-crypto";
import { decryptSensitiveJson, encryptSensitiveJson, isSensitiveDataEnvelope } from "./sensitive-data";

type AccountIdentityKind = "payment" | "stake";

type AccountIdentity = {
  kind: AccountIdentityKind;
  keyHash: string;
  addressHex: string;
  createdAt: string;
  lastAuthenticatedAt: string;
};

export type AccountSession = {
  id: string;
  subject: string;
  network: Network;
  csrfToken: string;
  identity: AccountIdentity;
  createdAt: string;
  lastAuthenticatedAt: string;
  expiresAt: string;
};

type StoredChallenge = {
  id: string;
  network: Network;
  origin: string;
  subject: string;
  identity: AccountIdentity;
  payloadHex: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
};

type StoredAccount = {
  subject: string;
  network: Network;
  identities: AccountIdentity[];
  wallets: MultisigWallet[];
  transactions: StoredTxDraft[];
  auditEvents: AuditEvent[];
  createdAt: string;
  updatedAt: string;
};

type StoredRelayRoomRef = Omit<RelayRoomRef, "coordinatorToken" | "sharedInviteUrl" | "signerInvites"> & {
  capabilityCiphertext?: string;
  coordinatorToken?: string;
  sharedInviteUrl?: string;
  signerInvites?: RelayRoomRef["signerInvites"];
};

type StoredTxDraft = Omit<TxDraft, "signatures" | "relayRoom"> & {
  signatures: StoredSignatureRecord[];
  relayRoom?: StoredRelayRoomRef;
};

type StoredSignatureRecord = Omit<SignatureRecord, "witnessCbor"> & {
  witnessCbor?: string;
  witnessCiphertext?: string;
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: string;
  details?: Record<string, unknown>;
};

export type AccountSnapshot = {
  wallets: MultisigWallet[];
  transactions: TxDraft[];
  updatedAt?: string;
};

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ACCOUNT_COOKIE = "cardano_multisig_account_session";
const MAX_AUDIT_EVENTS = 200;
const RELAY_CAPABILITY_PURPOSE = "account-relay-capabilities";

export class AccountStateConflictError extends Error {
  constructor() {
    super("Server account state changed in another tab. Refresh before saving.");
    this.name = "AccountStateConflictError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function accountVersionIso(milliseconds = Date.now()) {
  return new Date(milliseconds).toISOString().replace(/(\.\d{3})Z$/, "$1000Z");
}

function accountVersionFromDatabase(value: Date | string) {
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(text)) return text;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Stored account version timestamp is invalid.");
  return accountVersionIso(milliseconds);
}

function dataDir() {
  return path.resolve((process.env.CARDANO_MULTISIG_DATA_DIR || "./data/cardano-multisig").trim());
}

function accountsDir() {
  return path.join(dataDir(), "accounts");
}

function accountPath(network: Network, subject: string) {
  return path.join(accountsDir(), network, `${subject}.json`);
}

function sessionsDir() {
  return path.join(dataDir(), "sessions");
}

function sessionPath(id: string) {
  return path.join(sessionsDir(), `${id}.json`);
}

function challengesDir() {
  return path.join(dataDir(), "challenges");
}

function challengePath(id: string) {
  return path.join(challengesDir(), `${id}.json`);
}

function auditEvent(type: string, details?: Record<string, unknown>): AuditEvent {
  return {
    id: randomBytes(8).toString("hex"),
    type,
    createdAt: nowIso(),
    details,
  };
}

function sessionSecret() {
  const value = (process.env.CARDANO_MULTISIG_SESSION_SECRET || process.env.CARDANO_MULTISIG_ACCOUNT_SECRET || "").trim();
  if (!value) {
    throw new Error("CARDANO_MULTISIG_SESSION_SECRET or CARDANO_MULTISIG_ACCOUNT_SECRET must be set for authenticated server accounts.");
  }
  return value;
}

function signCookie(value: string) {
  return createHmac("sha256", sessionSecret()).update(value).digest("hex");
}

function secureCookieAttribute() {
  if (process.env.CARDANO_MULTISIG_COOKIE_SECURE === "0") return "";
  const publicOrigin = normalizedOrigin(process.env.CARDANO_MULTISIG_PUBLIC_ORIGIN);
  if (publicOrigin) return publicOrigin.startsWith("https://") ? " Secure;" : "";
  return process.env.NODE_ENV === "production" ? " Secure;" : "";
}

function serializeCookie(sessionId: string, expiresAt: string) {
  const value = `${sessionId}.${signCookie(sessionId)}`;
  return `${ACCOUNT_COOKIE}=${value}; Path=/; HttpOnly;${secureCookieAttribute()} SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}

export function clearSessionCookie() {
  return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly;${secureCookieAttribute()} SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) return null;
  const entry = cookieHeader
    .split(/;\s*/)
    .map((part) => part.split("="))
    .find(([name]) => name === ACCOUNT_COOKIE);
  if (!entry) return null;
  const raw = entry.slice(1).join("=");
  const [sessionId, signature] = raw.split(".");
  if (!sessionId || !signature) return null;
  const expected = signCookie(sessionId);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return sessionId;
}

function sessionId() {
  return randomBytes(24).toString("base64url");
}

function subjectId(identity: AccountIdentity) {
  return `${identity.kind}:${identity.keyHash}`;
}

function ensureExpectedNetwork(network: string) {
  const requested = normalizeNetwork(network);
  const configured = configuredNetwork();
  if (requested !== configured) {
    throw new Error(`Authenticated account state targets ${requested}, but this deployment is configured for ${configured}.`);
  }
  if (configured === "mainnet" && process.env.CARDANO_MULTISIG_ENABLE_MAINNET_RELAY !== "1") {
    throw new Error("Mainnet authenticated account state is disabled unless CARDANO_MULTISIG_ENABLE_MAINNET_RELAY=1 is set.");
  }
  return configured;
}

async function ensureDir(filePath: string) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function writeJson(filePath: string, value: unknown) {
  await ensureDir(filePath);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalizedOrigin(value: string | null | undefined) {
  const input = (value || "").trim();
  if (!input) return null;
  try {
    return new URL(input).origin;
  } catch {
    return null;
  }
}

function forwardedOrigin(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!forwardedHost) return null;
  const rawProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const forwardedProto = rawProto === "http" || rawProto === "https" ? rawProto : "https";
  return normalizedOrigin(`${forwardedProto}://${forwardedHost}`);
}

function allowedAccountOrigins(request: Request) {
  const publicOrigin = normalizedOrigin(process.env.CARDANO_MULTISIG_PUBLIC_ORIGIN);
  const isProduction = (process.env.NODE_ENV || "").trim().toLowerCase() === "production";
  if (isProduction && !publicOrigin) {
    throw new Error("CARDANO_MULTISIG_PUBLIC_ORIGIN is required for authenticated account APIs in production.");
  }
  if (isProduction) return new Set([publicOrigin!]);
  return new Set(
    [
      normalizedOrigin(request.url),
      publicOrigin,
      publicOrigin ? null : forwardedOrigin(request),
    ].filter((origin): origin is string => Boolean(origin)),
  );
}

export function assertOrigin(request: Request) {
  const rawOrigin = request.headers.get("origin");
  const origin = normalizedOrigin(rawOrigin);
  if (rawOrigin && !origin) {
    throw new Error("Cross-origin request blocked for authenticated account API (invalid origin).");
  }
  const current = normalizedOrigin(request.url);
  const allowedOrigins = allowedAccountOrigins(request);
  if (origin && !allowedOrigins.has(origin)) {
    throw new Error(`Cross-origin request blocked for authenticated account API (${origin}).`);
  }
  return origin || normalizedOrigin(process.env.CARDANO_MULTISIG_PUBLIC_ORIGIN) || forwardedOrigin(request) || current || "http://localhost";
}

export function assertSessionMutationRequest(request: Request, session: AccountSession, csrfToken: string | null | undefined) {
  assertOrigin(request);
  if (!csrfToken || csrfToken !== session.csrfToken) {
    throw new Error("Missing or invalid CSRF token for authenticated account mutation.");
  }
}

function sanitizeWallets(wallets: MultisigWallet[], network: Network) {
  return wallets.filter((wallet) => wallet.network === network).map((wallet) => ({ ...wallet }));
}

function storeRelayRoom(relayRoom: RelayRoomRef | undefined): StoredRelayRoomRef | undefined {
  if (!relayRoom) return undefined;
  const { coordinatorToken, sharedInviteUrl, signerInvites, ...publicRef } = relayRoom;
  const capabilities = {
    ...(coordinatorToken ? { coordinatorToken } : {}),
    ...(sharedInviteUrl ? { sharedInviteUrl } : {}),
    ...(signerInvites?.length ? { signerInvites } : {}),
  };
  return {
    ...publicRef,
    ...(Object.keys(capabilities).length
      ? { capabilityCiphertext: encryptSensitiveJson(capabilities, RELAY_CAPABILITY_PURPOSE) }
      : {}),
  };
}

function hydrateRelayRoom(relayRoom: StoredRelayRoomRef | undefined): RelayRoomRef | undefined {
  if (!relayRoom) return undefined;
  const { capabilityCiphertext, coordinatorToken, sharedInviteUrl, signerInvites, ...publicRef } = relayRoom;
  const encryptedCapabilities = isSensitiveDataEnvelope(capabilityCiphertext)
    ? decryptSensitiveJson<Pick<RelayRoomRef, "coordinatorToken" | "sharedInviteUrl" | "signerInvites">>(
        capabilityCiphertext,
        RELAY_CAPABILITY_PURPOSE,
      )
    : {};
  return {
    ...publicRef,
    ...(coordinatorToken ? { coordinatorToken } : {}),
    ...(sharedInviteUrl ? { sharedInviteUrl } : {}),
    ...(signerInvites?.length ? { signerInvites } : {}),
    ...encryptedCapabilities,
  };
}

function sanitizeTransactions(transactions: TxDraft[], network: Network): StoredTxDraft[] {
  return transactions
    .filter((tx) => tx.network === network)
    .map((tx) => ({
      ...tx,
      relayRoom: storeRelayRoom(tx.relayRoom),
      assets: tx.assets?.map((asset) => ({ ...asset })),
      signatures: (tx.signatures || []).map((signature) => {
        const { witnessCbor, ...rest } = signature;
        return {
          ...rest,
          witnessCiphertext: witnessCbor ? encryptWitness(witnessCbor) : undefined,
        };
      }),
    }));
}

function recoveredWalletId(tx: TxDraft) {
  return tx.walletId || `wallet_recovered_${normalizeKeyHash(tx.walletName || tx.id).replace(/[^0-9a-f]/g, "").slice(0, 16) || tx.id}`;
}

function recoverWalletsFromTransactions(wallets: MultisigWallet[], transactions: TxDraft[], network: Network) {
  const walletById = new Map<string, MultisigWallet>();
  for (const wallet of sanitizeWallets(wallets || [], network)) {
    walletById.set(wallet.id, wallet);
  }
  for (const tx of transactions || []) {
    if (tx.network !== network) continue;
    const walletId = recoveredWalletId(tx);
    if (walletById.has(walletId)) continue;
    const signerKeyHashes = Array.from(new Set((tx.signerKeyHashes || []).map(normalizeKeyHash).filter(Boolean)));
    if (!signerKeyHashes.length) continue;
    walletById.set(walletId, {
      id: walletId,
      name: tx.walletName || "Recovered multisig wallet",
      network,
      threshold: Math.max(Number(tx.requiredSignatures || 1), 1),
      signers: signerKeyHashes.map((keyHash, index) => ({
        id: `recovered_signer_${index + 1}`,
        label: `Payment signer ${index + 1}`,
        keyHash,
        source: "payment",
      })),
      createdAt: tx.createdAt || nowIso(),
      imported: true,
      discovery: {
        kind: "address",
        source: "transaction-room-recovery",
      },
    });
  }
  return [...walletById.values()].sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
}

function hydrateTransactions(transactions: StoredTxDraft[]): TxDraft[] {
  return transactions.map((tx) => ({
    ...tx,
    relayRoom: hydrateRelayRoom(tx.relayRoom),
    assets: tx.assets?.map((asset) => ({ ...asset })),
    signatures: (tx.signatures || []).map((signature) => ({
      ...signature,
      witnessCbor: signature.witnessCiphertext ? decryptWitness(signature.witnessCiphertext) : signature.witnessCbor || "",
    })),
  }));
}

function migrateStoredTransactions(transactions: StoredTxDraft[]) {
  let changed = false;
  const migrated = transactions.map((tx) => {
    const signatures = (tx.signatures || []).map((signature) => {
      if (!signature.witnessCbor || signature.witnessCiphertext) return signature;
      const { witnessCbor, ...rest } = signature;
      changed = true;
      return { ...rest, witnessCiphertext: encryptWitness(witnessCbor) };
    });
    const relayRoom = tx.relayRoom;
    const hasPlaintextCapabilities = Boolean(
      relayRoom?.coordinatorToken || relayRoom?.sharedInviteUrl || relayRoom?.signerInvites?.length,
    );
    if (!hasPlaintextCapabilities) return { ...tx, signatures };
    changed = true;
    return {
      ...tx,
      signatures,
      relayRoom: storeRelayRoom(hydrateRelayRoom(relayRoom)),
    };
  });
  return { changed, transactions: migrated };
}

async function migrateAccountSensitiveState(account: StoredAccount) {
  const migrated = migrateStoredTransactions(account.transactions || []);
  if (!migrated.changed) return account;
  const next: StoredAccount = {
    ...account,
    transactions: migrated.transactions,
    updatedAt: accountVersionIso(Math.max(Date.now(), Date.parse(account.updatedAt) + 1)),
    auditEvents: [...(account.auditEvents || []), auditEvent("security.sensitive-state-encrypted")].slice(-MAX_AUDIT_EVENTS),
  };
  try {
    await writeAccount(next, account.updatedAt);
    return next;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("changed in another tab")) throw error;
    return (await readAccount(account.network, account.subject)) || account;
  }
}

function mergeIdentities(current: AccountIdentity[], identity: AccountIdentity) {
  const existing = current.filter((item) => !(item.kind === identity.kind && item.keyHash === identity.keyHash));
  return [...existing, identity];
}

function accountFromRows(args: {
  network: Network;
  subject: string;
  accountRow: { created_at: Date | string; updated_at: Date | string };
  identityRows: Array<{ kind: string; key_hash: string; address_hex: string; created_at: Date | string; last_authenticated_at: Date | string }>;
  walletRows: Array<{ wallet_json: unknown }>;
  transactionRows: Array<{ tx_json: unknown }>;
  auditRows: Array<{ id: string; event_type: string; created_at: Date | string; details_json: unknown }>;
}): StoredAccount {
  return {
    subject: args.subject,
    network: args.network,
    identities: args.identityRows.map((row) => ({
      kind: row.kind as AccountIdentityKind,
      keyHash: row.key_hash,
      addressHex: row.address_hex,
      createdAt: new Date(row.created_at).toISOString(),
      lastAuthenticatedAt: new Date(row.last_authenticated_at).toISOString(),
    })),
    wallets: args.walletRows.map((row) => parseJson<MultisigWallet>(row.wallet_json, {} as MultisigWallet)),
    transactions: args.transactionRows.map((row) => parseJson<StoredTxDraft>(row.tx_json, {} as StoredTxDraft)),
    auditEvents: args.auditRows.map((row) => ({
      id: row.id,
      type: row.event_type,
      createdAt: new Date(row.created_at).toISOString(),
      details: parseJson<Record<string, unknown> | undefined>(row.details_json, undefined),
    })),
    createdAt: new Date(args.accountRow.created_at).toISOString(),
    updatedAt: accountVersionFromDatabase(args.accountRow.updated_at),
  };
}

async function readAccountPostgres(network: Network, subject: string) {
  return withClient(async (client) => {
    const account = await client.query<{ created_at: Date | string; updated_at: Date | string }>(
      `select created_at,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
       from cm_accounts where network = $1 and subject = $2`,
      [network, subject],
    );
    if (!account.rowCount) return null;
    const identities = await client.query<{ kind: string; key_hash: string; address_hex: string; created_at: Date | string; last_authenticated_at: Date | string }>(
      `select kind, key_hash, address_hex, created_at, last_authenticated_at
       from cm_account_identities where network = $1 and subject = $2
       order by created_at asc`,
      [network, subject],
    );
    const wallets = await client.query<{ wallet_json: unknown }>(
      `select wallet_json from cm_account_wallets where network = $1 and subject = $2 order by updated_at asc`,
      [network, subject],
    );
    const transactions = await client.query<{ tx_json: unknown }>(
      `select tx_json from cm_account_transactions where network = $1 and subject = $2 order by updated_at asc`,
      [network, subject],
    );
    const auditEvents = await client.query<{ id: string; event_type: string; created_at: Date | string; details_json: unknown }>(
      `select id, event_type, created_at, details_json from cm_account_audit_events
       where network = $1 and subject = $2 order by created_at asc`,
      [network, subject],
    );
    return accountFromRows({
      network,
      subject,
      accountRow: account.rows[0],
      identityRows: identities.rows,
      walletRows: wallets.rows,
      transactionRows: transactions.rows,
      auditRows: auditEvents.rows,
    });
  });
}

async function writeAccountPostgres(account: StoredAccount, expectedUpdatedAt?: string) {
  await withTransaction(async (client) => {
    if (expectedUpdatedAt) {
      const updated = await client.query(
        `update cm_accounts
         set created_at = $3::timestamptz, updated_at = $4::timestamptz
         where network = $1 and subject = $2 and updated_at = $5::timestamptz`,
        [account.network, account.subject, account.createdAt, account.updatedAt, expectedUpdatedAt],
      );
      if (updated.rowCount !== 1) {
        throw new AccountStateConflictError();
      }
    } else {
      await client.query(
        `insert into cm_accounts (network, subject, created_at, updated_at)
         values ($1, $2, $3::timestamptz, $4::timestamptz)
         on conflict (network, subject)
         do update set created_at = excluded.created_at, updated_at = excluded.updated_at`,
        [account.network, account.subject, account.createdAt, account.updatedAt],
      );
    }

    await client.query(`delete from cm_account_identities where network = $1 and subject = $2`, [account.network, account.subject]);
    for (const identity of account.identities) {
      await client.query(
        `insert into cm_account_identities (
          network, subject, kind, key_hash, address_hex, created_at, last_authenticated_at
        ) values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
        [
          account.network,
          account.subject,
          identity.kind,
          identity.keyHash,
          identity.addressHex,
          identity.createdAt,
          identity.lastAuthenticatedAt,
        ],
      );
    }

    await client.query(`delete from cm_account_wallets where network = $1 and subject = $2`, [account.network, account.subject]);
    for (const wallet of account.wallets) {
      await client.query(
        `insert into cm_account_wallets (network, subject, wallet_id, wallet_json, updated_at)
         values ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [account.network, account.subject, wallet.id, json(wallet), account.updatedAt],
      );
    }

    await client.query(`delete from cm_account_transactions where network = $1 and subject = $2`, [account.network, account.subject]);
    for (const tx of account.transactions) {
      const updatedAt = typeof tx.updatedAt === "string" && tx.updatedAt.trim() ? tx.updatedAt : account.updatedAt;
      await client.query(
        `insert into cm_account_transactions (network, subject, tx_id, tx_json, status, tx_hash, updated_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamptz)`,
        [account.network, account.subject, tx.id, json(tx), tx.status || null, tx.txHash || null, updatedAt],
      );
    }

    await client.query(`delete from cm_account_audit_events where network = $1 and subject = $2`, [account.network, account.subject]);
    for (const event of account.auditEvents.slice(-MAX_AUDIT_EVENTS)) {
      await client.query(
        `insert into cm_account_audit_events (network, subject, id, event_type, created_at, details_json)
         values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)`,
        [account.network, account.subject, event.id, event.type, event.createdAt, json(event.details || null)],
      );
    }
  });
}

async function readAccount(network: Network, subject: string) {
  if (postgresEnabled()) return readAccountPostgres(network, subject);
  return readJson<StoredAccount>(accountPath(network, subject));
}

async function writeAccount(account: StoredAccount, expectedUpdatedAt?: string) {
  assertPersistenceMode("Authenticated account persistence");
  if (postgresEnabled()) {
    await writeAccountPostgres(account, expectedUpdatedAt);
    return;
  }
  await writeJson(accountPath(account.network, account.subject), account);
}

async function writeSessionFile(session: AccountSession) {
  await writeJson(sessionPath(session.id), session);
}

async function readSessionFile(id: string) {
  return readJson<AccountSession>(sessionPath(id));
}

async function deleteSessionFile(id: string) {
  await unlink(sessionPath(id)).catch(() => undefined);
}

async function writeSessionPostgres(session: AccountSession) {
  await withTransaction(async (client) => {
    await client.query(
      `insert into cm_account_sessions (
        id, network, subject, csrf_token, identity_kind, identity_key_hash, identity_address_hex,
        created_at, last_authenticated_at, expires_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz)
      on conflict (id) do update set
        network = excluded.network,
        subject = excluded.subject,
        csrf_token = excluded.csrf_token,
        identity_kind = excluded.identity_kind,
        identity_key_hash = excluded.identity_key_hash,
        identity_address_hex = excluded.identity_address_hex,
        created_at = excluded.created_at,
        last_authenticated_at = excluded.last_authenticated_at,
        expires_at = excluded.expires_at`,
      [
        session.id,
        session.network,
        session.subject,
        session.csrfToken,
        session.identity.kind,
        session.identity.keyHash,
        session.identity.addressHex,
        session.createdAt,
        session.lastAuthenticatedAt,
        session.expiresAt,
      ],
    );
  });
}

async function readSessionPostgres(id: string) {
  const result = await withClient((client) =>
    client.query<{
      id: string;
      network: string;
      subject: string;
      csrf_token: string;
      identity_kind: AccountIdentityKind;
      identity_key_hash: string;
      identity_address_hex: string;
      created_at: Date | string;
      last_authenticated_at: Date | string;
      expires_at: Date | string;
    }>(
      `select id, network, subject, csrf_token, identity_kind, identity_key_hash, identity_address_hex,
              created_at, last_authenticated_at, expires_at
       from cm_account_sessions where id = $1`,
      [id],
    ),
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    subject: row.subject,
    network: normalizeNetwork(row.network),
    csrfToken: row.csrf_token,
    identity: {
      kind: row.identity_kind,
      keyHash: row.identity_key_hash,
      addressHex: row.identity_address_hex,
      createdAt: new Date(row.created_at).toISOString(),
      lastAuthenticatedAt: new Date(row.last_authenticated_at).toISOString(),
    },
    createdAt: new Date(row.created_at).toISOString(),
    lastAuthenticatedAt: new Date(row.last_authenticated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  } satisfies AccountSession;
}

async function deleteSessionPostgres(id: string) {
  await withClient((client) => client.query(`delete from cm_account_sessions where id = $1`, [id]));
}

async function writeChallengeFile(challenge: StoredChallenge) {
  await writeJson(challengePath(challenge.id), challenge);
}

async function readChallengeFile(id: string) {
  return readJson<StoredChallenge>(challengePath(id));
}

async function deleteChallengeFile(id: string) {
  await unlink(challengePath(id)).catch(() => undefined);
}

async function writeChallengePostgres(challenge: StoredChallenge) {
  await withClient((client) =>
    client.query(
      `insert into cm_account_challenges (
        id, network, origin, subject, identity_kind, identity_key_hash, identity_address_hex,
        identity_created_at, identity_last_authenticated_at, payload_hex, nonce, created_at, expires_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12::timestamptz, $13::timestamptz)
      on conflict (id) do update set
        network = excluded.network,
        origin = excluded.origin,
        subject = excluded.subject,
        identity_kind = excluded.identity_kind,
        identity_key_hash = excluded.identity_key_hash,
        identity_address_hex = excluded.identity_address_hex,
        identity_created_at = excluded.identity_created_at,
        identity_last_authenticated_at = excluded.identity_last_authenticated_at,
        payload_hex = excluded.payload_hex,
        nonce = excluded.nonce,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at`,
      [
        challenge.id,
        challenge.network,
        challenge.origin,
        challenge.subject,
        challenge.identity.kind,
        challenge.identity.keyHash,
        challenge.identity.addressHex,
        challenge.identity.createdAt,
        challenge.identity.lastAuthenticatedAt,
        challenge.payloadHex,
        challenge.nonce,
        challenge.createdAt,
        challenge.expiresAt,
      ],
    ),
  );
}

async function readChallengePostgres(id: string) {
  const result = await withClient((client) =>
    client.query<{
      id: string;
      network: string;
      origin: string;
      subject: string;
      identity_kind: AccountIdentityKind;
      identity_key_hash: string;
      identity_address_hex: string;
      identity_created_at: Date | string;
      identity_last_authenticated_at: Date | string;
      payload_hex: string;
      nonce: string;
      created_at: Date | string;
      expires_at: Date | string;
    }>(
      `select * from cm_account_challenges where id = $1`,
      [id],
    ),
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    network: normalizeNetwork(row.network),
    origin: row.origin,
    subject: row.subject,
    identity: {
      kind: row.identity_kind,
      keyHash: row.identity_key_hash,
      addressHex: row.identity_address_hex,
      createdAt: new Date(row.identity_created_at).toISOString(),
      lastAuthenticatedAt: new Date(row.identity_last_authenticated_at).toISOString(),
    },
    payloadHex: row.payload_hex,
    nonce: row.nonce,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  } satisfies StoredChallenge;
}

async function deleteChallengePostgres(id: string) {
  await withClient((client) => client.query(`delete from cm_account_challenges where id = $1`, [id]));
}

async function cleanupExpiredRows(client: PoolClient) {
  await client.query(`delete from cm_account_sessions where expires_at < now()`);
  await client.query(`delete from cm_account_challenges where expires_at < now()`);
}

export async function getOrCreateAccount(identity: AccountIdentity, network: Network) {
  const subject = subjectId(identity);
  const existing = await readAccount(network, subject);
  if (existing) {
    const next: StoredAccount = {
      ...existing,
      identities: mergeIdentities(existing.identities || [], identity),
      updatedAt: accountVersionIso(),
    };
    await writeAccount(next);
    return next;
  }
  const createdAt = nowIso();
  const created: StoredAccount = {
    subject,
    network,
    identities: [identity],
    wallets: [],
    transactions: [],
    auditEvents: [auditEvent("account.created", { identityKind: identity.kind, keyHash: identity.keyHash })],
    createdAt,
    updatedAt: createdAt,
  };
  await writeAccount(created);
  return created;
}

export async function storeChallenge(input: { network: string; origin: string; identity: AccountIdentity; payloadHex: string; nonce: string }) {
  const network = ensureExpectedNetwork(input.network);
  const challenge: StoredChallenge = {
    id: sessionId(),
    network,
    origin: input.origin,
    subject: subjectId(input.identity),
    identity: input.identity,
    payloadHex: input.payloadHex.toLowerCase(),
    nonce: input.nonce,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  };
  assertPersistenceMode("Authenticated account challenge persistence");
  if (postgresEnabled()) {
    await writeChallengePostgres(challenge);
  } else {
    await writeChallengeFile(challenge);
  }
  return challenge;
}

export async function consumeChallenge(id: string) {
  const challenge = postgresEnabled() ? await readChallengePostgres(id) : await readChallengeFile(id);
  if (!challenge) return null;
  if (postgresEnabled()) {
    await deleteChallengePostgres(id);
  } else {
    await deleteChallengeFile(id);
  }
  if (Date.parse(challenge.expiresAt) < Date.now()) {
    throw new Error("Wallet auth challenge expired. Request a fresh challenge and sign again.");
  }
  return challenge;
}

export async function createSession(identity: AccountIdentity, network: string) {
  const resolvedNetwork = ensureExpectedNetwork(network);
  const account = await getOrCreateAccount(identity, resolvedNetwork);
  const session: AccountSession = {
    id: sessionId(),
    subject: account.subject,
    network: resolvedNetwork,
    csrfToken: sessionId(),
    identity,
    createdAt: nowIso(),
    lastAuthenticatedAt: identity.lastAuthenticatedAt,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  assertPersistenceMode("Authenticated account session persistence");
  if (postgresEnabled()) {
    await withTransaction(async (client) => {
      await cleanupExpiredRows(client);
      await writeSessionPostgres(session);
    });
  } else {
    await writeSessionFile(session);
  }
  const updatedAccount: StoredAccount = {
    ...account,
    identities: mergeIdentities(account.identities, identity),
    updatedAt: accountVersionIso(Math.max(Date.now(), Date.parse(account.updatedAt) + 1)),
    auditEvents: [...(account.auditEvents || []), auditEvent("auth.session.created", { identityKind: identity.kind, keyHash: identity.keyHash })].slice(-MAX_AUDIT_EVENTS),
  };
  await writeAccount(updatedAccount);
  return {
    session,
    cookie: serializeCookie(session.id, session.expiresAt),
  };
}

export async function loadSession(request: Request) {
  const id = parseCookieHeader(request.headers.get("cookie"));
  if (!id) return null;
  const session = postgresEnabled() ? await readSessionPostgres(id) : await readSessionFile(id);
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) {
    if (postgresEnabled()) await deleteSessionPostgres(id);
    else await deleteSessionFile(id);
    return null;
  }
  if (session.network !== configuredNetwork()) {
    throw new Error(`Authenticated session network ${session.network} does not match configured ${configuredNetwork()}.`);
  }
  return session;
}

export async function destroySession(request: Request) {
  const id = parseCookieHeader(request.headers.get("cookie"));
  if (id) {
    if (postgresEnabled()) await deleteSessionPostgres(id);
    else await deleteSessionFile(id);
  }
  return clearSessionCookie();
}

export async function loadAccountSnapshot(session: AccountSession): Promise<AccountSnapshot> {
  const stored = await readAccount(session.network, session.subject);
  const account = stored ? await migrateAccountSensitiveState(stored) : null;
  if (!account) return { wallets: [], transactions: [] };
  const transactions = hydrateTransactions(account.transactions || []);
  return {
    wallets: recoverWalletsFromTransactions(account.wallets || [], transactions, session.network),
    transactions,
    updatedAt: account.updatedAt,
  };
}

export async function replaceAccountSnapshot(
  session: AccountSession,
  snapshot: AccountSnapshot,
  reason = "state.replace",
  expectedUpdatedAt?: string,
) {
  const current = (await readAccount(session.network, session.subject)) || (await getOrCreateAccount(session.identity, session.network));
  if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
    throw new AccountStateConflictError();
  }
  const sanitized = sanitizeAccountSnapshotInput(snapshot, session.network);
  const transactions = sanitizeTransactions(sanitized.transactions, session.network);
  const recoveredWallets = recoverWalletsFromTransactions(sanitized.wallets, hydrateTransactions(transactions), session.network);
  const next: StoredAccount = {
    ...current,
    identities: mergeIdentities(current.identities || [], session.identity),
    wallets: recoveredWallets,
    transactions,
    updatedAt: accountVersionIso(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)),
    auditEvents: [
      ...(current.auditEvents || []),
      auditEvent(reason, {
        walletCount: snapshot.wallets?.length || 0,
        transactionCount: snapshot.transactions?.length || 0,
      }),
    ].slice(-MAX_AUDIT_EVENTS),
  };
  await writeAccount(next, expectedUpdatedAt);
  return {
    wallets: next.wallets,
    transactions: hydrateTransactions(next.transactions),
    updatedAt: next.updatedAt,
  } satisfies AccountSnapshot;
}

export async function listAccountFiles() {
  if (postgresEnabled()) {
    const result = await withClient((client) => client.query<{ network: string }>(`select distinct network from cm_accounts order by network asc`));
    return result.rows.map((row) => row.network);
  }
  const root = accountsDir();
  try {
    const networks = await readdir(root, { withFileTypes: true });
    return networks.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function accountSessionResponse(session: AccountSession | null, snapshot?: AccountSnapshot) {
  return {
    authenticated: Boolean(session),
    network: configuredNetwork(),
    session: session
      ? {
          subject: session.subject,
          csrfToken: session.csrfToken,
          identity: session.identity,
          walletCount: snapshot?.wallets.length || 0,
          transactionCount: snapshot?.transactions.length || 0,
        }
      : null,
  };
}

export function createIdentity(args: { kind: AccountIdentityKind; keyHash: string; addressHex: string }): AccountIdentity {
  const timestamp = nowIso();
  return {
    kind: args.kind,
    keyHash: args.keyHash.toLowerCase(),
    addressHex: args.addressHex.toLowerCase(),
    createdAt: timestamp,
    lastAuthenticatedAt: timestamp,
  };
}

export function challengePayload(input: { origin: string; network: string; identity: AccountIdentity; nonce: string }) {
  const network = ensureExpectedNetwork(input.network);
  return {
    type: "cardano-multisig-account-auth",
    version: 1,
    origin: input.origin,
    network,
    subject: subjectId(input.identity),
    identityKind: input.identity.kind,
    keyHash: input.identity.keyHash,
    addressHex: input.identity.addressHex,
    nonce: input.nonce,
    issuedAt: nowIso(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
  };
}

function normalizeNetwork(value: string | null | undefined): Network {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}
