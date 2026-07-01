import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MultisigWallet, Network, SignatureRecord, TxDraft } from "../multisig";

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

type StoredTxDraft = Omit<TxDraft, "signatures"> & {
  signatures: StoredSignatureRecord[];
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

function nowIso() {
  return new Date().toISOString();
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

function networkFromEnv(): Network {
  const raw = (process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod").trim().toLowerCase();
  return raw === "mainnet" || raw === "preview" ? raw : "preprod";
}

function sessionSecret() {
  const value = (process.env.CARDANO_MULTISIG_SESSION_SECRET || process.env.CARDANO_MULTISIG_ACCOUNT_SECRET || "").trim();
  if (!value) {
    throw new Error("CARDANO_MULTISIG_SESSION_SECRET or CARDANO_MULTISIG_ACCOUNT_SECRET must be set for authenticated server accounts.");
  }
  return value;
}

function witnessEncryptionKey() {
  return createHash("sha256").update(`${sessionSecret()}:witnesses`).digest();
}

function signCookie(value: string) {
  return createHmac("sha256", sessionSecret()).update(value).digest("hex");
}

function serializeCookie(sessionId: string, expiresAt: string) {
  const value = `${sessionId}.${signCookie(sessionId)}`;
  return `${ACCOUNT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
}

export function clearSessionCookie() {
  return `${ACCOUNT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
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
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return sessionId;
}

function nonce() {
  return randomBytes(16).toString("hex");
}

function sessionId() {
  return randomBytes(24).toString("base64url");
}

function subjectId(identity: AccountIdentity) {
  return `${identity.kind}:${identity.keyHash}`;
}

function normalizeNetwork(value: string | null | undefined): Network {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

function ensureExpectedNetwork(network: string) {
  const requested = normalizeNetwork(network);
  const configured = networkFromEnv();
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

export function assertOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const current = new URL(request.url).origin;
  if (origin && origin !== current) {
    throw new Error(`Cross-origin request blocked for authenticated account API (${origin}).`);
  }
  return origin || current;
}

export function assertSessionMutationRequest(request: Request, session: AccountSession, csrfToken: string | null | undefined) {
  assertOrigin(request);
  if (!csrfToken || csrfToken !== session.csrfToken) {
    throw new Error("Missing or invalid CSRF token for authenticated account mutation.");
  }
}

function encryptWitness(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", witnessEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptWitness(value: string) {
  const bytes = Buffer.from(value, "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", witnessEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function sanitizeWallets(wallets: MultisigWallet[], network: Network) {
  return wallets.filter((wallet) => wallet.network === network).map((wallet) => ({ ...wallet }));
}

function sanitizeTransactions(transactions: TxDraft[], network: Network): StoredTxDraft[] {
  return transactions
    .filter((tx) => tx.network === network)
    .map((tx) => ({
      ...tx,
      relayRoom: tx.relayRoom ? { ...tx.relayRoom } : undefined,
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

function hydrateTransactions(transactions: StoredTxDraft[]): TxDraft[] {
  return transactions.map((tx) => ({
    ...tx,
    relayRoom: tx.relayRoom ? { ...tx.relayRoom } : undefined,
    assets: tx.assets?.map((asset) => ({ ...asset })),
    signatures: (tx.signatures || []).map((signature) => ({
      ...signature,
      witnessCbor: signature.witnessCiphertext ? decryptWitness(signature.witnessCiphertext) : signature.witnessCbor || "",
    })),
  }));
}

function mergeIdentities(current: AccountIdentity[], identity: AccountIdentity) {
  const existing = current.filter((item) => !(item.kind === identity.kind && item.keyHash === identity.keyHash));
  return [...existing, identity];
}

async function readAccount(network: Network, subject: string) {
  return readJson<StoredAccount>(accountPath(network, subject));
}

async function writeAccount(account: StoredAccount) {
  await writeJson(accountPath(account.network, account.subject), account);
}

export async function getOrCreateAccount(identity: AccountIdentity, network: Network) {
  const subject = subjectId(identity);
  const existing = await readAccount(network, subject);
  if (existing) {
    const next: StoredAccount = {
      ...existing,
      identities: mergeIdentities(existing.identities || [], identity),
      updatedAt: nowIso(),
    };
    await writeAccount(next);
    return next;
  }
  const created: StoredAccount = {
    subject,
    network,
    identities: [identity],
    wallets: [],
    transactions: [],
    auditEvents: [auditEvent("account.created", { identityKind: identity.kind, keyHash: identity.keyHash })],
    createdAt: nowIso(),
    updatedAt: nowIso(),
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
  await writeJson(challengePath(challenge.id), challenge);
  return challenge;
}

export async function consumeChallenge(id: string) {
  const challenge = await readJson<StoredChallenge>(challengePath(id));
  if (!challenge) return null;
  await unlink(challengePath(id)).catch(() => undefined);
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
  await writeJson(sessionPath(session.id), session);
  const updatedAccount: StoredAccount = {
    ...account,
    identities: mergeIdentities(account.identities, identity),
    updatedAt: nowIso(),
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
  const session = await readJson<AccountSession>(sessionPath(id));
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) {
    await unlink(sessionPath(id)).catch(() => undefined);
    return null;
  }
  if (session.network !== networkFromEnv()) {
    throw new Error(`Authenticated session network ${session.network} does not match configured ${networkFromEnv()}.`);
  }
  return session;
}

export async function destroySession(request: Request) {
  const id = parseCookieHeader(request.headers.get("cookie"));
  if (id) await unlink(sessionPath(id)).catch(() => undefined);
  return clearSessionCookie();
}

export async function loadAccountSnapshot(session: AccountSession): Promise<AccountSnapshot> {
  const account = await readAccount(session.network, session.subject);
  if (!account) return { wallets: [], transactions: [] };
  return {
    wallets: sanitizeWallets(account.wallets || [], session.network),
    transactions: hydrateTransactions(account.transactions || []),
    updatedAt: account.updatedAt,
  };
}

export async function replaceAccountSnapshot(session: AccountSession, snapshot: AccountSnapshot, reason = "state.replace") {
  const current = (await readAccount(session.network, session.subject)) || (await getOrCreateAccount(session.identity, session.network));
  const next: StoredAccount = {
    ...current,
    identities: mergeIdentities(current.identities || [], session.identity),
    wallets: sanitizeWallets(snapshot.wallets || [], session.network),
    transactions: sanitizeTransactions(snapshot.transactions || [], session.network),
    updatedAt: nowIso(),
    auditEvents: [
      ...(current.auditEvents || []),
      auditEvent(reason, {
        walletCount: snapshot.wallets?.length || 0,
        transactionCount: snapshot.transactions?.length || 0,
      }),
    ].slice(-MAX_AUDIT_EVENTS),
  };
  await writeAccount(next);
  return {
    wallets: next.wallets,
    transactions: hydrateTransactions(next.transactions),
    updatedAt: next.updatedAt,
  } satisfies AccountSnapshot;
}

export async function importIntoAccount(session: AccountSession, snapshot: AccountSnapshot) {
  const current = await loadAccountSnapshot(session);
  const walletById = new Map<string, MultisigWallet>();
  for (const wallet of [...current.wallets, ...(snapshot.wallets || [])]) {
    walletById.set(wallet.id, wallet);
  }
  const txById = new Map<string, TxDraft>();
  for (const tx of [...current.transactions, ...(snapshot.transactions || [])]) {
    txById.set(tx.id, tx);
  }
  return replaceAccountSnapshot(
    session,
    { wallets: [...walletById.values()], transactions: [...txById.values()] },
    "state.import-local",
  );
}

export async function listAccountFiles() {
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
    network: networkFromEnv(),
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
