import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Network,
  isKeyHash,
  isRecord,
  normalizeKeyHash,
} from "../multisig";
import {
  type RelayRoomCoordinatorView,
  type RelayRoomProgress,
  type RelayRoomSignerRecord,
  type RelayRoomSignerView,
  type RelayRoomStatus,
  type RelayRoomSubmission,
  type RelayRoomTx,
  type RelayRoomWitnessRecord,
} from "../relay-room";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const roomLocks = new Map<string, Promise<void>>();

type RelayRoomCoordinator = {
  tokenHash: string;
  lastSeenAt?: string;
};

type RelayRoomStoredSigner = RelayRoomSignerRecord & {
  tokenHash: string;
};

export type RelayRoomRecord = {
  id: string;
  network: Network;
  status: RelayRoomStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  tx: RelayRoomTx;
  coordinator: RelayRoomCoordinator;
  signers: RelayRoomStoredSigner[];
  witnesses: RelayRoomWitnessRecord[];
  submission?: RelayRoomSubmission;
};

export type RelayRoomTokenSession =
  | { role: "coordinator"; room: RelayRoomRecord }
  | { role: "signer"; room: RelayRoomRecord; signer: RelayRoomStoredSigner };

function nowIso() {
  return new Date().toISOString();
}

function relayDataDir() {
  const configured = (process.env.CARDANO_MULTISIG_DATA_DIR || "./data/cardano-multisig").trim();
  return path.resolve(configured);
}

function roomsDir() {
  return path.join(relayDataDir(), "rooms");
}

function roomPath(roomId: string) {
  return path.join(roomsDir(), `${roomId}.json`);
}

function roomId() {
  return randomBytes(16).toString("base64url");
}

function capabilityToken() {
  return randomBytes(32).toString("base64url");
}

export function hashRelayToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeNetwork(value: string | null | undefined): Network {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

export function configuredNetwork() {
  return normalizeNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
}

function relayTtlMs() {
  const raw = Number.parseInt(String(process.env.CARDANO_MULTISIG_RELAY_TTL_MS || ""), 10);
  return Number.isFinite(raw) && raw > 60_000 ? raw : DEFAULT_TTL_MS;
}

function assertString(value: unknown, field: string) {
  const next = String(value || "").trim();
  if (!next) throw new Error(`${field} is required.`);
  return next;
}

function assertOptionalString(value: unknown) {
  const next = String(value || "").trim();
  return next || undefined;
}

function assertAssetLine(raw: unknown) {
  if (!isRecord(raw)) throw new Error("Invalid relay room asset.");
  return {
    id: assertString(raw.id, "asset.id"),
    unit: assertString(raw.unit, "asset.unit"),
    label: assertString(raw.label, "asset.label"),
    quantity: assertString(raw.quantity, "asset.quantity"),
    maxQuantity: assertOptionalString(raw.maxQuantity),
    decimals: typeof raw.decimals === "number" ? raw.decimals : undefined,
  };
}

function normalizeSignerKeyHashes(values: unknown[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const keyHash = normalizeKeyHash(String(value || ""));
    if (!isKeyHash(keyHash) || seen.has(keyHash)) continue;
    seen.add(keyHash);
    next.push(keyHash);
  }
  return next;
}

function assertRelayRoomTx(raw: unknown): RelayRoomTx {
  if (!isRecord(raw)) throw new Error("draft is required.");
  const signerKeyHashes = normalizeSignerKeyHashes(Array.isArray(raw.signerKeyHashes) ? raw.signerKeyHashes : []);
  const requiredSignatures = Math.max(1, Number(raw.requiredSignatures || 1));
  const unsignedTxCbor = assertString(raw.unsignedTxCbor, "draft.unsignedTxCbor").toLowerCase();
  if (!/^[0-9a-f]+$/i.test(unsignedTxCbor) || unsignedTxCbor.length % 2 !== 0) {
    throw new Error("draft.unsignedTxCbor must be hex-encoded transaction CBOR.");
  }
  if (!signerKeyHashes.length) throw new Error("draft.signerKeyHashes must contain at least one valid signer key hash.");
  if (requiredSignatures > signerKeyHashes.length) throw new Error("draft.requiredSignatures cannot exceed signerKeyHashes length.");
  return {
    draftId: assertString(raw.draftId ?? raw.id, "draft.id"),
    walletId: assertOptionalString(raw.walletId),
    walletName: assertString(raw.walletName, "draft.walletName"),
    title: assertString(raw.title, "draft.title"),
    note: String(raw.note || ""),
    recipient: assertString(raw.recipient, "draft.recipient"),
    lovelace: assertString(raw.lovelace, "draft.lovelace"),
    assets: Array.isArray(raw.assets) ? raw.assets.map(assertAssetLine) : [],
    unsignedTxCbor,
    requiredSignatures,
    signerKeyHashes,
  };
}

function assertRelaySigners(raw: unknown, tx: RelayRoomTx) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("signers must list each policy signer invite.");
  const labelByKeyHash = new Map<string, string | undefined>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const keyHash = normalizeKeyHash(String(item.keyHash || ""));
    if (!isKeyHash(keyHash)) continue;
    if (!tx.signerKeyHashes.includes(keyHash)) continue;
    if (!labelByKeyHash.has(keyHash)) {
      labelByKeyHash.set(keyHash, assertOptionalString(item.label));
    }
  }
  const signers = tx.signerKeyHashes.map((keyHash) => ({ keyHash, label: labelByKeyHash.get(keyHash) }));
  if (signers.length !== tx.signerKeyHashes.length) throw new Error("signers must cover every policy signer key hash exactly once.");
  return signers;
}

function assertRelayRoomRecord(raw: unknown): RelayRoomRecord {
  if (!isRecord(raw)) throw new Error("Invalid relay room record.");
  const status = raw.status === "submitted" || raw.status === "cancelled" || raw.status === "expired" ? raw.status : "open";
  const tx = assertRelayRoomTx(raw.tx);
  if (!isRecord(raw.coordinator) || typeof raw.coordinator.tokenHash !== "string") {
    throw new Error("Invalid relay room coordinator record.");
  }
  const signers = Array.isArray(raw.signers)
    ? raw.signers.map((item) => {
        if (!isRecord(item)) throw new Error("Invalid relay signer record.");
        const keyHash = normalizeKeyHash(assertString(item.keyHash, "signer.keyHash"));
        if (!isKeyHash(keyHash)) throw new Error("Invalid relay signer key hash.");
        return {
          keyHash,
          label: assertOptionalString(item.label),
          tokenHash: assertString(item.tokenHash, "signer.tokenHash"),
          createdAt: assertString(item.createdAt, "signer.createdAt"),
          lastSeenAt: assertOptionalString(item.lastSeenAt),
          deliveredAt: assertOptionalString(item.deliveredAt),
        };
      })
    : [];
  const witnesses = Array.isArray(raw.witnesses)
    ? raw.witnesses.map((item) => {
        if (!isRecord(item)) throw new Error("Invalid relay witness record.");
        return {
          id: assertString(item.id, "witness.id"),
          source: item.source === "manual" ? "manual" : "relay",
          signerKeyHashClaim: assertOptionalString(item.signerKeyHashClaim),
          matchedSignerKeyHash: assertOptionalString(item.matchedSignerKeyHash),
          witnessCbor: assertString(item.witnessCbor, "witness.witnessCbor"),
          walletName: assertOptionalString(item.walletName),
          signerName: assertOptionalString(item.signerName),
          signedAt: assertString(item.signedAt, "witness.signedAt"),
          receivedAt: assertString(item.receivedAt, "witness.receivedAt"),
          matchStatus: item.matchStatus === "unmatched" ? "unmatched" : "matched",
        } satisfies RelayRoomWitnessRecord;
      })
    : [];
  return {
    id: assertString(raw.id, "room.id"),
    network: normalizeNetwork(assertString(raw.network, "room.network")),
    status,
    createdAt: assertString(raw.createdAt, "room.createdAt"),
    updatedAt: assertString(raw.updatedAt, "room.updatedAt"),
    expiresAt: assertString(raw.expiresAt, "room.expiresAt"),
    tx,
    coordinator: {
      tokenHash: assertString(raw.coordinator.tokenHash, "coordinator.tokenHash"),
      lastSeenAt: assertOptionalString(raw.coordinator.lastSeenAt),
    },
    signers,
    witnesses,
    submission: isRecord(raw.submission)
      ? {
          txHash: assertString(raw.submission.txHash, "submission.txHash"),
          submittedAt: assertString(raw.submission.submittedAt, "submission.submittedAt"),
        }
      : undefined,
  };
}

async function ensureStore() {
  await mkdir(roomsDir(), { recursive: true, mode: 0o700 });
}

async function atomicWriteJson(filePath: string, value: unknown) {
  await ensureStore();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}

async function withRoomLock<T>(roomIdValue: string, action: () => Promise<T>) {
  const previous = roomLocks.get(roomIdValue) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => undefined).then(() => current);
  roomLocks.set(roomIdValue, chained);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (roomLocks.get(roomIdValue) === chained) {
      roomLocks.delete(roomIdValue);
    }
  }
}

export async function readRelayRoom(roomIdValue: string) {
  const raw = await readFile(roomPath(roomIdValue), "utf8");
  return assertRelayRoomRecord(JSON.parse(raw) as unknown);
}

export async function writeRelayRoom(room: RelayRoomRecord) {
  await atomicWriteJson(roomPath(room.id), room);
}

async function relayRoomFiles() {
  await ensureStore();
  const entries = await readdir(roomsDir(), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(roomsDir(), entry.name));
}

async function listRelayRooms() {
  const files = await relayRoomFiles();
  const rooms: RelayRoomRecord[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    rooms.push(assertRelayRoomRecord(JSON.parse(raw) as unknown));
  }
  return rooms;
}

export async function cleanupExpiredRelayRooms() {
  const rooms = await listRelayRooms();
  const now = Date.now();
  for (const room of rooms) {
    if (room.status !== "open") continue;
    if (Date.parse(room.expiresAt) > now) continue;
    await writeRelayRoom({
      ...room,
      status: "expired",
      updatedAt: nowIso(),
    });
  }
}

export async function createRelayRoom(input: {
  network: Network;
  tx: RelayRoomTx;
  signers: Array<{ keyHash: string; label?: string }>;
  witnesses?: RelayRoomWitnessRecord[];
}) {
  await cleanupExpiredRelayRooms();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + relayTtlMs()).toISOString();
  const coordinatorToken = capabilityToken();
  const signerTokens = input.signers.map((signer) => ({ ...signer, token: capabilityToken() }));
  const witnesses = "witnesses" in input && Array.isArray(input.witnesses) ? input.witnesses : [];
  const deliveredByKeyHash = new Map(
    witnesses
      .filter((witness) => witness.matchStatus === "matched" && witness.matchedSignerKeyHash)
      .map((witness) => [normalizeKeyHash(witness.matchedSignerKeyHash!), witness.receivedAt]),
  );
  const room: RelayRoomRecord = {
    id: roomId(),
    network: input.network,
    status: "open",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    tx: input.tx,
    coordinator: {
      tokenHash: hashRelayToken(coordinatorToken),
    },
    signers: signerTokens.map((signer) => ({
      keyHash: signer.keyHash,
      label: signer.label,
      tokenHash: hashRelayToken(signer.token),
      createdAt,
      deliveredAt: deliveredByKeyHash.get(signer.keyHash),
    })),
    witnesses,
  };
  await writeRelayRoom(room);
  return {
    room,
    coordinatorToken,
    signerTokens: signerTokens.map((signer) => ({ keyHash: signer.keyHash, label: signer.label, token: signer.token })),
  };
}

export async function resolveRelayTokenSession(token: string): Promise<RelayRoomTokenSession | null> {
  await cleanupExpiredRelayRooms();
  const tokenHash = hashRelayToken(token);
  const rooms = await listRelayRooms();
  for (const room of rooms) {
    if (room.coordinator.tokenHash === tokenHash) {
      return { role: "coordinator", room };
    }
    const signer = room.signers.find((item) => item.tokenHash === tokenHash);
    if (signer) {
      return { role: "signer", room, signer };
    }
  }
  return null;
}

export function relayProgress(room: RelayRoomRecord): RelayRoomProgress {
  const matched = new Set(
    room.witnesses
      .filter((witness) => witness.matchStatus === "matched" && witness.matchedSignerKeyHash)
      .map((witness) => normalizeKeyHash(witness.matchedSignerKeyHash!))
      .filter((keyHash) => room.tx.signerKeyHashes.includes(keyHash)),
  );
  const pending = room.tx.signerKeyHashes.filter((keyHash) => !matched.has(keyHash));
  const requiredSignatures = Math.max(1, room.tx.requiredSignatures || 1);
  return {
    matchedCount: Math.min(matched.size, requiredSignatures),
    requiredSignatures,
    pendingRequiredKeyHashes: pending.slice(0, Math.max(requiredSignatures - matched.size, 0)),
    optionalUnsignedKeyHashes: pending.slice(Math.max(requiredSignatures - matched.size, 0)),
  };
}

export function coordinatorRoomView(room: RelayRoomRecord): RelayRoomCoordinatorView {
  return {
    roomId: room.id,
    status: room.status,
    network: room.network,
    expiresAt: room.expiresAt,
    tx: room.tx,
    signers: room.signers.map(({ tokenHash: _tokenHash, ...signer }) => signer),
    witnesses: room.witnesses,
    submission: room.submission,
    progress: relayProgress(room),
  };
}

export function signerRoomView(room: RelayRoomRecord, signer: RelayRoomStoredSigner): RelayRoomSignerView {
  const progress = relayProgress(room);
  return {
    roomId: room.id,
    status: room.status,
    network: room.network,
    expiresAt: room.expiresAt,
    tx: room.tx,
    witnesses: room.witnesses,
    signer: {
      keyHash: signer.keyHash,
      label: signer.label,
      alreadyDelivered: room.witnesses.some(
        (witness) =>
          witness.matchStatus === "matched" &&
          witness.matchedSignerKeyHash &&
          normalizeKeyHash(witness.matchedSignerKeyHash) === signer.keyHash,
      ),
      thresholdReached: progress.matchedCount >= progress.requiredSignatures,
    },
    progress,
  };
}

export function assertRelayCreatePayload(raw: unknown) {
  if (!isRecord(raw)) throw new Error("Invalid relay create payload.");
  const tx = assertRelayRoomTx(raw.draft);
  const signers = assertRelaySigners(raw.signers, tx);
  return {
    network: normalizeNetwork(assertString(raw.network, "network")),
    tx,
    signers,
  };
}

export async function replaceRelayRoomFile(room: RelayRoomRecord, updater: (current: RelayRoomRecord) => RelayRoomRecord | Promise<RelayRoomRecord>) {
  return withRoomLock(room.id, async () => {
    const current = await readRelayRoom(room.id);
    const next = await updater(current);
    await writeRelayRoom(next);
    return next;
  });
}

export async function removeRelayRoom(roomIdValue: string) {
  await rm(roomPath(roomIdValue), { force: true });
}
