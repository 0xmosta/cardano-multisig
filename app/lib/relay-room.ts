import type { AssetLine, NativeScript, Network, RelayRoomRef, SignatureRecord, TxDraft } from "./multisig";
import { mergeSignatures, normalizeKeyHash, nowIso } from "./multisig";

export type RelayRoomStatus = "open" | "submitted" | "cancelled" | "expired";
export type RelayWitnessMatchStatus = "matched" | "unmatched";
export type RelayWitnessSource = "relay" | "manual";

export type RelayRoomTx = {
  draftId: string;
  walletId?: string;
  walletName: string;
  title: string;
  note: string;
  recipient: string;
  lovelace: string;
  assets: AssetLine[];
  unsignedTxCbor: string;
  requiredSignatures: number;
  signerKeyHashes: string[];
  paymentScript?: NativeScript;
  stakeScript?: NativeScript | null;
};

export type RelayRoomSignerTx = Omit<RelayRoomTx, "paymentScript" | "stakeScript">;

export type RelayRoomPublicTx = Pick<RelayRoomSignerTx, "draftId" | "walletId" | "walletName" | "title" | "requiredSignatures" | "signerKeyHashes">;

export type RelayRoomSignerInvite = {
  keyHash: string;
  label?: string;
  inviteUrl: string;
};

export type RelayRoomSignerRecord = {
  keyHash: string;
  label?: string;
  createdAt: string;
  lastSeenAt?: string;
  deliveredAt?: string;
};

export type RelayRoomWitnessRecord = {
  id: string;
  source: RelayWitnessSource;
  signerKeyHashClaim?: string;
  matchedSignerKeyHash?: string;
  witnessCbor: string;
  walletName?: string;
  signerName?: string;
  signedAt: string;
  receivedAt: string;
  matchStatus: RelayWitnessMatchStatus;
};

export type RelayRoomProgress = {
  matchedCount: number;
  requiredSignatures: number;
  pendingRequiredKeyHashes: string[];
  optionalUnsignedKeyHashes: string[];
};

export type RelayRoomSubmission = {
  txHash: string;
  submittedAt: string;
};

export type RelayRoomCoordinatorView = {
  roomId: string;
  status: RelayRoomStatus;
  network: Network;
  expiresAt: string;
  tx: RelayRoomTx;
  signers: RelayRoomSignerRecord[];
  witnesses: RelayRoomWitnessRecord[];
  submission?: RelayRoomSubmission;
  progress: RelayRoomProgress;
};

export type RelayRoomSignerView = {
  roomId: string;
  status: RelayRoomStatus;
  network: Network;
  expiresAt: string;
  tx: RelayRoomSignerTx;
  submission?: RelayRoomSubmission;
  signer: {
    keyHash: string;
    label?: string;
    alreadyDelivered: boolean;
    thresholdReached: boolean;
  };
  progress: RelayRoomProgress;
};

export type RelayRoomPublicView = {
  roomId: string;
  status: RelayRoomStatus;
  network: Network;
  expiresAt: string;
  tx: RelayRoomPublicTx;
  submission?: RelayRoomSubmission;
  progress: RelayRoomProgress;
};

export type RelayRoomCreateRequest = {
  intent: "create";
  network: Network;
  draft: RelayRoomTx;
  signers: Array<{ keyHash: string; label?: string }>;
  witnesses?: Array<Partial<SignatureRecord> & { witnessCbor: string }>;
};

export type RelayRoomCreateResponse = {
  ok: true;
  roomId: string;
  coordinatorToken: string;
  sharedInviteUrl: string;
  signerInvites: RelayRoomSignerInvite[];
  expiresAt: string;
};

export type RelayRoomSessionRequest = {
  intent: "session";
  token: string;
};

export type RelayRoomSessionResponse =
  | { ok: true; role: "coordinator"; room: RelayRoomCoordinatorView; autoSubmitError?: string }
  | { ok: true; role: "signer"; room: RelayRoomSignerView; autoSubmitError?: string };

export type RelayRoomViewResponse = { ok: true; role: "viewer"; room: RelayRoomPublicView; autoSubmitError?: string };

export const RELAY_SYNC_INTERVAL_MS = 60_000;

export type RelayRoomSignRequest = {
  intent: "sign";
  token: string;
  witnessCbor: string;
  walletName?: string;
  signerName?: string;
  signedAt?: string;
};

export type RelayRoomSignResponse = {
  ok: true;
  delivered: true;
  matchStatus: RelayWitnessMatchStatus;
  matchedSignerKeyHash?: string;
  thresholdReached: boolean;
  submission?: RelayRoomSubmission;
  autoSubmitError?: string;
};

export type RelayRoomSubmitRequest = {
  intent: "submit";
  token: string;
  txHash: string;
};

export function relayInviteUrl(origin: string, token: string) {
  return `${origin.replace(/\/$/, "")}/sign#r=${encodeURIComponent(token)}`;
}

export function relayWitnessToSignature(witness: RelayRoomWitnessRecord): SignatureRecord {
  return {
    signerKeyHash: witness.matchedSignerKeyHash || witness.signerKeyHashClaim || `relay-${witness.id}`,
    matchedSignerKeyHash: witness.matchedSignerKeyHash,
    matchStatus: witness.matchStatus,
    relayWitnessId: witness.id,
    source: witness.source,
    signerName: witness.signerName || witness.matchedSignerKeyHash || witness.signerKeyHashClaim || "Relay signer",
    walletName: witness.walletName || "Relay wallet",
    witnessCbor: witness.witnessCbor,
    signedAt: witness.signedAt,
  };
}

export function relayWitnessesToSignatures(witnesses: RelayRoomWitnessRecord[]) {
  return witnesses.map(relayWitnessToSignature);
}

function relayProgressToSignatures(room: Pick<RelayRoomSignerView | RelayRoomPublicView, "roomId" | "expiresAt" | "tx" | "progress">): SignatureRecord[] {
  const unsignedKeyHashes = new Set(
    [...room.progress.pendingRequiredKeyHashes, ...room.progress.optionalUnsignedKeyHashes].map((keyHash) => normalizeKeyHash(keyHash)),
  );
  return room.tx.signerKeyHashes
    .map((keyHash) => normalizeKeyHash(keyHash))
    .filter((keyHash) => !unsignedKeyHashes.has(keyHash))
    .map((keyHash) => ({
      signerKeyHash: keyHash,
      matchedSignerKeyHash: keyHash,
      signerName: keyHash,
      walletName: "Relay signer",
      witnessCbor: "",
      signedAt: room.expiresAt,
      source: "relay" as const,
      matchStatus: "matched" as const,
      relayWitnessId: `relay-progress:${room.roomId}:${keyHash}`,
    }));
}

function relayRoomSignatures(room: RelayRoomCoordinatorView | RelayRoomSignerView | RelayRoomPublicView) {
  return "witnesses" in room ? relayWitnessesToSignatures(room.witnesses) : relayProgressToSignatures(room);
}

function nextTxFromRelayRoom(tx: TxDraft, room: RelayRoomCoordinatorView | RelayRoomSignerView | RelayRoomPublicView): TxDraft {
  const relayRoom: RelayRoomRef | undefined = tx.relayRoom
    ? {
        ...tx.relayRoom,
        status: room.status,
        lastSyncAt: nowIso(),
      }
    : undefined;

  return {
    ...tx,
    walletId: room.tx.walletId || tx.walletId,
    walletName: room.tx.walletName || tx.walletName,
    title: room.tx.title || tx.title,
    note: "note" in room.tx ? room.tx.note : tx.note,
    recipient: "recipient" in room.tx ? room.tx.recipient : tx.recipient,
    lovelace: "lovelace" in room.tx ? room.tx.lovelace : tx.lovelace,
    assets: "assets" in room.tx ? room.tx.assets : tx.assets,
    unsignedTxCbor: "unsignedTxCbor" in room.tx ? room.tx.unsignedTxCbor : tx.unsignedTxCbor,
    requiredSignatures: room.tx.requiredSignatures,
    signerKeyHashes: room.tx.signerKeyHashes,
    signatures: mergeSignatures(tx.signatures || [], relayRoomSignatures(room)),
    updatedAt: nowIso(),
    txHash: room.submission?.txHash || tx.txHash,
    status: room.submission?.txHash || room.status === "submitted" ? "succeeded" : tx.status,
    relayRoom,
  };
}

export function applyRelayRoomToDraft(tx: TxDraft, room: RelayRoomCoordinatorView | RelayRoomSignerView | RelayRoomPublicView): TxDraft {
  return nextTxFromRelayRoom(tx, room);
}

export function relayDraftFingerprint(draft: TxDraft) {
  return JSON.stringify({
    status: draft.status,
    txHash: draft.txHash,
    relayStatus: draft.relayRoom?.status,
    signatures: (draft.signatures || [])
      .map((signature) => [
        normalizeKeyHash(signature.matchedSignerKeyHash || signature.signerKeyHash || ""),
        signature.matchStatus,
        signature.signedAt,
        signature.relayWitnessId,
      ])
      .sort((left, right) => (left[0] || "").localeCompare(right[0] || "")),
  });
}

export function isRelayProgressSignature(signature: SignatureRecord) {
  return !signature.witnessCbor.trim() && Boolean(signature.relayWitnessId?.startsWith("relay-progress:"));
}

export function persistableRelayDraft(draft: TxDraft): TxDraft {
  const signatures = (draft.signatures || []).filter((signature) => !isRelayProgressSignature(signature));
  return signatures.length === (draft.signatures || []).length ? draft : { ...draft, signatures };
}

export function relayDraftsPersistenceFingerprint(drafts: TxDraft[]) {
  return JSON.stringify(
    drafts.map((draft) => {
      const persistable = persistableRelayDraft(draft);
      const { updatedAt: _updatedAt, relayRoom, ...durableDraft } = persistable;
      if (!relayRoom) return durableDraft;
      const { lastSyncAt: _lastSyncAt, ...durableRelayRoom } = relayRoom;
      return { ...durableDraft, relayRoom: durableRelayRoom };
    }),
  );
}

export function hasActiveRelayRoom(draft: Pick<TxDraft, "relayRoom" | "txHash">) {
  return Boolean(draft.relayRoom?.roomId && (draft.relayRoom.status || "open") === "open" && !draft.txHash);
}

export function draftFromRelaySignerView(room: RelayRoomSignerView): TxDraft {
  return nextTxFromRelayRoom(
    {
      id: room.tx.draftId,
      walletId: room.tx.walletId,
      title: room.tx.title,
      walletName: room.tx.walletName,
      network: room.network,
      recipient: room.tx.recipient,
      lovelace: room.tx.lovelace,
      note: room.tx.note,
      unsignedTxCbor: room.tx.unsignedTxCbor,
      requiredSignatures: room.tx.requiredSignatures,
      signerKeyHashes: room.tx.signerKeyHashes,
      signatures: [],
      createdAt: nowIso(),
      assets: room.tx.assets,
      updatedAt: nowIso(),
    },
    room,
  );
}
