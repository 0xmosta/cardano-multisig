export type Network = "mainnet" | "preprod" | "preview";
export type SignerSource = "payment" | "stake" | "manual";

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
};

export type AssetLine = {
  id: string;
  unit: string;
  label: string;
  quantity: string;
  maxQuantity?: string;
  decimals?: number;
};

export type TxStatus = "pending" | "succeeded" | "failed";

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
};

export type MultisigWallet = {
  id: string;
  name: string;
  network: Network;
  threshold: number;
  signers: Signer[];
  paymentScript: NativeScript;
  stakeScript?: NativeScript | null;
  script: NativeScript;
  createdAt: string;
  imported: boolean;
  handle?: string;
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
  import.meta.env.VITE_CARDANO_NETWORK === "mainnet" || import.meta.env.VITE_CARDANO_NETWORK === "preview"
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
  if (script.type === "any") return children.length ? 1 : 0;
  if (script.type === "all") {
    return children.reduce((total, child) => total + requiredSignatures(child), 0);
  }
  if (script.type === "atLeast") return Number(script.required || 0);
  return children.reduce((total, child) => Math.max(total, requiredSignatures(child)), 0);
}

export function summarizeScript(script: NativeScript | null | undefined) {
  if (!script) return "Not provided";
  const leaves = countLeafScripts(script);
  if (script.type === "sig") return "1-of-1";
  if (script.type === "any") return `1-of-${leaves}`;
  if (script.type === "all") return `${leaves}-of-${leaves}`;
  if (script.type === "atLeast") return `${script.required ?? 0}-of-${leaves}`;
  return `${script.type} script`;
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

export function signatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">) {
  const matchedSigners = new Set(
    draft.signatures
      .map((signature) => normalizeKeyHash(signature.signerKeyHash))
      .filter((keyHash) => draft.signerKeyHashes.some((expected) => normalizeKeyHash(expected) === keyHash)),
  );
  return Math.min(matchedSigners.size, Math.max(draft.requiredSignatures || 1, 1));
}

export function unmatchedSignatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes">) {
  const expected = new Set(draft.signerKeyHashes.map(normalizeKeyHash));
  return draft.signatures.filter((signature) => !expected.has(normalizeKeyHash(signature.signerKeyHash))).length;
}

export function pendingSignatureCount(draft: Pick<TxDraft, "signatures" | "signerKeyHashes" | "requiredSignatures">) {
  return Math.max((draft.requiredSignatures || 1) - signatureCount(draft), 0);
}

export function pendingSignerKeyHashes(draft: Pick<TxDraft, "signatures" | "signerKeyHashes">) {
  const signed = new Set(draft.signatures.map((signature) => normalizeKeyHash(signature.signerKeyHash)));
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
  return draft.signatures.filter((signature) => expected.has(normalizeKeyHash(signature.signerKeyHash)));
}

export function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "cardano-multisig";
}

export function encodeInvite(draft: TxDraft) {
  const payload: InvitePayload = {
    type: "cardano-multisig-invite",
    version: 1,
    draft: { ...draft, signatures: [] },
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

export function mergeSignatures(existing: SignatureRecord[], incoming: SignatureRecord[]) {
  const next = new Map<string, SignatureRecord>();
  for (const signature of existing) {
    next.set(normalizeKeyHash(signature.signerKeyHash), signature);
  }
  for (const signature of incoming) {
    next.set(normalizeKeyHash(signature.signerKeyHash), {
      ...signature,
      signerKeyHash: normalizeKeyHash(signature.signerKeyHash),
    });
  }
  return [...next.values()];
}
