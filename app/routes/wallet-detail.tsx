import { Link, useNavigate, useSearchParams, useParams } from "react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Coins,
  Copy,
  Database,
  FileUp,
  ImageIcon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { cn, stableJsonStringify, userFacingError } from "../lib/utils";
import { useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { DataTable } from "../components/ui/data-table";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Textarea } from "../components/ui/textarea";
import {
  type MultisigWallet as Wallet,
  type NativeScript,
  type RelayRoomRef,
  type SignatureRecord,
  type TxDraft,
  createId,
  createSignaturePackage,
  decodeInvite,
  expectedNetworkId,
  formatTargetNetwork,
  hasMatchedSignature,
  mergeSignatures,
  mergeTransactionDrafts,
  networkLabel,
  nowIso,
  normalizeRelayAssetLines,
  normalizeKeyHash,
  optionalSignerKeyHashes,
  parseSignaturePackage,
  pendingSignatureCount,
  removeUnmatchedSignatures,
  requiredSignatures,
  requiredPendingSignerKeyHashes,
  signatureCount,
  summarizeScript,
  unmatchedSignatureCount,
} from "../lib/multisig";
import {
  type RelayRoomCoordinatorView,
  type RelayRoomCreateResponse,
  type RelayRoomSessionResponse,
  type RelayRoomSignerView,
  RELAY_SYNC_INTERVAL_MS,
  applyRelayRoomToDraft,
  hasRelayRoomProgressToSync,
  relayDraftFingerprint,
  relayDraftsPersistenceFingerprint,
} from "../lib/relay-room";
import { signerHandleLabel, useSignerHandles } from "../lib/signer-handles";
import { verifySignatureRecordsForDraft } from "../lib/witness-verification";

type AssetLine = { id: string; unit: string; label: string; quantity: string; decimals?: number };
type AssetOption = {
  unit: string;
  label: string;
  quantity: string;
  outputCount?: number;
  decimals?: number;
  fingerprint?: string;
  image?: string;
  mediaType?: string;
  policyId?: string;
  assetName?: string;
};
type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };
type RecoveredScript = { source: string; txHash: string; scriptHash: string; paymentScript: NativeScript };
type AssetFetch = { assets: AssetOption[]; handle?: HandleInfo | null; source?: string; address?: string; outputs?: number; recoveredScript?: RecoveredScript | null };
type TxPhase = "pending" | "ready" | "submitted";
type RelaySyncState = { status: "idle" | "syncing" | "synced" | "failed"; at?: string; error?: string };

export function meta() {
  return [{ title: "Wallet · Cardano Multisig" }];
}

const RELAY_SESSION_KEY = "cardano-multisig.relay-rooms.session.v1";

function readRelaySessionRooms() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(RELAY_SESSION_KEY) || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, RelayRoomRef>) : {};
  } catch {
    return {};
  }
}

function writeRelaySessionRoom(txId: string, relayRoom: RelayRoomRef) {
  const current = readRelaySessionRooms();
  current[txId] = relayRoom;
  window.sessionStorage.setItem(RELAY_SESSION_KEY, JSON.stringify(current, null, 2));
}

function hydrateRelayRoomSession(tx: TxDraft): TxDraft {
  if (!tx.relayRoom) return tx;
  const sessionRelayRoom = readRelaySessionRooms()[tx.id];
  if (!sessionRelayRoom) return tx;
  return {
    ...tx,
    relayRoom: {
      ...tx.relayRoom,
      ...(!tx.relayRoom.coordinatorToken && sessionRelayRoom.coordinatorToken
        ? { coordinatorToken: sessionRelayRoom.coordinatorToken }
        : {}),
      ...(!tx.relayRoom.sharedInviteUrl && sessionRelayRoom.sharedInviteUrl
        ? { sharedInviteUrl: sessionRelayRoom.sharedInviteUrl }
        : {}),
      ...(!tx.relayRoom.signerInvites?.length && sessionRelayRoom.signerInvites?.length
        ? { signerInvites: sessionRelayRoom.signerInvites }
        : {}),
    },
  };
}

function stateSnapshotKey(wallets: Wallet[], txs: TxDraft[]) {
  return stableJsonStringify({ wallets, txs: relayDraftsPersistenceFingerprint(txs) });
}

function formatRawQuantity(quantity: string, unit: string, decimals = unit === "lovelace" ? 6 : 0) {
  const label = unit === "lovelace" ? "ADA" : "";
  const raw = BigInt(quantity || "0");
  if (!decimals) return `${raw.toLocaleString()}${label ? ` ${label}` : ""}`;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(decimals, "0")}`;
  return `${`${whole.toLocaleString()}${fracText}`.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}${label ? ` ${label}` : ""}`;
}

function compactMiddle(value: string, start = 10, end = 8) {
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function assetSubtitle(asset: Pick<AssetOption, "unit" | "fingerprint" | "policyId" | "assetName">) {
  if (asset.unit === "lovelace") return "Cardano native currency";
  if (asset.fingerprint) return asset.fingerprint;
  if (asset.policyId) return `${compactMiddle(asset.policyId, 12, 8)}${asset.assetName ? `.${compactMiddle(asset.assetName, 8, 4)}` : ""}`;
  return compactMiddle(asset.unit, 18, 10);
}

function AssetThumb({
  asset,
  className = "size-10",
}: {
  asset: Pick<AssetOption, "label" | "unit" | "image">;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState("");

  useEffect(() => {
    setFailedSrc("");
  }, [asset.image]);

  if (asset.image && failedSrc !== asset.image) {
    return (
      <div className={cn(className, "overflow-hidden rounded-md border bg-muted")}>
        <img
          src={asset.image}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(asset.image || "")}
        />
      </div>
    );
  }

  return (
    <div className={cn(className, "flex shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground")}>
      {asset.unit === "lovelace" ? <Coins className="size-4 text-sky-300" /> : <ImageIcon className="size-4" />}
    </div>
  );
}

function txPhase(tx: TxDraft): TxPhase {
  if (tx.txHash) return "submitted";
  return signatureCount(tx) >= Math.max(tx.requiredSignatures || 1, 1) ? "ready" : "pending";
}

function phaseBadge(status: TxPhase) {
  if (status === "submitted") return "default" as const;
  if (status === "ready") return "secondary" as const;
  return "outline" as const;
}

function phaseIcon(status: TxPhase) {
  if (status === "submitted") return <CheckCircle2 className="size-4 text-emerald-300" />;
  if (status === "ready") return <ShieldCheck className="size-4 text-sky-300" />;
  return <Clock3 className="size-4 text-amber-300" />;
}

function phaseLabel(status: TxPhase) {
  if (status === "submitted") return "Completed";
  if (status === "ready") return "Ready";
  return "Waiting";
}

function nextActionLabel(tx: TxDraft, connectedKeyHash?: string | null) {
  const phase = txPhase(tx);
  if (phase === "submitted") return "Completed";
  if (phase === "ready") return "Required signatures collected";
  const connectedSigner = normalizeKeyHash(connectedKeyHash || "");
  if (
    connectedSigner &&
    tx.signerKeyHashes.some((keyHash) => normalizeKeyHash(keyHash) === connectedSigner) &&
    !hasMatchedSignature(tx, connectedSigner)
  ) {
    return "Your signature is needed";
  }
  const pending = pendingSignatureCount(tx);
  return `Waiting for ${pending} signature${pending === 1 ? "" : "s"}`;
}

function connectedSignerStatus(tx: TxDraft, connectedKeyHash?: string | null) {
  const keyHash = normalizeKeyHash(connectedKeyHash || "");
  if (!keyHash) return "not-connected" as const;
  if (!tx.signerKeyHashes.some((signerKeyHash) => normalizeKeyHash(signerKeyHash) === keyHash)) return "not-signer" as const;
  return hasMatchedSignature(tx, keyHash) ? "signed" as const : "can-sign" as const;
}

function shortHash(value?: string | null, edge = 8) {
  if (!value) return "";
  return value.length > edge * 2 ? `${value.slice(0, edge)}…${value.slice(-edge)}` : value;
}

function relativeTime(value?: string) {
  if (!value) return "never";
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  if (!Number.isFinite(diffMs)) return "unknown";
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString();
}

function explorerTxUrl(network: string, txHash: string) {
  if (!txHash) return "";
  const prefix = network === "mainnet" ? "" : `${network}.`;
  return `https://${prefix}cexplorer.io/tx/${txHash}`;
}

function handleCandidate(wallet: { name?: string; handle?: string }) {
  const candidate = (wallet.handle || wallet.name || "").trim().replace(/^\$/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,31}$/.test(candidate) ? candidate : "";
}

function assetQuery(patterns: string[], wallet: { name?: string; handle?: string; network?: string }, stakeAddress?: string | null) {
  const params = new URLSearchParams();
  params.set("network", wallet.network || "preprod");
  if (patterns.length) params.set("patterns", patterns.join(","));
  const handle = handleCandidate(wallet);
  if (handle) params.set("handle", handle);
  if (stakeAddress) params.set("stakeAddress", stakeAddress);
  return params.toString();
}

function handleLabel(handle?: HandleInfo | null) {
  return handle ? `$${handle.name}` : "";
}

function recoveredPaymentSigners(script: NativeScript, existing: Wallet["signers"]) {
  const existingByHash = new Map(existing.map((signer) => [normalizeKeyHash(signer.keyHash), signer]));
  const signers: Wallet["signers"] = [];
  const seen = new Set<string>();
  function visit(node: NativeScript) {
    if (node.type === "sig" && node.keyHash) {
      const keyHash = normalizeKeyHash(node.keyHash);
      if (!seen.has(keyHash)) {
        seen.add(keyHash);
        signers.push(existingByHash.get(keyHash) || {
          id: createId("payment"),
          label: `Payment signer ${signers.length + 1}`,
          keyHash,
          source: "payment",
        });
      }
    }
    for (const child of node.scripts || []) visit(child);
  }
  visit(script);
  return signers;
}

function scriptToCsl(CSL: any, script: NativeScript): any {
  if (script.type === "sig" && script.keyHash) {
    return CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)));
  }
  const children = CSL.NativeScripts.new();
  for (const child of script.scripts || []) children.add(scriptToCsl(CSL, child));
  if (script.type === "all") return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(children));
  if (script.type === "any") return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(children));
  if (script.type === "atLeast") {
    return CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(Number(script.required || 1), children));
  }
  throw new Error(`Unsupported native script type: ${script.type}`);
}

async function walletResolution(wallet: Wallet): Promise<{ patterns: string[]; stakeAddress: string | null }> {
  if (!wallet.paymentScript) return { patterns: [], stakeAddress: null };
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser");
    const paymentHash = scriptToCsl(CSL, wallet.paymentScript).hash().to_hex();
    const isMainnet = wallet.network === "mainnet";
    const networkId = isMainnet ? 1 : 0;
    const patterns = [`${isMainnet ? "71" : "70"}${paymentHash}`];
    let stakeAddress: string | null = null;
    if (wallet.stakeScript) {
      const stakeHash = scriptToCsl(CSL, wallet.stakeScript).hash().to_hex();
      patterns.unshift(`${isMainnet ? "31" : "30"}${paymentHash}${stakeHash}`);
      stakeAddress = CSL.RewardAddress.new(
        networkId,
        CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(stakeHash)),
      )
        .to_address()
        .to_bech32();
    }
    return { patterns: Array.from(new Set(patterns)), stakeAddress };
  } catch {
    return { patterns: [], stakeAddress: null };
  }
}

async function fetchWalletAssets(wallet: Wallet): Promise<AssetFetch> {
  if (!wallet.paymentScript && wallet.discovery?.address) {
    const params = new URLSearchParams();
    params.set("network", wallet.network || "preprod");
    params.set("address", wallet.discovery.address);
    const response = await fetch(`/api/cardano/assets?${params.toString()}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not load address assets.");
    return { assets: body.assets || [], handle: body.handle, source: body.source, address: body.address, outputs: body.outputs, recoveredScript: body.recoveredScript };
  }

  const { patterns, stakeAddress } = await walletResolution(wallet);
  const query = assetQuery(patterns, wallet, stakeAddress);
  if (!query) throw new Error("Could not derive wallet script hash or ADA Handle.");
  const response = await fetch(`/api/cardano/assets?${query}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load multisig assets.");
  return { assets: body.assets || [], handle: body.handle, source: body.source, address: body.address, outputs: body.outputs, recoveredScript: body.recoveredScript };
}

function signerLabel(wallet: Wallet, keyHash: string) {
  const signer = wallet.signers.find((item) => item.keyHash.toLowerCase() === keyHash.toLowerCase());
  return signer?.label || shortHash(keyHash, 6);
}

function signerDisplay(wallet: Wallet, keyHash: string, connectedKeyHash?: string | null) {
  const label = signerLabel(wallet, keyHash);
  const isConnected = Boolean(connectedKeyHash && normalizeKeyHash(connectedKeyHash) === normalizeKeyHash(keyHash));
  return {
    label: isConnected ? `${label} · You` : label,
    isConnected,
  };
}

function mergeVkeyWitnesses(CSL: any, current: any, incoming: any) {
  const merged = CSL.Vkeywitnesses.new();
  const seen = new Set<string>();
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      const witness = collection.get(index);
      const key = witness.vkey().public_key().to_hex();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.add(witness);
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

function mergeBootstrapWitnesses(CSL: any, current: any, incoming: any) {
  const merged = CSL.BootstrapWitnesses.new();
  const seen = new Set<string>();
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      const witness = collection.get(index);
      const key = witness.vkey().public_key().to_hex();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.add(witness);
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

function mergeNativeScripts(CSL: any, current: any, incoming: any) {
  const merged = CSL.NativeScripts.new();
  const seen = new Set<string>();
  const pushScript = (script: any) => {
    const key = script.hash().to_hex();
    if (seen.has(key)) return;
    seen.add(key);
    merged.add(script);
  };
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      pushScript(collection.get(index));
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

async function buildSignedTxCbor(wallet: Wallet, tx: TxDraft) {
  if (!wallet.paymentScript) throw new Error("This wallet is watch-only. Import its native script before submitting transactions.");
  const CSL = await import("@emurgo/cardano-serialization-lib-browser");
  const unsigned = CSL.Transaction.from_hex(tx.unsignedTxCbor.trim());
  const witnessSet = CSL.TransactionWitnessSet.new();
  const unsignedWitnessSet = unsigned.witness_set();

  const paymentScript = scriptToCsl(CSL, wallet.paymentScript);
  const walletScripts = CSL.NativeScripts.new();
  walletScripts.add(paymentScript);

  let vkeys = mergeVkeyWitnesses(CSL, undefined, unsignedWitnessSet.vkeys());
  let bootstraps = mergeBootstrapWitnesses(CSL, undefined, unsignedWitnessSet.bootstraps());
  let nativeScripts = mergeNativeScripts(CSL, walletScripts, unsignedWitnessSet.native_scripts());

  for (const signature of tx.signatures || []) {
    const incoming = CSL.TransactionWitnessSet.from_hex(signature.witnessCbor);
    vkeys = mergeVkeyWitnesses(CSL, vkeys, incoming.vkeys());
    bootstraps = mergeBootstrapWitnesses(CSL, bootstraps, incoming.bootstraps());
    nativeScripts = mergeNativeScripts(CSL, nativeScripts, incoming.native_scripts());
  }

  if (vkeys?.len()) witnessSet.set_vkeys(vkeys);
  if (bootstraps?.len()) witnessSet.set_bootstraps(bootstraps);
  if (nativeScripts?.len()) witnessSet.set_native_scripts(nativeScripts);

  return CSL.Transaction.new(unsigned.body(), witnessSet, unsigned.auxiliary_data()).to_hex();
}

export default function WalletDetail() {
  const { walletId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { account, accountState, connected, providerStatus, providers, refreshServerState, saveServerState } = useAppShell();

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [txs, setTxs] = useState<TxDraft[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const pendingServerSaveKeyRef = useRef<string | null>(null);
  const txsRef = useRef<TxDraft[]>([]);
  const relaySyncInFlightRef = useRef(false);
  const assetRequestIdRef = useRef(0);
  const previousPendingSignaturesRef = useRef(new Map<string, number>());
  const [signStatus, setSignStatus] = useState("");
  const [walletAssets, setWalletAssets] = useState<AssetOption[]>([]);
  const [resolvedHandle, setResolvedHandle] = useState<HandleInfo | null>(null);
  const [handleConflict, setHandleConflict] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [assetStatus, setAssetStatus] = useState("Loading multisig assets…");
  const [signaturePackageInput, setSignaturePackageInput] = useState("");
  const [relaySync, setRelaySync] = useState<RelaySyncState>({ status: "idle" });
  const [expandedTransactions, setExpandedTransactions] = useState<Record<string, boolean>>({});
  const [showArchivedTransactions, setShowArchivedTransactions] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingWallet, setDeletingWallet] = useState(false);

  txsRef.current = txs;

  useEffect(() => {
    let cancelled = false;
    if (account.authenticated) {
      if (accountState) {
        setWallets(accountState.wallets);
        setTxs(accountState.transactions.map(hydrateRelayRoomSession));
        setHydrated(true);
        return;
      }
      setHydrated(false);
      void refreshServerState()
        .then((state) => {
          if (cancelled || !state) return;
          setWallets(state.wallets);
          setTxs(state.transactions.map(hydrateRelayRoomSession));
          setHydrated(true);
        })
        .catch((error) => {
          if (cancelled) return;
          setSignStatus(userFacingError(error, "We could not load your account."));
          setHydrated(true);
        });
      return () => {
        cancelled = true;
      };
    }

    setWallets([]);
    setTxs([]);
    setHydrated(true);
    return () => {
      cancelled = true;
    };
  }, [account.authenticated, accountState]);

  useEffect(() => {
    if (!hydrated) return;
    if (account.authenticated) {
      if (!accountState) return;
      const nextKey = stateSnapshotKey(wallets, txs);
      const currentServerKey = stateSnapshotKey(accountState.wallets, accountState.transactions);
      if (nextKey === currentServerKey || pendingServerSaveKeyRef.current === nextKey) return;
      pendingServerSaveKeyRef.current = nextKey;
      void saveServerState({ wallets, transactions: txs })
        .catch((error) => {
          const message = userFacingError(error, "We could not save your latest changes.");
          setSignStatus(message);
          toast.error("Could not sync account state", { description: message });
        })
        .finally(() => {
          if (pendingServerSaveKeyRef.current === nextKey) pendingServerSaveKeyRef.current = null;
        });
      return;
    }
    pendingServerSaveKeyRef.current = null;
  }, [account.authenticated, accountState, hydrated, txs, wallets]);

  const wallet = wallets.find((item) => item.id === walletId);
  const signerHandles = useSignerHandles(wallet?.signers.map((signer) => signer.keyHash) || [], wallet?.network);
  const draftIdFromQuery = searchParams.get("draft");

  useEffect(() => {
    if (wallet) {
      setHandleInput(wallet.handle || "");
      setNameInput(wallet.name || "");
    }
  }, [wallet?.id]);

  const allWalletTxs = useMemo(() => {
    return txs
      .filter((tx) => tx.walletId === walletId || (!tx.walletId && wallet && tx.walletName === wallet.name))
      .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  }, [txs, wallet, walletId]);
  const archivedTransactionCount = allWalletTxs.filter((tx) => Boolean(tx.archivedAt)).length;
  const walletTxs = useMemo(
    () => allWalletTxs.filter((tx) => !tx.archivedAt || showArchivedTransactions || tx.id === draftIdFromQuery),
    [allWalletTxs, draftIdFromQuery, showArchivedTransactions],
  );
  const isWatchOnly = wallet ? !wallet.paymentScript : false;

  useEffect(() => {
    if (!draftIdFromQuery) return;
    setExpandedTransactions((current) =>
      current[draftIdFromQuery] === true ? current : { ...current, [draftIdFromQuery]: true },
    );
  }, [draftIdFromQuery]);

  useEffect(() => {
    const nextPendingSignatures = new Map<string, number>();
    const expansionChanges = new Map<string, boolean>();
    for (const tx of walletTxs) {
      const pending = pendingSignatureCount(tx);
      const previous = previousPendingSignaturesRef.current.get(tx.id);
      nextPendingSignatures.set(tx.id, pending);
      if (previous === undefined || (previous > 0) === (pending > 0)) continue;
      expansionChanges.set(tx.id, pending > 0);
    }
    previousPendingSignaturesRef.current = nextPendingSignatures;
    if (!expansionChanges.size) return;
    setExpandedTransactions((current) => {
      const next = { ...current };
      for (const [txId, expanded] of expansionChanges) next[txId] = expanded;
      return next;
    });
  }, [walletTxs]);

  useEffect(() => {
    if (wallet) void refreshAssets(wallet);
  }, [wallet?.id]);

  const relaySyncKey = useMemo(
    () =>
      txs
        .filter(
          (tx) =>
            tx.walletId === walletId &&
            (tx.relayRoom?.coordinatorToken || tx.relayRoom?.sharedInviteUrl || tx.relayRoom?.roomId) &&
            hasRelayRoomProgressToSync(tx),
        )
        .map((tx) => `${tx.id}:${tx.relayRoom!.coordinatorToken || tx.relayRoom!.sharedInviteUrl || tx.relayRoom!.roomId}:${tx.relayRoom!.status || "open"}`)
        .join("|"),
    [txs, walletId],
  );

  function relayDraftsForWallet(source: TxDraft[] = txs) {
    return source.filter(
      (tx) =>
        tx.walletId === walletId &&
        (tx.relayRoom?.coordinatorToken || tx.relayRoom?.sharedInviteUrl || tx.relayRoom?.roomId) &&
        hasRelayRoomProgressToSync(tx),
    ) as Array<TxDraft & { relayRoom: RelayRoomRef }>;
  }

  async function refreshRelayRooms(source: TxDraft[] = txsRef.current) {
    if (relaySyncInFlightRef.current) return false;
    const relayDrafts = relayDraftsForWallet(source);
    if (!relayDrafts.length) {
      setRelaySync({ status: "idle" });
      return false;
    }

    relaySyncInFlightRef.current = true;
    setRelaySync({ status: "syncing", at: nowIso() });
    try {
      const updates = await Promise.all(
        relayDrafts.map(async (tx) => {
          const token = tx.relayRoom!.coordinatorToken || relayTokenFromInviteUrl(tx.relayRoom!.sharedInviteUrl || "");
          if (!token) return null;
          const room = await fetchRelayRoom(token);
          return { txId: tx.id, room };
        }),
      );
      const byId = new Map(updates.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).map((entry) => [entry.txId, entry.room]));
      let changed = false;
      setTxs((current) => {
        const next = current.map((tx) => {
          const room = byId.get(tx.id);
          if (!room) return tx;
          const updated = applyRelayRoomToDraft(tx, room);
          const txChanged = relayDraftFingerprint(updated) !== relayDraftFingerprint(tx);
          if (txChanged) changed = true;
          return txChanged ? updated : tx;
        });
        return changed ? next : current;
      });
      setRelaySync({ status: "synced", at: nowIso() });
      return changed;
    } catch (error) {
      setRelaySync({ status: "failed", at: nowIso(), error: userFacingError(error, "Signature progress could not be refreshed.") });
      throw error;
    } finally {
      relaySyncInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!relayDraftsForWallet().length) return;

    let cancelled = false;
    const sync = async () => {
      if (cancelled) return;
      await refreshRelayRooms(txsRef.current).catch(() => undefined);
    };

    void sync();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void sync();
    }, RELAY_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [relaySyncKey, walletId]);

  const connectWarning =
    connected && wallet && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(wallet.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this multisig wallet is on ${formatTargetNetwork(wallet.network)}.`
      : "";

  async function fetchRelayRoom(token: string): Promise<RelayRoomCoordinatorView | RelayRoomSignerView> {
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "session", token }),
    });
    const body = (await response.json()) as RelayRoomSessionResponse | { ok: false; error?: string };
    if (!response.ok || !body.ok || (body.role !== "coordinator" && body.role !== "signer")) {
      throw new Error(("error" in body && body.error) || "Could not load relay room state.");
    }
    return body.room;
  }

  function relayTokenFromInviteUrl(inviteUrl: string) {
    try {
      const parsed = new URL(inviteUrl, window.location.origin);
      const token = new URLSearchParams(parsed.hash.replace(/^#/, "")).get("r");
      return token || "";
    } catch {
      return inviteUrl.split("#r=")[1]?.trim() || "";
    }
  }

  async function syncExistingWitnessesToRelayRoom(tx: TxDraft, relayRoom: RelayRoomRef) {
    if (!tx.signatures?.length || (!relayRoom.sharedInviteUrl && !relayRoom.signerInvites?.length)) return;
    await Promise.all(
      tx.signatures
        .filter((signature) => signature.witnessCbor?.trim())
        .map(async (signature) => {
          const keyHash = normalizeKeyHash(signature.matchedSignerKeyHash || signature.signerKeyHash || "");
          const invite = relayRoom.signerInvites?.find((item) => normalizeKeyHash(item.keyHash) === keyHash);
          const token = relayRoom.sharedInviteUrl ? relayTokenFromInviteUrl(relayRoom.sharedInviteUrl) : invite ? relayTokenFromInviteUrl(invite.inviteUrl) : "";
          if (!token) return;
          await fetch("/api/cardano/relay-room", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              intent: "sign",
              token,
              witnessCbor: signature.witnessCbor,
              walletName: signature.walletName,
              signerName: signature.signerName,
              signedAt: signature.signedAt,
            }),
          }).catch(() => undefined);
        }),
    );
  }

  async function ensureRelayRoom(tx: TxDraft) {
    if (!wallet) throw new Error("Wallet not loaded.");
    if (!account.authenticated || !account.session) throw new Error("Sign in with a wallet before creating a signing room.");
    if (tx.relayRoom?.coordinatorToken && tx.relayRoom.signerInvites?.length && tx.relayRoom.sharedInviteUrl) {
      await syncExistingWitnessesToRelayRoom(tx, tx.relayRoom);
      return tx.relayRoom;
    }
    if (!tx.unsignedTxCbor.trim()) {
      throw new Error("This transaction is incomplete. Recreate it before sharing it with signers.");
    }
    const relayAssets = normalizeRelayAssetLines(tx);
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cardano-multisig-csrf": account.session.csrfToken,
      },
      body: JSON.stringify({
        intent: "create",
        network: tx.network,
        draft: {
          draftId: tx.id,
          walletId: tx.walletId,
          walletName: tx.walletName,
          title: tx.title,
          note: tx.note,
          recipient: tx.recipient,
          lovelace: tx.lovelace,
          assets: relayAssets,
          unsignedTxCbor: tx.unsignedTxCbor,
          requiredSignatures: tx.requiredSignatures,
          signerKeyHashes: tx.signerKeyHashes,
          paymentScript: wallet.paymentScript,
          stakeScript: wallet.stakeScript ?? null,
        },
        signers: tx.signerKeyHashes.map((keyHash) => ({
          keyHash,
          label: wallet.signers.find((signer) => signer.keyHash.toLowerCase() === keyHash.toLowerCase())?.label,
        })),
        witnesses: tx.signatures || [],
      }),
    });
    const body = (await response.json()) as RelayRoomCreateResponse | { ok: false; error?: string };
    if (!response.ok || !body.ok) {
      throw new Error(("error" in body && body.error) || "Could not create relay room.");
    }
    const relayRoom: RelayRoomRef = {
      roomId: body.roomId,
      coordinatorToken: body.coordinatorToken,
      sharedInviteUrl: body.sharedInviteUrl,
      createdAt: nowIso(),
      signerInvites: body.signerInvites,
      status: "open",
    };
    const next = txs.map((item) => (item.id === tx.id ? { ...item, assets: relayAssets, relayRoom, updatedAt: nowIso() } : item));
    writeRelaySessionRoom(tx.id, relayRoom);
    setTxs(next);
    return relayRoom;
  }

  async function signTransaction(tx: TxDraft) {
    if (!connected) {
      setSignStatus(
        providers.length
          ? `Choose ${providers.map((provider) => provider.name).join(" or ")} above, approve the wallet popup, then click Sign.`
          : "No CIP-30 browser wallet detected. Install/open a Cardano wallet extension first.",
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (connectWarning) {
      setSignStatus(connectWarning);
      return;
    }
    const signerStatus = connectedSignerStatus(tx, connected.keyHash);
    if (signerStatus === "not-signer") {
      setSignStatus(`${connected.name} is connected, but its payment key is not part of this multisig policy. Choose one of the listed signer wallets.`);
      toast.warning("Connected wallet is not a signer");
      return;
    }
    if (signerStatus === "signed") {
      setSignStatus(`${connected.name} has already signed this transaction.`);
      return;
    }
    if (!tx.unsignedTxCbor?.trim()) {
      setSignStatus("This transaction is incomplete. Recreate it before signing.");
      return;
    }

    try {
      setSignStatus(`Requesting ${connected.name} signature…`);
      const witnessCbor = await connected.api.signTx(tx.unsignedTxCbor.trim(), true);
      const signature: SignatureRecord = {
        signerKeyHash: connected.keyHash?.toLowerCase() || `unknown-${connected.id}`,
        matchStatus: connected.keyHash ? "matched" : "unmatched",
        signerName: connected.keyHash ? connected.keyHash.toLowerCase() : connected.name,
        walletName: connected.name,
        witnessCbor,
        signedAt: nowIso(),
      };
      const next = txs.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              signatures: mergeSignatures(item.signatures || [], [signature]),
              updatedAt: nowIso(),
            }
          : item,
      );
      setTxs(next);
      setSignStatus(
        connected.keyHash
          ? "Signature added. It will be delivered automatically."
          : "Signature added, but its signer could not be verified. It will not count until the signer is recognized.",
      );
      toast.success("Signature captured", {
        description: connected.keyHash ? "Signature progress was updated." : "The signer could not be verified.",
      });
    } catch (error) {
      setSignStatus(userFacingError(error, "The wallet did not approve the signature."));
      toast.error("Wallet refused to sign", {
        description: userFacingError(error, "The signing request was cancelled or rejected."),
      });
    }
  }

  async function copyInvite(tx: TxDraft) {
    try {
      const relayRoom = await ensureRelayRoom(tx);
      if (!relayRoom.sharedInviteUrl) throw new Error("The signer link could not be found.");
      await navigator.clipboard.writeText(relayRoom.sharedInviteUrl);
      setSignStatus("Signer link copied. Send the same link privately to every signer; progress updates automatically.");
      toast.success("Signer link copied", {
        description: "Send the same link to every signer.",
      });
    } catch (error) {
      setSignStatus(userFacingError(error, "The signer link could not be created."));
      toast.error("Could not copy signer link", {
        description: userFacingError(error, "The signer link could not be created."),
      });
    }
  }

  async function copySignatures(tx: TxDraft) {
    await navigator.clipboard.writeText(createSignaturePackage(tx.id, tx.signatures || []));
    setSignStatus("Signature backup copied.");
    toast.success("Signature backup copied");
  }

  async function submitTransaction(tx: TxDraft) {
    if (!wallet) {
      setSignStatus("Wallet not loaded, so the signed transaction cannot be assembled yet.");
      return;
    }
    if (tx.txHash) {
      setSignStatus(`Submission already recorded for this transaction: ${tx.txHash}`);
      return;
    }
    if (txPhase(tx) !== "ready") {
      setSignStatus("Collect the required signatures before submitting this transaction.");
      return;
    }
    if (!providerStatus?.services.submit) {
      setSignStatus("Transaction submission is not available right now.");
      return;
    }

    try {
      if (!account.authenticated || !account.session) {
        throw new Error("Sign in with a wallet before submitting a transaction.");
      }
      setSignStatus(`Submitting signed transaction to ${providerStatus.network}…`);
      const signedTxCbor = await buildSignedTxCbor(wallet, tx);
      const response = await fetch("/api/cardano/submit", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cardano-multisig-csrf": account.session.csrfToken,
        },
        body: JSON.stringify({ signedTxCbor, network: tx.network }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        throw new Error(body.error || "Could not submit transaction.");
      }

      const next = txs.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              txHash: String(body.txHash || ""),
              status: "succeeded" as const,
              failureReason: undefined,
              relayRoom: item.relayRoom
                ? {
                    ...item.relayRoom,
                    status: "submitted" as const,
                    lastSyncAt: nowIso(),
                  }
                : item.relayRoom,
              updatedAt: nowIso(),
            }
          : item,
      );
      setTxs(next);
      let relayNote = "";
      if (tx.relayRoom?.coordinatorToken) {
        const relayResponse = await fetch("/api/cardano/relay-room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: "submit", token: tx.relayRoom.coordinatorToken, txHash: String(body.txHash || "") }),
        });
        const relayBody = (await relayResponse.json()) as { ok?: boolean; error?: string };
        if (!relayResponse.ok || !relayBody.ok) {
          relayNote = relayBody.error ? ` Relay room update failed: ${relayBody.error}` : " Relay room update failed.";
        }
      }
      setSignStatus(`Submitted on ${body.network}. Tx hash: ${body.txHash}.${relayNote}`.trim());
      toast.success("Transaction submitted", {
        description: String(body.txHash || ""),
      });
    } catch (error) {
      const message = userFacingError(error, "We could not submit the transaction.");
      const next = txs.map((item) =>
        item.id === tx.id
          ? {
              ...item,
              status: "failed" as const,
              failureReason: message,
              updatedAt: nowIso(),
            }
          : item,
      );
      setTxs(next);
      setSignStatus(message);
      toast.error("Submit failed", {
        description: message,
      });
    }
  }

  function importReturnedSignatures() {
    try {
      const { draftId, signatures } = parseSignaturePackage(signaturePackageInput);
      if (!signatures.length) throw new Error("The signature package does not contain any signatures.");
      let found = false;
      const next = txs.map((tx) => {
        if (tx.id !== draftId) return tx;
        found = true;
        const verifiedSignatures = verifySignatureRecordsForDraft(tx, signatures);
        return { ...tx, signatures: mergeSignatures(tx.signatures || [], verifiedSignatures), updatedAt: nowIso() };
      });
      if (!found) throw new Error("This signature package belongs to a different transaction room.");
      setTxs(next);
      setSignaturePackageInput("");
      setSignStatus(`Imported ${signatures.length} signature${signatures.length === 1 ? "" : "s"} into the coordinator view.`);
      toast.success("Signature backup imported", {
        description: `${signatures.length} signature${signatures.length === 1 ? "" : "s"} merged.`,
      });
    } catch (error) {
      setSignStatus(userFacingError(error, "The signature backup is not valid."));
      toast.error("Invalid signature backup", {
        description: userFacingError(error, "The signature backup could not be read."),
      });
    }
  }

  function discardUnmatchedSignatures(txId: string) {
    const next = txs.map((tx) =>
      tx.id === txId ? { ...tx, signatures: removeUnmatchedSignatures(tx), updatedAt: nowIso() } : tx,
    );
    setTxs(next);
    setSignStatus("Unmatched witness packages removed from this transaction.");
    toast("Unmatched witnesses removed");
  }

  function saveHandle() {
    if (!wallet) return;
    const clean = handleInput.trim().replace(/^\$/, "");
    const label = nameInput.trim() || wallet.name || (clean ? `$${clean}` : "Imported wallet");
    const next = wallets.map((item) => (item.id === wallet.id ? { ...item, name: label, handle: clean || undefined } : item));
    setWallets(next);
    void refreshAssets({ ...wallet, name: label, handle: clean || undefined });
  }

  async function deleteCurrentWallet() {
    if (!wallet || deletingWallet) return;
    if (allWalletTxs.length) {
      toast.error("Wallet has saved transactions", {
        description: "Remove its transaction drafts before deleting this wallet.",
      });
      return;
    }

    const nextWallets = wallets.filter((item) => item.id !== wallet.id);
    const nextPreferences = accountState?.preferences.preferredWalletId === wallet.id
      ? { ...accountState.preferences, preferredWalletId: undefined }
      : undefined;
    setDeletingWallet(true);
    setSignStatus("");
    try {
      await saveServerState({
        wallets: nextWallets,
        transactions: txs,
        ...(nextPreferences ? { preferences: nextPreferences } : {}),
      });
      setDeleteDialogOpen(false);
      toast.success("Wallet deleted", {
        description: `${wallet.name || wallet.id} was removed from your account.`,
      });
      navigate("/wallets", { replace: true });
    } catch (error) {
      const message = userFacingError(error, "We could not delete this wallet.");
      setSignStatus(message);
      toast.error("Could not delete wallet", { description: message });
    } finally {
      setDeletingWallet(false);
    }
  }

  async function copyAssetUnit(asset: AssetOption) {
    await navigator.clipboard.writeText(asset.unit);
    toast.success("Asset unit copied", {
      description: asset.label,
    });
  }

  async function refreshAssets(target = wallet) {
    if (!target) return;
    const requestId = ++assetRequestIdRef.current;
    setResolvedHandle(null);
    setHandleConflict("");
    setAssetStatus("Loading multisig assets from the configured Cardano provider…");
    try {
      const result = await fetchWalletAssets(target);
      if (requestId !== assetRequestIdRef.current) return;
      setWalletAssets(result.assets);
      setResolvedHandle(result.handle || null);
      const savedHandle = handleCandidate(target);
      const resolvedName = result.handle?.name.trim().replace(/^\$/, "").toLowerCase() || "";
      setHandleConflict(
        savedHandle && resolvedName && savedHandle !== resolvedName
          ? `Saved identity $${savedHandle} does not match this payment policy. The policy address resolves to $${resolvedName}.`
          : "",
      );
      if (!target.paymentScript && result.recoveredScript?.paymentScript) {
        const recoveredPayment = result.recoveredScript.paymentScript;
        const recoveredSigners = recoveredPaymentSigners(recoveredPayment, target.signers || []);
        setWallets((current) => current.map((item) => item.id === target.id && !item.paymentScript
          ? {
              ...item,
              handle: item.handle || result.handle?.name,
              threshold: requiredSignatures(recoveredPayment),
              signers: recoveredSigners,
              paymentScript: recoveredPayment,
              script: recoveredPayment,
              imported: true,
              discovery: item.discovery ? { ...item.discovery, kind: "script" } : item.discovery,
            }
          : item));
        if (result.handle) setHandleInput(result.handle.name);
        toast.success("Native script recovered", {
          description: "This wallet is no longer watch-only. Its payment policy was verified against the on-chain address.",
        });
      } else if (result.handle && !target.handle) {
        setWallets((current) => current.map((item) => item.id === target.id ? { ...item, handle: result.handle!.name } : item));
        setHandleInput(result.handle.name);
      }
      const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : "";
      setAssetStatus(
        result.assets.length
          ? `${prefix}Loaded ${result.assets.length} multisig asset${result.assets.length === 1 ? "" : "s"} from ${result.source || "server"}.`
          : `${prefix}No spendable multisig assets found yet.`,
      );
    } catch (error) {
      if (requestId !== assetRequestIdRef.current) return;
      setWalletAssets([]);
      setAssetStatus(userFacingError(error, "We could not load wallet assets."));
    }
  }

  if (!wallet) {
    return (
      <div className="flex flex-col gap-6">
        <Link className="text-sm text-sky-300" to="/wallets">
          ← Back
        </Link>
        <Card className="glass-panel">
          <CardContent className="p-8 text-slate-300">Wallet not found in your account. Return to the wallet list and try again.</CardContent>
        </Card>
      </div>
    );
  }

  const pending = walletTxs.filter((tx) => txPhase(tx) === "pending").length;
  const ready = walletTxs.filter((tx) => txPhase(tx) === "ready").length;
  const submitted = walletTxs.filter((tx) => txPhase(tx) === "submitted").length;
  const assetColumns: ColumnDef<AssetOption>[] = [
    {
      header: "Asset",
      cell: ({ row }) => {
        const asset = row.original;
        const isAda = asset.unit === "lovelace";
        return (
          <div className="flex min-w-0 items-center gap-3">
            <AssetThumb asset={asset} className="size-10" />
            <div className="min-w-0">
              <div className="truncate font-medium text-foreground" title={asset.label}>{asset.label}</div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{assetSubtitle(asset)}</div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant={isAda ? "secondary" : "outline"} className="max-w-32 truncate text-[10px]">
                  {isAda ? "ADA" : "native asset"}
                </Badge>
                {asset.outputCount ? (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    {asset.outputCount} UTxO{asset.outputCount === 1 ? "" : "s"}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "balance",
      header: () => <div className="text-right">Balance</div>,
      cell: ({ row }) => {
        const asset = row.original;
        const quantity = formatRawQuantity(asset.quantity, asset.unit, asset.decimals);
        return (
          <div className="truncate text-right font-mono text-sm font-semibold tabular-nums text-foreground" title={quantity}>
            {quantity}
          </div>
        );
      },
    },
    {
      id: "unit",
      header: () => <div className="text-right">Unit</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="icon-sm" title={row.original.unit} onClick={() => void copyAssetUnit(row.original)} aria-label={`Copy ${row.original.label} unit`}>
            <Copy className="size-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4 overflow-x-hidden sm:gap-6">
      <section className="min-w-0 rounded-xl border border-white/8 bg-[#121214] p-4 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.95)] sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link to="/wallets" className="inline-flex items-center gap-2 text-sm text-sky-300 transition hover:text-sky-200">
              <ArrowLeft className="size-4" /> Back to wallets
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">
                {wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name}
              </h1>
              <Badge variant="outline" className="border-white/10 text-zinc-400">{wallet.network}</Badge>
              <Badge variant={isWatchOnly ? "outline" : "secondary"} className={isWatchOnly ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : ""}>
                {isWatchOnly ? "watch-only" : `${wallet.threshold}-of-${wallet.signers.length}`}
              </Badge>
            </div>
            <p className="mt-2 max-w-5xl text-sm leading-6 text-slate-400">
              {isWatchOnly ? (
                <span className="break-all">{wallet.discovery?.address}</span>
              ) : (
                <>
                  payment {summarizeScript(wallet.paymentScript)} · stake {summarizeScript(wallet.stakeScript)}
                </>
              )}
            </p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-zinc-300">
                {walletTxs.length} transaction{walletTxs.length === 1 ? "" : "s"}
              </span>
              {pending ? (
                <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-amber-200">
                  {pending} need signature{pending === 1 ? "" : "s"}
                </span>
              ) : null}
              {ready ? (
                <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-emerald-200">
                  {ready} ready
                </span>
              ) : null}
              {submitted ? (
                <span className="rounded-md border border-sky-400/20 bg-sky-400/10 px-2 py-1 text-sky-200">
                  {submitted} submitted
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 max-sm:w-full max-sm:justify-start">
            {isWatchOnly ? (
              <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-200">native script not imported</Badge>
            ) : (
              <Button asChild className="max-sm:flex-1">
                <Link to={`/wallets/${encodeURIComponent(wallet.id)}/transactions/new`}>
                  <Plus className="size-4" /> Create transaction
                </Link>
              </Button>
            )}
            <Button type="button" variant="destructive" className="max-sm:flex-1" onClick={() => setDeleteDialogOpen(true)}>
              <Trash2 className="size-4" /> Delete wallet
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={deleteDialogOpen} onOpenChange={(open) => !deletingWallet && setDeleteDialogOpen(open)}>
        <DialogContent className="max-w-lg" onClose={() => !deletingWallet && setDeleteDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>Delete this wallet?</DialogTitle>
            <DialogDescription>
              This permanently removes {wallet.name || wallet.id} from your synced account. The native script can be imported again later.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {allWalletTxs.length ? (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                This wallet has {allWalletTxs.length} saved transaction{allWalletTxs.length === 1 ? "" : "s"}. Remove those drafts before deleting the wallet.
              </div>
            ) : (
              <div className="rounded-lg border border-white/8 bg-black/20 p-3 text-sm text-zinc-400">
                Wallet ID: <span className="break-all font-mono text-zinc-200">{wallet.id}</span>
              </div>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deletingWallet}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void deleteCurrentWallet()} disabled={deletingWallet || allWalletTxs.length > 0}>
                <Trash2 className="size-4" /> {deletingWallet ? "Deleting…" : "Delete wallet"}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {connectWarning ? (
        <Card>
          <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground">
          <AlertTriangle />
          <span>{connectWarning}</span>
          </CardContent>
        </Card>
      ) : null}
      {handleConflict ? (
        <Card className="border-rose-400/30 bg-rose-400/10">
          <CardContent className="flex gap-3 p-4 text-sm text-rose-100">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{handleConflict} Fix the saved identity or import the policy that belongs to the intended Handle before creating a transaction.</span>
          </CardContent>
        </Card>
      ) : null}
      {isWatchOnly ? (
        <Card>
          <CardContent className="flex gap-3 p-4 text-sm text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0" />
            <span>This wallet was imported from an address or ADA Handle. It can show visible assets, but transaction creation and signing need the native script or wallet export.</span>
          </CardContent>
        </Card>
      ) : null}
      {signStatus ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">{signStatus}</CardContent>
        </Card>
      ) : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <AppWindow title="Transactions" contentClassName="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-zinc-50">Transactions</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Open what needs attention or share a pending transaction with the remaining signers.
                </p>
              </div>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                {archivedTransactionCount ? (
                  <Button type="button" variant="ghost" size="sm" className="max-sm:flex-1" onClick={() => setShowArchivedTransactions((current) => !current)}>
                    {showArchivedTransactions ? "Hide" : "Show"} archived ({archivedTransactionCount})
                  </Button>
                ) : null}
                {relaySync.status === "failed" ? (
                  <Button type="button" variant="secondary" size="sm" className="max-sm:flex-1" onClick={() => void refreshRelayRooms()} disabled={!relayDraftsForWallet().length}>
                    <RefreshCw className="size-4" /> Try again
                  </Button>
                ) : null}
              </div>
            </div>
            {relaySync.status === "failed" ? (
              <div className="rounded-lg border border-rose-400/25 bg-rose-400/10 p-3 text-sm text-rose-100">
                We could not refresh signature progress. The current information is still visible; try again in a moment.
              </div>
            ) : null}
              {walletTxs.length === 0 ? (
                <div className="rounded-lg border border-white/7 bg-black/20 p-4 text-sm text-zinc-400">
                  {isWatchOnly
                    ? "This is a watch-only wallet. Import the native script or wallet export to create transactions and collect signatures."
                    : "No transactions yet. Create one to start collecting signatures."}
                </div>
              ) : (
                walletTxs.map((tx) => {
                  const phase = txPhase(tx);
                  const signed = signatureCount(tx);
                  const unmatched = unmatchedSignatureCount(tx);
                  const missing = requiredPendingSignerKeyHashes(tx);
                  const optional = optionalSignerKeyHashes(tx);
                  const highlighted = draftIdFromQuery === tx.id;
                  const canSign = Boolean(tx.unsignedTxCbor?.trim());
                  const signerStatus = connectedSignerStatus(tx, connected?.keyHash);
                  const pending = pendingSignatureCount(tx);
                  const expanded = expandedTransactions[tx.id] ?? (highlighted || pending > 0);
                  return (
                    <Collapsible
                      key={tx.id}
                      open={expanded}
                      onOpenChange={(open) =>
                        setExpandedTransactions((current) => ({ ...current, [tx.id]: open }))
                      }
                      className={cn(
                        "min-w-0 overflow-hidden rounded-xl border p-4",
                        highlighted ? "border-sky-400/50 bg-sky-400/10" : "border-white/7 bg-white/[0.02]",
                      )}
                    >
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-1 gap-3">
                          <Avatar label={tx.title} tone={phase === "submitted" || phase === "ready" ? "success" : "primary"} />
                          <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              to={`/transactions/${encodeURIComponent(tx.id)}`}
                              className="break-words text-lg font-semibold text-zinc-50 underline-offset-4 hover:text-sky-200 hover:underline"
                            >
                              {tx.title}
                            </Link>
                            <Badge variant={phaseBadge(phase)}>{phaseLabel(phase)}</Badge>
                            {tx.archivedAt ? <Badge variant="outline">archived</Badge> : null}
                            {highlighted ? <Badge variant="outline">new</Badge> : null}
                          </div>
                          <div className="mt-1 break-all text-sm text-zinc-400">{tx.recipient || "No recipient address saved"}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                            <span className={cn("font-medium", phase === "submitted" ? "text-emerald-300" : nextActionLabel(tx, connected?.keyHash) === "Your signature is needed" ? "text-amber-200" : "text-sky-200")}>
                              {nextActionLabel(tx, connected?.keyHash)}
                            </span>
                            <span>{signed}/{tx.requiredSignatures} matched signatures</span>
                            <span>{pending} still needed</span>
                            {pending === 0 && optional.length ? (
                              <span className="text-emerald-300">{optional.length} optional signer{optional.length === 1 ? "" : "s"} unsigned</span>
                            ) : null}
                            {unmatched ? <span className="text-amber-300">{unmatched} unmatched signature{unmatched === 1 ? "" : "s"}</span> : null}
                            {tx.txHash ? <span className="text-emerald-300">tx {shortHash(tx.txHash)}</span> : null}
                          </div>
                          </div>
                        </div>
                        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 text-sm text-zinc-300 sm:w-auto sm:justify-end">
                          <span className="flex items-center gap-2">{phaseIcon(phase)} {new Date(tx.createdAt).toLocaleString()}</span>
                          <CollapsibleTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" aria-label={`${expanded ? "Collapse" : "Expand"} transaction ${tx.title}`}>
                              {expanded ? "Hide details" : "Show details"}
                              <ChevronDown className={cn("size-4 transition-transform", expanded ? "rotate-180" : "")} />
                            </Button>
                          </CollapsibleTrigger>
                        </div>
                      </div>

                      <CollapsibleContent>
                      <div className="mt-4 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-zinc-400">
                          <span>Required signatures</span>
                          <span>{signed} / {tx.requiredSignatures}</span>
                        </div>
                        <Progress value={signed} max={tx.requiredSignatures} />
                      </div>

                      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div className="min-w-0 space-y-3">
                          <div>
                              <div className="text-xs uppercase text-zinc-500">Assets</div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {(tx.assets?.length ? tx.assets : [{ label: "ADA", quantity: tx.lovelace || "0", unit: "lovelace", id: "ada", decimals: 6 } as AssetLine]).map((asset) => (
                                <div key={asset.id} className="max-w-full break-words rounded-full border border-white/8 px-3 py-1 text-sm text-zinc-200">
                                  {formatRawQuantity(asset.quantity, asset.unit, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0))}
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-3">
                            {tx.signerKeyHashes.map((keyHash) => {
                              const hasSigned = hasMatchedSignature(tx, keyHash);
                              const signer = signerDisplay(wallet, keyHash, connected?.keyHash);
                              const handleLabel = signerHandleLabel(signerHandles[normalizeKeyHash(keyHash)]);
                              const signature = tx.signatures.find(
                                (item) => normalizeKeyHash(item.matchedSignerKeyHash || item.signerKeyHash || "") === normalizeKeyHash(keyHash),
                              );
                              return (
                                <div
                                  key={keyHash}
                                  className={cn(
                                    "flex min-w-0 items-center justify-between gap-3 overflow-hidden rounded-lg border p-3",
                                    hasSigned ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/7 bg-black/20",
                                  )}
                                >
                                  <div className="flex min-w-0 items-center gap-3">
                                    <Avatar label={signer.label} tone={hasSigned ? "success" : "muted"} />
                                    <div className="min-w-0">
                                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                                        <span className="font-semibold text-zinc-50">{signer.label}</span>
                                        {handleLabel ? (
                                          <Badge variant="outline" className="border-sky-400/25 bg-sky-400/10 text-sky-200" title="ADA Handle associated with this signer">{handleLabel}</Badge>
                                        ) : null}
                                        {signer.isConnected ? (
                                          <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">you · connected</Badge>
                                        ) : null}
                                      </div>
                                      <div className="truncate font-mono text-xs text-zinc-500" title={keyHash}>{shortHash(keyHash)}</div>
                                      {signature ? (
                                        <div className="mt-1 text-xs text-emerald-300">
                                          signed {relativeTime(signature.signedAt)}{signature.walletName ? ` · ${signature.walletName}` : ""}
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div
                                    className={cn(
                                      "flex size-9 shrink-0 items-center justify-center rounded-full border",
                                      hasSigned ? "border-emerald-400 text-emerald-300" : "border-white/10 text-transparent",
                                    )}
                                  >
                                    <Check className="size-4" />
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          <div className="rounded-lg border border-white/7 bg-black/20 p-3">
                              <div className="text-xs uppercase text-zinc-500">Next coordinator step</div>
                              <div className="mt-2 text-sm text-zinc-200">
                                {phase === "submitted"
                                  ? "Submission already recorded for this transaction."
                                    : missing.length
                                      ? tx.relayRoom
                                        ? "Share the signer link with the remaining people. Their signatures will appear here automatically."
                                        : "Create a signer link and send it privately to the remaining people."
                                    : providerStatus?.services.submit
                                      ? "All required signatures are present. Submission runs automatically."
                                      : "All required signatures are present. Submission is not currently available."}
                              </div>
                          </div>

                          {phase === "ready" && providerStatus?.services.submit ? (
                            <Card>
                              <CardContent className="p-4">
                                <div className="font-medium text-foreground">Ready to submit</div>
                                <div className="mt-1 text-sm text-muted-foreground">All required signatures are present. Submission completes automatically; use Advanced recovery only if it does not finish.</div>
                              </CardContent>
                            </Card>
                          ) : null}

                          {unmatched ? (
                            <Card>
                              <CardContent className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-4 text-sm text-muted-foreground">
                                <span>{unmatched} signature{unmatched === 1 ? " was" : "s were"} captured but did not match a policy signer key hash and will not count toward submit.</span>
                                <Button size="sm" variant="secondary" onClick={() => discardUnmatchedSignatures(tx.id)}>
                                  <Trash2 className="size-4" /> Remove unmatched
                                </Button>
                              </CardContent>
                            </Card>
                          ) : null}

                          {tx.failureReason && !tx.txHash ? (
                            <Card className="border-destructive/50">
                              <CardContent className="p-4 text-sm text-destructive">Last submit attempt failed: {tx.failureReason}</CardContent>
                            </Card>
                          ) : null}

                          {tx.txHash ? (
                            <Card>
                              <CardContent className="p-4">
                                <div className="font-medium text-foreground">Transaction submitted</div>
                                <div className="mt-3 flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                                  <code className="block min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-foreground" title={tx.txHash}>
                                    {tx.txHash}
                                  </code>
                                  <div className="flex shrink-0 flex-wrap gap-2">
                                    <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(tx.txHash || "")}>
                                      <Copy className="size-4" /> Copy
                                    </Button>
                                    <Button asChild size="sm" variant="outline">
                                      <a href={explorerTxUrl(tx.network, tx.txHash)} target="_blank" rel="noreferrer">
                                        Open explorer
                                      </a>
                                    </Button>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          ) : null}

                          {!canSign ? (
                            <Card>
                              <CardContent className="p-4 text-sm text-muted-foreground">This transaction is incomplete. Recreate it before asking signers to approve it.</CardContent>
                            </Card>
                          ) : null}
                        </div>

                        <div className="min-w-0 space-y-2">
                          <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void copyInvite(tx)} disabled={phase === "submitted"}>
                            <Copy className="size-4" /> {tx.relayRoom ? "Share with signers" : "Create signer link"}
                          </Button>
                          <Button
                            className="h-auto min-h-10 w-full whitespace-normal px-3 py-2"
                            variant="secondary"
                            onClick={() => void signTransaction(tx)}
                            disabled={!canSign || phase === "submitted" || signerStatus === "not-signer" || signerStatus === "signed"}
                          >
                            <ShieldCheck className="size-4" />
                            {signerStatus === "signed"
                              ? "You already signed"
                              : signerStatus === "not-signer"
                                ? "Connected wallet is not a signer"
                                : signerStatus === "not-connected"
                                  ? "Connect a signer wallet"
                                  : "Sign this transaction"}
                          </Button>
                          <Collapsible className="rounded-lg border border-white/8 bg-black/20">
                            <CollapsibleTrigger asChild>
                              <Button type="button" variant="ghost" className="h-auto min-h-10 w-full justify-between whitespace-normal px-3 py-2">
                                Advanced recovery <ChevronDown className="size-4" />
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="space-y-2 border-t border-white/8 p-2">
                              <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void copySignatures(tx)} disabled={!tx.signatures?.length}>
                                <Copy className="size-4" /> Copy signature backup
                              </Button>
                              <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void submitTransaction(tx)} disabled={phase !== "ready" || !providerStatus?.services.submit}>
                                <ShieldCheck className="size-4" /> Submit manually
                              </Button>
                            </CollapsibleContent>
                          </Collapsible>
                        </div>
                      </div>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })
              )}
          </AppWindow>
        </div>

        <div className="min-w-0 space-y-6">
          {!isWatchOnly ? (
            <Collapsible>
              <Card className="glass-panel">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>Advanced signature recovery</CardTitle>
                      <CardDescription>Use this only when automatic signature delivery is unavailable.</CardDescription>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button type="button" variant="ghost" size="sm"><ChevronDown className="size-4" /> Open</Button>
                    </CollapsibleTrigger>
                  </div>
                </CardHeader>
                <CollapsibleContent>
                  <CardContent className="space-y-3 border-t border-border pt-4">
                    <p className="text-sm text-muted-foreground">Paste a returned signature backup. Valid signatures are verified, merged into the transaction, and saved to your account.</p>
                    <Textarea
                      className="min-h-48 min-w-0 font-mono text-sm text-slate-100"
                      value={signaturePackageInput}
                      onChange={(event) => setSignaturePackageInput(event.target.value)}
                      placeholder="Paste signature backup JSON here"
                    />
                    <Button className="w-full" onClick={importReturnedSignatures}>
                      <FileUp className="size-4" /> Import signature backup
                    </Button>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          ) : null}

          <Card className="glass-panel">
            <CardHeader>
              <CardTitle>Wallet identity</CardTitle>
              <CardDescription>Rename the local label or resolve the treasury ADA Handle so balances come from the exact multisig address.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="space-y-2">
                <Label>Local label</Label>
                <Input value={nameInput} onChange={(event) => setNameInput(event.target.value)} placeholder="Treasury wallet" />
              </div>
              <div className="space-y-2">
                <Label>ADA Handle</Label>
                <Input value={handleInput} onChange={(event) => setHandleInput(event.target.value)} placeholder="$discatalyst" />
              </div>
              <Button variant="secondary" onClick={saveHandle}>Save identity</Button>
              {resolvedHandle && !handleConflict ? (
                <div className="break-all rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                  Resolved {handleLabel(resolvedHandle)} → {resolvedHandle.address}
                </div>
              ) : handleConflict ? (
                <div className="break-all rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
                  {handleConflict}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="glass-panel overflow-hidden">
            <CardHeader className="border-b border-border">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle>Multisig assets</CardTitle>
                  <CardDescription>
                    {isWatchOnly
                      ? "Fetched directly from the saved address. Import the native script when this needs to become an active multisig wallet."
                      : resolvedHandle && !handleConflict
                      ? `ADA Handle ${handleLabel(resolvedHandle)} resolved to this multisig script address.`
                      : "Fetched from the server-managed Cardano provider for this script wallet."}
                  </CardDescription>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void refreshAssets()}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-4 sm:p-5">
              {walletAssets.length === 0 ? (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  <Database className="mr-2 inline size-4 text-sky-300" /> {assetStatus}
                </div>
              ) : (
                <DataTable columns={assetColumns} data={walletAssets} emptyLabel={assetStatus} />
              )}
              <div className="mt-3 text-xs text-muted-foreground">{assetStatus}</div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
