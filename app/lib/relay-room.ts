import type { AssetLine, Network, RelayRoomRef, SignatureRecord, TxDraft } from "./multisig";
import { mergeSignatures, nowIso } from "./multisig";

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
};

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
  tx: RelayRoomTx;
  signer: {
    keyHash: string;
    label?: string;
    alreadyDelivered: boolean;
    thresholdReached: boolean;
  };
  progress: RelayRoomProgress;
};

export type RelayRoomCreateRequest = {
  intent: "create";
  network: Network;
  draft: RelayRoomTx;
  signers: Array<{ keyHash: string; label?: string }>;
};

export type RelayRoomCreateResponse = {
  ok: true;
  roomId: string;
  coordinatorToken: string;
  signerInvites: RelayRoomSignerInvite[];
  expiresAt: string;
};

export type RelayRoomSessionRequest = {
  intent: "session";
  token: string;
};

export type RelayRoomSessionResponse =
  | { ok: true; role: "coordinator"; room: RelayRoomCoordinatorView }
  | { ok: true; role: "signer"; room: RelayRoomSignerView };

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
};

export type RelayRoomSubmitRequest = {
  intent: "submit";
  token: string;
  txHash: string;
};

export function relayInviteUrl(origin: string, token: string) {
  return `${origin.replace(/\/$/, "")}/#r=${encodeURIComponent(token)}`;
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

export function applyRelayRoomToDraft(tx: TxDraft, room: RelayRoomCoordinatorView): TxDraft {
  const relayRoom: RelayRoomRef | undefined = tx.relayRoom
    ? {
        ...tx.relayRoom,
        status: room.status,
        lastSyncAt: nowIso(),
      }
    : undefined;

  return {
    ...tx,
    walletId: tx.walletId || room.tx.walletId,
    walletName: room.tx.walletName,
    title: room.tx.title,
    note: room.tx.note,
    recipient: room.tx.recipient,
    lovelace: room.tx.lovelace,
    assets: room.tx.assets,
    unsignedTxCbor: room.tx.unsignedTxCbor,
    requiredSignatures: room.tx.requiredSignatures,
    signerKeyHashes: room.tx.signerKeyHashes,
    signatures: mergeSignatures(tx.signatures || [], relayWitnessesToSignatures(room.witnesses)),
    updatedAt: nowIso(),
    txHash: room.submission?.txHash || tx.txHash,
    relayRoom,
  };
}

export function draftFromRelaySignerView(room: RelayRoomSignerView): TxDraft {
  return {
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
  };
}
