export type Network = "mainnet" | "preprod" | "preview";
export type SignerSource = "payment" | "stake" | "manual";
export type SignatureMatchStatus = "matched" | "unmatched";
export type SignatureSource = "manual" | "relay";

export type Signer = {
  id: string;
  label: string;
  keyHash: string;
  source?: SignerSource;
};

export type NativeScript = {
  type: string;
  keyHash?: string;
  scripts?: NativeScript[];
  required?: number;
  slot?: number;
  [key: string]: unknown;
};

export type SignatureRecord = {
  signerKeyHash: string;
  signerName: string;
  walletName: string;
  witnessCbor: string;
  signedAt: string;
  source?: SignatureSource;
  matchStatus?: SignatureMatchStatus;
  matchedSignerKeyHash?: string;
  relayWitnessId?: string;
};

export type AssetLine = {
  id: string;
  unit: string;
  label: string;
  quantity: string;
  maxQuantity?: string;
  decimals?: number;
};

export type RelayRoomInviteRef = {
  keyHash: string;
  label?: string;
  inviteUrl: string;
};

export type RelayRoomRef = {
  roomId: string;
  coordinatorToken?: string;
  createdAt: string;
  lastSyncAt?: string;
  status?: "open" | "submitted" | "cancelled" | "expired";
  sharedInviteUrl?: string;
  signerInvites?: RelayRoomInviteRef[];
};

export type TxStatus = "pending" | "succeeded" | "failed";

export type WalletDiscovery = {
  kind: "script" | "address";
  address?: string;
  source?: string;
  outputs?: number;
  assets?: AssetLine[];
  handle?: { name: string; address: string };
};

export type TxDraft = {
  id: string;
  walletId?: string;
  title: string;
  walletName: string;
  network: Network;
  recipient: string;
  lovelace: string;
  note: string;
  unsignedTxCbor: string;
  requiredSignatures: number;
  signerKeyHashes: string[];
  signatures: SignatureRecord[];
  createdAt: string;
  assets?: AssetLine[];
  status?: TxStatus;
  updatedAt?: string;
  txHash?: string;
  failureReason?: string;
  archivedAt?: string;
  relayRoom?: RelayRoomRef;
};

export type MultisigWallet = {
  id: string;
  name: string;
  network: Network;
  threshold: number;
  signers: Signer[];
  paymentScript?: NativeScript;
  stakeScript?: NativeScript | null;
  script?: NativeScript;
  createdAt: string;
  imported: boolean;
  handle?: string;
  discovery?: WalletDiscovery;
};

export type AddressBookContact = {
  id: string;
  label: string;
  address: string;
  handle?: string;
  network: Network;
  createdAt: string;
  updatedAt: string;
};

export type TransactionInboxFilter = "action" | "all" | "needs-you" | "waiting" | "ready" | "completed" | "archived";

export type AccountPreferences = {
  notificationsEnabled: boolean;
  defaultTransactionFilter: TransactionInboxFilter;
  preferredWalletId?: string;
};

export const DEFAULT_ACCOUNT_PREFERENCES: AccountPreferences = {
  notificationsEnabled: false,
  defaultTransactionFilter: "action",
};

export type InvitePayload = {
  type: "cardano-multisig-invite";
  version: 1;
  draft: TxDraft;
};

export type SignaturePackage = {
  type: "cardano-multisig-signatures";
  version: 1;
  draftId: string;
  signatures: SignatureRecord[];
};

export const STORAGE_KEY = "cardano-multisig.wallets.v2";
export const TX_STORAGE_KEY = "cardano-multisig.transactions.v1";
export const LEGACY_STORAGE_KEY = "cardano-multisig.wallets.v1";
export const NETWORKS: Network[] = ["mainnet", "preprod", "preview"];
export const DEFAULT_NETWORK: Network =
  import.meta.env?.VITE_CARDANO_NETWORK === "mainnet" || import.meta.env?.VITE_CARDANO_NETWORK === "preview"
    ? import.meta.env.VITE_CARDANO_NETWORK
    : "preprod";

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = "id") {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKeyHash(value: string) {
  return /^[0-9a-fA-F]{56}$/.test(value.trim());
}

export function normalizeKeyHash(value: string) {
  return value.trim().toLowerCase();
}

export function cleanSigner(signer: Signer): Signer {
  return {
    ...signer,
    label: signer.label.trim() || "Unnamed signer",
    keyHash: normalizeKeyHash(signer.keyHash),
  };
}

export function uniqueSigners(signers: Signer[]) {
  const seen = new Map<string, Signer>();
  for (const signer of signers) {
    const keyHash = normalizeKeyHash(signer.keyHash);
    if (!seen.has(keyHash)) {
      seen.set(keyHash, { ...signer, keyHash });
    }
  }
  return [...seen.values()];
}

export function countLeafScripts(script: NativeScript | null | undefined): number {
  if (!script) return 0;
  if (script.type === "sig") return 1;
  return Array.isArray(script.scripts)
    ? script.scripts.reduce((total, child) => total + countLeafScripts(child), 0)
    : 0;
}

export function requiredSignatures(script: NativeScript | null | undefined): number {
  if (!script) return 0;
  const children = Array.isArray(script.scripts) ? script.scripts : [];
  if (script.type === "sig") return 1;
  if (script.type === "any") {
    return children.length ? Math.min(...children.map((child) => requiredSignatures(child))) : 0;
  }
  if (script.type === "all") {
    return children.reduce((total, child) => total + requiredSignatures(child), 0);
  }
  if (script.type === "atLeast") {
    const required = Math.max(0, Math.min(Number(script.required || 0), children.length));
    return children
      .map((child) => requiredSignatures(child))
      .sort((left, right) => left - right)
      .slice(0, required)
      .reduce((total, childRequired) => total + childRequired, 0);
  }
  return children.reduce((total, child) => Math.max(total, requiredSignatures(child)), 0);
}

export function summarizeScript(script: NativeScript | null | undefined) {
  if (!script) return "Not provided";
  const leaves = countLeafScripts(script);
  return leaves ? `${requiredSignatures(script)}-of-${leaves}` : `${script.type} script`;
}

export function networkLabel(networkId: number) {
  if (networkId < 0) return "connected";
  return networkId === 1 ? "mainnet" : networkId === 0 ? "testnet" : `network ${networkId}`;
}

export function expectedNetworkId(network: string) {
  return network === "mainnet" ? 1 : 0;
}

export function formatTargetNetwork(network: string) {
  return network === "mainnet" ? "mainnet" : `${network} testnet`;
}

function normalizedMatchedSignerKeyHash(signature: SignatureRecord, expected?: Set<string>) {
  if (signature.matchStatus === "unmatched") return null;
  const candidate = normalizeKeyHash(signature.matchedSignerKeyHash || signature.signerKeyHash);
  if (expected && !expected.has(candidate)) return null;
  return candidate;
}

export function matchedSignerKeyHashes(
  draft: Pick<TxDraft, "signatures" | "signerKeyHashes">,
) {
  const expected = new Set(draft.signerKeyHashes.map(normalizeKeyHash));
  return new Set(
    draft.signatures
      .map((signature) => normalizedMatchedSignerKeyHash(signature, expected))
      .filter((keyHash): keyHash is string => Boolean(keyHash)),
  );
}

export function hasMatchedSignature(
  draft: Pick<TxDraft, "signatures" | "signerKeyHashes">,
  signerKeyHash: string,
) {
  return matchedSignerKeyHashes(draft).has(normalizeKeyHash(signerKeyHash));
}

export function signatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">) {
  return Math.min(matchedSignerKeyHashes(draft).size, Math.max(draft.requiredSignatures || 1, 1));
}

export function unmatchedSignatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes">) {
  const expected = new Set(draft.signerKeyHashes.map(normalizeKeyHash));
  return draft.signatures.filter((signature) => !normalizedMatchedSignerKeyHash(signature, expected)).length;
}

export function pendingSignatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">) {
  return Math.max((draft.requiredSignatures || 1) - signatureCount(draft), 0);
}

export function pendingSignerKeyHashes(draft: Pick<TxDraft, "signatures" | "signerKeyHashes">) {
  const signed = matchedSignerKeyHashes(draft);
  return draft.signerKeyHashes.filter((keyHash) => !signed.has(normalizeKeyHash(keyHash)));
}

export function requiredPendingSignerKeyHashes(
  draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">,
) {
  return pendingSignerKeyHashes(draft).slice(0, pendingSignatureCount(draft));
}

export function optionalSignerKeyHashes(draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">) {
  return pendingSignerKeyHashes(draft).slice(pendingSignatureCount(draft));
}

export function removeUnmatchedSignatures(draft: Pick<TxDraft, "signatures" | "signerKeyHashes">) {
  const expected = new Set(draft.signerKeyHashes.map(normalizeKeyHash));
  return draft.signatures.filter((signature) => Boolean(normalizedMatchedSignerKeyHash(signature, expected)));
}

export function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "cardano-multisig";
}

export function normalizeRelayAssetLines(draft: Pick<TxDraft, "assets" | "lovelace">): AssetLine[] {
  const source =
    draft.assets?.length
      ? draft.assets
      : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: draft.lovelace || "0", decimals: 6 }];

  return source.map((asset, index) => {
    const unit = asset.unit || "lovelace";
    return {
      id: asset.id || `${unit === "lovelace" ? "ada" : "asset"}-${index}`,
      unit,
      label: asset.label || (unit === "lovelace" ? "ADA" : unit.slice(0, 16)),
      quantity: asset.quantity || "0",
      maxQuantity: asset.maxQuantity,
      decimals: asset.decimals,
    };
  });
}

export function encodeInvite(draft: TxDraft) {
  const payload: InvitePayload = {
    type: "cardano-multisig-invite",
    version: 1,
    draft: { ...draft, signatures: [], relayRoom: undefined },
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeInvite(value: string, migrateDraft: (raw: unknown) => TxDraft | null) {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(normalized)));
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed) || parsed.type !== "cardano-multisig-invite" || !isRecord(parsed.draft)) {
      return null;
    }
    return migrateDraft(parsed.draft);
  } catch {
    return null;
  }
}

export function createSignaturePackage(draftId: string, signatures: SignatureRecord[]): string {
  const payload: SignaturePackage = {
    type: "cardano-multisig-signatures",
    version: 1,
    draftId,
    signatures,
  };
  return JSON.stringify(payload, null, 2);
}

export function parseSignaturePackage(
  value: string,
): { draftId: string; signatures: SignatureRecord[] } {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || typeof parsed.draftId !== "string") {
    throw new Error("Invalid signature package.");
  }

  if (
    parsed.type === "cardano-multisig-signature" &&
    isRecord(parsed.signature) &&
    typeof parsed.signature.signerKeyHash === "string"
  ) {
    return { draftId: parsed.draftId, signatures: [parsed.signature as SignatureRecord] };
  }

  if (parsed.type === "cardano-multisig-signatures" && Array.isArray(parsed.signatures)) {
    return {
      draftId: parsed.draftId,
      signatures: parsed.signatures.filter(
        (signature): signature is SignatureRecord =>
          isRecord(signature) &&
          typeof signature.signerKeyHash === "string" &&
          typeof signature.witnessCbor === "string",
      ),
    };
  }

  throw new Error("Invalid signature package.");
}

function signatureStorageKey(signature: SignatureRecord) {
  const matched = normalizedMatchedSignerKeyHash(signature);
  if (matched) return `matched:${matched}`;
  if (signature.relayWitnessId) return `relay:${signature.relayWitnessId}`;
  const claim = normalizeKeyHash(signature.signerKeyHash || "unknown");
  const timestamp = signature.signedAt || signature.witnessCbor.slice(0, 32);
  return `unmatched:${claim}:${timestamp}`;
}

export function mergeSignatures(existing: SignatureRecord[], incoming: SignatureRecord[]) {
  const next = new Map<string, SignatureRecord>();
  for (const signature of existing) {
    next.set(signatureStorageKey(signature), {
      ...signature,
      signerKeyHash: normalizeKeyHash(signature.signerKeyHash),
      matchedSignerKeyHash: signature.matchedSignerKeyHash
        ? normalizeKeyHash(signature.matchedSignerKeyHash)
        : undefined,
    });
  }
  for (const signature of incoming) {
    const normalizedSignature: SignatureRecord = {
      ...signature,
      signerKeyHash: normalizeKeyHash(signature.signerKeyHash),
      matchedSignerKeyHash: signature.matchedSignerKeyHash
        ? normalizeKeyHash(signature.matchedSignerKeyHash)
        : undefined,
    };
    const storageKey = signatureStorageKey(normalizedSignature);
    const existingSignature = next.get(storageKey);
    if (!normalizedSignature.witnessCbor.trim() && existingSignature?.witnessCbor.trim()) {
      next.set(storageKey, {
        ...normalizedSignature,
        ...existingSignature,
        matchStatus: normalizedSignature.matchStatus || existingSignature.matchStatus,
        matchedSignerKeyHash: normalizedSignature.matchedSignerKeyHash || existingSignature.matchedSignerKeyHash,
      });
      continue;
    }
    next.set(storageKey, normalizedSignature);
  }
  return [...next.values()];
}

function txTime(value: Pick<TxDraft, "updatedAt" | "createdAt">) {
  return new Date(value.updatedAt || value.createdAt || 0).getTime() || 0;
}

export function mergeTransactionDraft(existing: TxDraft, incoming: TxDraft): TxDraft {
  const incomingIsNewer = txTime(incoming) >= txTime(existing);
  const base = incomingIsNewer ? existing : incoming;
  const latest = incomingIsNewer ? incoming : existing;
  const txHash = latest.txHash || base.txHash;
  return {
    ...base,
    ...latest,
    signatures: mergeSignatures(base.signatures || [], latest.signatures || []),
    relayRoom: base.relayRoom || latest.relayRoom ? { ...base.relayRoom, ...latest.relayRoom } as RelayRoomRef : undefined,
    txHash,
    status: txHash ? "succeeded" : latest.status || base.status,
    failureReason: latest.failureReason || base.failureReason,
  };
}

export function mergeTransactionDrafts(existing: TxDraft[], incoming: TxDraft[]) {
  const merged = new Map<string, TxDraft>();
  for (const draft of existing) merged.set(draft.id, draft);
  for (const draft of incoming) {
    const current = merged.get(draft.id);
    merged.set(draft.id, current ? mergeTransactionDraft(current, draft) : draft);
  }
  return sortTransactionDraftsNewestFirst([...merged.values()]);
}

export function sortTransactionDraftsNewestFirst(drafts: TxDraft[]) {
  return [...drafts].sort((left, right) => {
    const createdAtDifference = (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
    if (createdAtDifference) return createdAtDifference;
    return right.id.localeCompare(left.id);
  });
}
