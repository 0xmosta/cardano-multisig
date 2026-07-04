import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Network,
  type NativeScript,
  isKeyHash,
  isRecord,
  normalizeKeyHash,
} from "../multisig";
import {
  type RelayRoomCoordinatorView,
  type RelayRoomProgress,
  type RelayRoomPublicView,
  type RelayRoomSignerRecord,
  type RelayRoomSignerTx,
  type RelayRoomSignerView,
  type RelayRoomStatus,
  type RelayRoomSubmission,
  type RelayRoomTx,
  type RelayRoomWitnessRecord,
} from "../relay-room";
import { assertPersistenceMode, configuredNetwork as configuredPersistenceNetwork, postgresEnabled } from "./postgres";
import {
  cleanupExpiredRelayRoomsPostgres,
  listRelayRoomsPostgres,
  readRelayRoomPostgres,
  removeRelayRoomPostgres,
  resolveRelayTokenSessionPostgres,
  writeRelayRoomPostgres,
} from "./relay-room-postgres";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UNSIGNED_TX_CBOR_CHARS = 500_000;
const MAX_TEXT_FIELD_CHARS = 500;
const MAX_NOTE_CHARS = 2_000;
const MAX_ASSETS = 200;
const MAX_SIGNERS = 64;
const roomLocks = new Map<string, Promise<void>>();

type RelayRoomCoordinator = {
  tokenHash: string;
  lastSeenAt?: string;
};

type RelayRoomSharedSigner = {
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
  sharedSigner?: RelayRoomSharedSigner;
  signers: RelayRoomStoredSigner[];
  witnesses: RelayRoomWitnessRecord[];
  submission?: RelayRoomSubmission;
  submissionFailure?: {
    error: string;
    failedAt: string;
  };
};

export type RelayRoomTokenSession =
  | { role: "coordinator"; room: RelayRoomRecord }
  | { role: "shared-signer"; room: RelayRoomRecord }
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
  return configuredPersistenceNetwork();
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

function assertBoundedString(value: unknown, field: string, maxLength: number) {
  const next = assertString(value, field);
  if (next.length > maxLength) throw new Error(`${field} is too long.`);
  return next;
}

function assertOptionalString(value: unknown) {
  const next = String(value || "").trim();
  return next || undefined;
}

function assertOptionalBoundedString(value: unknown, field: string, maxLength: number) {
  const next = String(value || "").trim();
  if (!next) return undefined;
  if (next.length > maxLength) throw new Error(`${field} is too long.`);
  return next;
}

function assertOptionalNativeScript(value: unknown): NativeScript | undefined {
  if (!isRecord(value)) return undefined;
  const type = assertString(value.type, "script.type");
  const script: NativeScript = { type };
  if (typeof value.keyHash === "string" && value.keyHash.trim()) script.keyHash = normalizeKeyHash(value.keyHash);
  if (typeof value.required === "number") script.required = value.required;
  if (typeof value.slot === "number") script.slot = value.slot;
  if (Array.isArray(value.scripts)) script.scripts = value.scripts.map(assertOptionalNativeScript).filter(Boolean) as NativeScript[];
  for (const [key, raw] of Object.entries(value)) {
    if (key in script || key === "scripts") continue;
    script[key] = raw;
  }
  return script;
}

function assertAssetLine(raw: unknown, index = 0) {
  if (!isRecord(raw)) throw new Error("Invalid relay room asset.");
  const unit = assertString(raw.unit, "asset.unit");
  return {
    id: assertOptionalBoundedString(raw.id, "asset.id", MAX_TEXT_FIELD_CHARS) || `${unit === "lovelace" ? "ada" : "asset"}-${index}`,
    unit,
    label: assertBoundedString(raw.label, "asset.label", MAX_TEXT_FIELD_CHARS),
    quantity: assertString(raw.quantity, "asset.quantity"),
    maxQuantity: assertOptionalBoundedString(raw.maxQuantity, "asset.maxQuantity", MAX_TEXT_FIELD_CHARS),
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
  if (unsignedTxCbor.length > MAX_UNSIGNED_TX_CBOR_CHARS) throw new Error("draft.unsignedTxCbor is too large.");
  if (!/^[0-9a-f]+$/i.test(unsignedTxCbor) || unsignedTxCbor.length % 2 !== 0) {
    throw new Error("draft.unsignedTxCbor must be hex-encoded transaction CBOR.");
  }
  if (!signerKeyHashes.length) throw new Error("draft.signerKeyHashes must contain at least one valid signer key hash.");
  if (signerKeyHashes.length > MAX_SIGNERS) throw new Error(`draft.signerKeyHashes cannot contain more than ${MAX_SIGNERS} signers.`);
  if (requiredSignatures > signerKeyHashes.length) throw new Error("draft.requiredSignatures cannot exceed signerKeyHashes length.");
  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  if (assets.length > MAX_ASSETS) throw new Error(`draft.assets cannot contain more than ${MAX_ASSETS} assets.`);
  return {
    draftId: assertBoundedString(raw.draftId ?? raw.id, "draft.id", MAX_TEXT_FIELD_CHARS),
    walletId: assertOptionalBoundedString(raw.walletId, "draft.walletId", MAX_TEXT_FIELD_CHARS),
    walletName: assertBoundedString(raw.walletName, "draft.walletName", MAX_TEXT_FIELD_CHARS),
    title: assertBoundedString(raw.title, "draft.title", MAX_TEXT_FIELD_CHARS),
    note: String(raw.note || "").slice(0, MAX_NOTE_CHARS),
    recipient: assertBoundedString(raw.recipient, "draft.recipient", MAX_TEXT_FIELD_CHARS),
    lovelace: assertString(raw.lovelace, "draft.lovelace"),
    assets: assets.map((asset, index) => assertAssetLine(asset, index)),
    unsignedTxCbor,
    requiredSignatures,
    signerKeyHashes,
    paymentScript: assertOptionalNativeScript(raw.paymentScript),
    stakeScript: assertOptionalNativeScript(raw.stakeScript) ?? null,
  };
}

function assertRelaySigners(raw: unknown, tx: RelayRoomTx) {
  if (!Array.isArray(raw) || !raw.length) throw new Error("signers must list each policy signer invite.");
  if (raw.length > MAX_SIGNERS) throw new Error(`signers cannot contain more than ${MAX_SIGNERS} entries.`);
  const labelByKeyHash = new Map<string, string | undefined>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const keyHash = normalizeKeyHash(String(item.keyHash || ""));
    if (!isKeyHash(keyHash)) continue;
    if (!tx.signerKeyHashes.includes(keyHash)) continue;
    if (!labelByKeyHash.has(keyHash)) {
      labelByKeyHash.set(keyHash, assertOptionalBoundedString(item.label, "signer.label", MAX_TEXT_FIELD_CHARS));
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
    sharedSigner: isRecord(raw.sharedSigner)
      ? {
          tokenHash: assertString(raw.sharedSigner.tokenHash, "sharedSigner.tokenHash"),
          lastSeenAt: assertOptionalString(raw.sharedSigner.lastSeenAt),
        }
      : undefined,
    signers,
    witnesses,
    submission: isRecord(raw.submission)
      ? {
          txHash: assertString(raw.submission.txHash, "submission.txHash"),
          submittedAt: assertString(raw.submission.submittedAt, "submission.submittedAt"),
        }
      : undefined,
    submissionFailure: isRecord(raw.submissionFailure)
      ? {
          error: assertString(raw.submissionFailure.error, "submissionFailure.error"),
          failedAt: assertString(raw.submissionFailure.failedAt, "submissionFailure.failedAt"),
        }
      : undefined,
  };
}

async function ensureStore() {
  assertPersistenceMode("Relay room persistence");
  if (postgresEnabled()) return;
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
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(roomIdValue)) throw new Error("Invalid roomId.");
  if (postgresEnabled()) return readRelayRoomPostgres(roomIdValue);
  const raw = await readFile(roomPath(roomIdValue), "utf8");
  return assertRelayRoomRecord(JSON.parse(raw) as unknown);
}

export async function writeRelayRoom(room: RelayRoomRecord) {
  assertPersistenceMode("Relay room persistence");
  if (postgresEnabled()) {
    await writeRelayRoomPostgres(room);
    return;
  }
  await atomicWriteJson(roomPath(room.id), room);
}

function equivalentRoomKey(room: RelayRoomRecord) {
  const signerSet = [...room.tx.signerKeyHashes].sort().join(",");
  return `${room.network}:${room.tx.draftId}:${room.tx.unsignedTxCbor}:${signerSet}`;
}

function witnessMergeKey(witness: RelayRoomWitnessRecord) {
  if (witness.matchStatus === "matched" && witness.matchedSignerKeyHash) {
    return `matched:${normalizeKeyHash(witness.matchedSignerKeyHash)}`;
  }
  return `cbor:${witness.witnessCbor}`;
}

function isNewerWitness(incoming: RelayRoomWitnessRecord, current: RelayRoomWitnessRecord) {
  return Date.parse(incoming.receivedAt || incoming.signedAt) >= Date.parse(current.receivedAt || current.signedAt);
}

function mergeRoomWitnesses(rooms: RelayRoomRecord[]) {
  const byKey = new Map<string, RelayRoomWitnessRecord>();
  for (const room of rooms) {
    for (const witness of room.witnesses) {
      const key = witnessMergeKey(witness);
      const current = byKey.get(key);
      if (!current || isNewerWitness(witness, current)) {
        byKey.set(key, witness);
      }
    }
  }
  return [...byKey.values()].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
}

function witnessListKey(witnesses: RelayRoomWitnessRecord[]) {
  return witnesses
    .map((witness) => `${witnessMergeKey(witness)}:${witness.id}:${witness.receivedAt}`)
    .sort()
    .join("|");
}

function applyDeliveredAtFromWitnesses(room: RelayRoomRecord, witnesses: RelayRoomWitnessRecord[]) {
  const deliveredAtByKeyHash = new Map<string, string>();
  for (const witness of witnesses) {
    if (witness.matchStatus !== "matched" || !witness.matchedSignerKeyHash) continue;
    const keyHash = normalizeKeyHash(witness.matchedSignerKeyHash);
    const current = deliveredAtByKeyHash.get(keyHash);
    if (!current || Date.parse(witness.receivedAt) > Date.parse(current)) {
      deliveredAtByKeyHash.set(keyHash, witness.receivedAt);
    }
  }
  return room.signers.map((signer) => {
    const deliveredAt = deliveredAtByKeyHash.get(signer.keyHash);
    return deliveredAt ? { ...signer, deliveredAt } : signer;
  });
}

async function relayRoomFiles() {
  await ensureStore();
  const entries = await readdir(roomsDir(), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(roomsDir(), entry.name));
}

async function listRelayRooms() {
  if (postgresEnabled()) return listRelayRoomsPostgres();
  const files = await relayRoomFiles();
  const rooms: RelayRoomRecord[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    rooms.push(assertRelayRoomRecord(JSON.parse(raw) as unknown));
  }
  return rooms;
}

export async function cleanupExpiredRelayRooms() {
  if (postgresEnabled()) {
    await cleanupExpiredRelayRoomsPostgres();
    return;
  }
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
  const sharedSignerToken = capabilityToken();
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
    sharedSigner: {
      tokenHash: hashRelayToken(sharedSignerToken),
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
    sharedSignerToken,
    signerTokens: signerTokens.map((signer) => ({ keyHash: signer.keyHash, label: signer.label, token: signer.token })),
  };
}

export async function resolveRelayTokenSession(token: string): Promise<RelayRoomTokenSession | null> {
  await cleanupExpiredRelayRooms();
  const tokenHash = hashRelayToken(token);
  if (postgresEnabled()) return resolveRelayTokenSessionPostgres(tokenHash);
  const rooms = await listRelayRooms();
  for (const room of rooms) {
    if (room.coordinator.tokenHash === tokenHash) {
      return { role: "coordinator", room };
    }
    if (room.sharedSigner?.tokenHash === tokenHash) {
      return { role: "shared-signer", room };
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

// Signer-facing relay sessions still need the unsigned tx payload to sign, but they should not
// inherit coordinator-only scripts or stored witness packages from the server record.
function signerSafeTx(tx: RelayRoomTx): RelayRoomSignerTx {
  const { paymentScript: _paymentScript, stakeScript: _stakeScript, ...safeTx } = tx;
  return safeTx;
}

export function publicRelayRoomView(room: RelayRoomRecord): RelayRoomPublicView {
  return {
    roomId: room.id,
    status: room.status,
    network: room.network,
    expiresAt: room.expiresAt,
    tx: {
      draftId: room.tx.draftId,
      walletId: room.tx.walletId,
      walletName: room.tx.walletName,
      title: room.tx.title,
      requiredSignatures: room.tx.requiredSignatures,
      signerKeyHashes: room.tx.signerKeyHashes,
    },
    submission: room.submission,
    progress: relayProgress(room),
  };
}

export function sharedSignerRoomView(room: RelayRoomRecord): RelayRoomSignerView {
  const progress = relayProgress(room);
  return {
    roomId: room.id,
    status: room.status,
    network: room.network,
    expiresAt: room.expiresAt,
    tx: signerSafeTx(room.tx),
    submission: room.submission,
    signer: {
      keyHash: "",
      label: "Shared signer link",
      alreadyDelivered: false,
      thresholdReached: progress.matchedCount >= progress.requiredSignatures,
    },
    progress,
  };
}

export function signerRoomView(room: RelayRoomRecord, signer: RelayRoomStoredSigner): RelayRoomSignerView {
  const progress = relayProgress(room);
  return {
    roomId: room.id,
    status: room.status,
    network: room.network,
    expiresAt: room.expiresAt,
    tx: signerSafeTx(room.tx),
    submission: room.submission,
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

export async function syncEquivalentRelayRoomWitnesses(sourceRoom: RelayRoomRecord) {
  const rooms = (await listRelayRooms()).filter((room) => equivalentRoomKey(room) === equivalentRoomKey(sourceRoom));
  if (rooms.length <= 1) return sourceRoom;

  const witnesses = mergeRoomWitnesses(rooms);
  const witnessesKey = witnessListKey(witnesses);
  let syncedSource = sourceRoom;

  for (const room of rooms) {
    const currentKey = witnessListKey(room.witnesses);
    const nextSigners = applyDeliveredAtFromWitnesses(room, witnesses);
    const signersChanged = JSON.stringify(nextSigners) !== JSON.stringify(room.signers);
    if (currentKey === witnessesKey && !signersChanged) {
      if (room.id === sourceRoom.id) syncedSource = room;
      continue;
    }

    const updated = await replaceRelayRoomFile(room, (current) => ({
      ...current,
      updatedAt: nowIso(),
      signers: applyDeliveredAtFromWitnesses(current, witnesses),
      witnesses,
    }));
    if (updated.id === sourceRoom.id) syncedSource = updated;
  }

  return syncedSource;
}

export async function removeRelayRoom(roomIdValue: string) {
  if (postgresEnabled()) {
    await removeRelayRoomPostgres(roomIdValue);
    return;
  }
  await rm(roomPath(roomIdValue), { force: true });
}
