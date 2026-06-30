import { Link, useSearchParams, useParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  FileUp,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { cn } from "../lib/utils";
import { notifyAppStorageChanged, useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import {
  type MultisigWallet as Wallet,
  type NativeScript,
  type RelayRoomRef,
  type SignatureRecord,
  type TxDraft,
  STORAGE_KEY as WALLET_KEY,
  TX_STORAGE_KEY as TX_KEY,
  createSignaturePackage,
  decodeInvite,
  expectedNetworkId,
  formatTargetNetwork,
  hasMatchedSignature,
  mergeSignatures,
  networkLabel,
  nowIso,
  normalizeKeyHash,
  optionalSignerKeyHashes,
  parseSignaturePackage,
  pendingSignatureCount,
  removeUnmatchedSignatures,
  requiredPendingSignerKeyHashes,
  signatureCount,
  summarizeScript,
  unmatchedSignatureCount,
} from "../lib/multisig";
import {
  type RelayRoomCoordinatorView,
  type RelayRoomCreateResponse,
  type RelayRoomSessionResponse,
  applyRelayRoomToDraft,
} from "../lib/relay-room";
import { verifySignatureRecordsForDraft } from "../lib/witness-verification";

type AssetLine = { id: string; unit: string; label: string; quantity: string; decimals?: number };
type AssetOption = { unit: string; label: string; quantity: string; outputCount?: number; decimals?: number };
type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };
type AssetFetch = { assets: AssetOption[]; handle?: HandleInfo | null; source?: string; address?: string; outputs?: number };
type TxPhase = "pending" | "ready" | "submitted";

export function meta() {
  return [{ title: "Wallet · Cardano Multisig" }];
}

function readArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeArray<T>(key: string, value: T[]) {
  window.localStorage.setItem(key, JSON.stringify(value, null, 2));
  notifyAppStorageChanged();
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
  const base = tx.relayRoom ? stripRelayRoomSecrets(tx) : tx;
  const sessionRelayRoom = readRelaySessionRooms()[tx.id];
  return sessionRelayRoom ? { ...base, relayRoom: { ...base.relayRoom, ...sessionRelayRoom } } : base;
}

function stripRelayRoomSecrets(tx: TxDraft): TxDraft {
  if (!tx.relayRoom) return tx;
  const { roomId, createdAt, lastSyncAt, status } = tx.relayRoom;
  return {
    ...tx,
    relayRoom: {
      roomId,
      createdAt,
      lastSyncAt,
      status,
    } as RelayRoomRef,
  };
}

function writeTransactions(value: TxDraft[]) {
  writeArray(TX_KEY, value.map(stripRelayRoomSecrets));
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
  if (status === "ready") return "ready to submit";
  return status;
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
    return { assets: body.assets || [], handle: body.handle, source: body.source, address: body.address, outputs: body.outputs };
  }

  const { patterns, stakeAddress } = await walletResolution(wallet);
  const query = assetQuery(patterns, wallet, stakeAddress);
  if (!query) throw new Error("Could not derive wallet script hash or ADA Handle.");
  const response = await fetch(`/api/cardano/assets?${query}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load multisig assets.");
  return { assets: body.assets || [], handle: body.handle, source: body.source, address: body.address, outputs: body.outputs };
}

function signerLabel(wallet: Wallet, keyHash: string) {
  const signer = wallet.signers.find((item) => item.keyHash.toLowerCase() === keyHash.toLowerCase());
  return signer?.label || `${keyHash.slice(0, 10)}…`;
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
  const [searchParams] = useSearchParams();
  const { providers, connected, providerStatus } = useAppShell();

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [txs, setTxs] = useState<TxDraft[]>([]);
  const [signStatus, setSignStatus] = useState("");
  const [walletAssets, setWalletAssets] = useState<AssetOption[]>([]);
  const [resolvedHandle, setResolvedHandle] = useState<HandleInfo | null>(null);
  const [handleInput, setHandleInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [assetStatus, setAssetStatus] = useState("Loading multisig assets…");
  const [signaturePackageInput, setSignaturePackageInput] = useState("");

  useEffect(() => {
    setWallets(readArray<Wallet>(WALLET_KEY));
    setTxs(readArray<TxDraft>(TX_KEY).map(hydrateRelayRoomSession));
  }, []);

  const wallet = wallets.find((item) => item.id === walletId);
  const draftIdFromQuery = searchParams.get("draft");

  useEffect(() => {
    if (wallet) {
      setHandleInput(wallet.handle || "");
      setNameInput(wallet.name || "");
    }
  }, [wallet?.id]);

  const walletTxs = useMemo(() => {
    return txs
      .filter((tx) => tx.walletId === walletId || (!tx.walletId && wallet && tx.walletName === wallet.name))
      .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  }, [txs, wallet, walletId]);
  const isWatchOnly = wallet ? !wallet.paymentScript && Boolean(wallet.discovery?.address) : false;

  useEffect(() => {
    if (wallet) void refreshAssets(wallet);
  }, [wallet?.id]);

  const relaySyncKey = useMemo(
    () =>
      txs
        .filter(
          (tx) =>
            tx.walletId === walletId &&
            tx.relayRoom?.coordinatorToken &&
            (tx.relayRoom.status || "open") === "open" &&
            !tx.txHash,
        )
        .map((tx) => `${tx.id}:${tx.relayRoom!.coordinatorToken}:${tx.relayRoom!.status || "open"}`)
        .join("|"),
    [txs, walletId],
  );

  useEffect(() => {
    const relayDrafts = txs.filter(
      (tx) =>
        tx.walletId === walletId &&
        tx.relayRoom?.coordinatorToken &&
        (tx.relayRoom.status || "open") === "open" &&
        !tx.txHash,
    ) as Array<TxDraft & { relayRoom: RelayRoomRef & { coordinatorToken: string } }>;
    if (!relayDrafts.length) return;

    let cancelled = false;
    const sync = async () => {
      const updates = await Promise.all(
        relayDrafts.map(async (tx) => {
          try {
            const room = await fetchRelayCoordinatorRoom(tx.relayRoom!.coordinatorToken);
            return { txId: tx.id, room };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const byId = new Map(updates.filter(Boolean).map((entry) => [entry!.txId, entry!.room]));
      if (!byId.size) return;
      setTxs((current) => {
        let changed = false;
        const next = current.map((tx) => {
          const room = byId.get(tx.id);
          if (!room) return tx;
          const updated = applyRelayRoomToDraft(tx, room);
          const beforeSignatureIds = (tx.signatures || []).map((signature) => signature.relayWitnessId || signature.witnessCbor).join("|");
          const afterSignatureIds = (updated.signatures || []).map((signature) => signature.relayWitnessId || signature.witnessCbor).join("|");
          const txChanged =
            beforeSignatureIds !== afterSignatureIds ||
            tx.relayRoom?.status !== updated.relayRoom?.status ||
            tx.txHash !== updated.txHash;
          if (txChanged) changed = true;
          return txChanged ? updated : tx;
        });
        if (!changed) return current;
        writeTransactions(next);
        return next;
      });
    };

    void sync();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void sync();
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [relaySyncKey, walletId]);

  const connectWarning =
    connected && wallet && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(wallet.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this multisig wallet is on ${formatTargetNetwork(wallet.network)}.`
      : "";

  async function fetchRelayCoordinatorRoom(token: string) {
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "session", token }),
    });
    const body = (await response.json()) as RelayRoomSessionResponse | { ok: false; error?: string };
    if (!response.ok || !body.ok || body.role !== "coordinator") {
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
    if (!relayRoom.signerInvites?.length || !tx.signatures?.length) return;
    await Promise.all(
      tx.signatures
        .filter((signature) => signature.witnessCbor?.trim())
        .map(async (signature) => {
          const keyHash = normalizeKeyHash(signature.matchedSignerKeyHash || signature.signerKeyHash || "");
          const invite = relayRoom.signerInvites?.find((item) => normalizeKeyHash(item.keyHash) === keyHash);
          const token = invite ? relayTokenFromInviteUrl(invite.inviteUrl) : "";
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
    if (!wallet) throw new Error("Wallet not loaded in this browser.");
    if (tx.relayRoom?.coordinatorToken && tx.relayRoom.signerInvites?.length) {
      await syncExistingWitnessesToRelayRoom(tx, tx.relayRoom);
      return tx.relayRoom;
    }
    if (!tx.unsignedTxCbor.trim()) {
      throw new Error("This transaction has no unsigned tx CBOR yet, so a relay room cannot be created.");
    }
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
          assets: tx.assets || [],
          unsignedTxCbor: tx.unsignedTxCbor,
          requiredSignatures: tx.requiredSignatures,
          signerKeyHashes: tx.signerKeyHashes,
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
      createdAt: nowIso(),
      signerInvites: body.signerInvites,
      status: "open",
    };
    const next = txs.map((item) => (item.id === tx.id ? { ...item, relayRoom, updatedAt: nowIso() } : item));
    writeRelaySessionRoom(tx.id, relayRoom);
    setTxs(next);
    writeTransactions(next);
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
    if (!tx.unsignedTxCbor?.trim()) {
      setSignStatus("This transaction has no unsigned tx CBOR, so a wallet cannot sign it yet.");
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
      writeTransactions(next);
      setSignStatus(
        connected.keyHash
          ? "Signature captured. Copy the witness package for the coordinator or keep collecting signatures here."
          : "Signature captured, but the signer key hash could not be verified. The coordinator will see it as unmatched until they confirm the signer.",
      );
    } catch (error) {
      setSignStatus(error instanceof Error ? error.message : "Wallet refused to sign.");
    }
  }

  async function copyInvite(tx: TxDraft) {
    try {
      const relayRoom = await ensureRelayRoom(tx);
      const missing = requiredPendingSignerKeyHashes(tx);
      const nextKeyHash = missing[0] || optionalSignerKeyHashes(tx)[0] || tx.signerKeyHashes[0];
      const invite = relayRoom.signerInvites?.find((item) => item.keyHash.toLowerCase() === nextKeyHash.toLowerCase());
      if (!invite) throw new Error("Relay room exists, but the next signer invite could not be found.");
      await navigator.clipboard.writeText(invite.inviteUrl);
      setSignStatus(
        `Signer relay invite copied for ${invite.label || `${invite.keyHash.slice(0, 12)}…`}. Witnesses return automatically after signing.`,
      );
    } catch (error) {
      setSignStatus(
        error instanceof Error
          ? `${error.message} Short relay link was not copied.`
          : "Relay room unavailable. Short relay link was not copied.",
      );
    }
  }

  async function copySignatures(tx: TxDraft) {
    await navigator.clipboard.writeText(createSignaturePackage(tx.id, tx.signatures || []));
    setSignStatus("Witness package copied.");
  }

  async function submitTransaction(tx: TxDraft) {
    if (!wallet) {
      setSignStatus("Wallet not loaded in this browser, so the signed transaction cannot be assembled yet.");
      return;
    }
    if (tx.txHash) {
      setSignStatus(`Submission already recorded for this transaction: ${tx.txHash}`);
      return;
    }
    if (txPhase(tx) !== "ready") {
      setSignStatus("Collect all required witnesses before submitting this transaction.");
      return;
    }
    if (!providerStatus?.services.submit) {
      setSignStatus("Server-side submit is not enabled for this deployment yet.");
      return;
    }

    try {
      setSignStatus(`Submitting signed transaction to ${providerStatus.network}…`);
      const signedTxCbor = await buildSignedTxCbor(wallet, tx);
      const response = await fetch("/api/cardano/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
              updatedAt: nowIso(),
            }
          : item,
      );
      setTxs(next);
      writeTransactions(next);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not submit transaction.";
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
      writeTransactions(next);
      setSignStatus(message);
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
      writeTransactions(next);
      setSignaturePackageInput("");
      setSignStatus(`Imported ${signatures.length} signature${signatures.length === 1 ? "" : "s"} into the coordinator view.`);
    } catch (error) {
      setSignStatus(error instanceof Error ? error.message : "Invalid signature package.");
    }
  }

  function discardUnmatchedSignatures(txId: string) {
    const next = txs.map((tx) =>
      tx.id === txId ? { ...tx, signatures: removeUnmatchedSignatures(tx), updatedAt: nowIso() } : tx,
    );
    setTxs(next);
    writeTransactions(next);
    setSignStatus("Unmatched witness packages removed from this transaction.");
  }

  function saveHandle() {
    if (!wallet) return;
    const clean = handleInput.trim().replace(/^\$/, "");
    const label = nameInput.trim() || wallet.name || (clean ? `$${clean}` : "Imported wallet");
    const next = wallets.map((item) => (item.id === wallet.id ? { ...item, name: label, handle: clean || undefined } : item));
    setWallets(next);
    writeArray(WALLET_KEY, next);
    void refreshAssets({ ...wallet, name: label, handle: clean || undefined });
  }

  async function refreshAssets(target = wallet) {
    if (!target) return;
    setAssetStatus("Loading multisig assets from the configured Cardano provider…");
    try {
      const result = await fetchWalletAssets(target);
      setWalletAssets(result.assets);
      setResolvedHandle(result.handle || null);
      if (result.handle && !target.handle) {
        const next = wallets.map((item) => (item.id === target.id ? { ...item, handle: result.handle!.name } : item));
        setWallets(next);
        writeArray(WALLET_KEY, next);
        setHandleInput(result.handle.name);
      }
      const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : "";
      setAssetStatus(
        result.assets.length
          ? `${prefix}Loaded ${result.assets.length} multisig asset${result.assets.length === 1 ? "" : "s"} from ${result.source || "server"}.`
          : `${prefix}No spendable multisig assets found yet.`,
      );
    } catch (error) {
      setWalletAssets([]);
      setAssetStatus(error instanceof Error ? error.message : "Could not load multisig assets.");
    }
  }

  if (!wallet) {
    return (
      <div className="flex flex-col gap-6">
        <Link className="text-sm text-sky-300" to="/">
          ← Back
        </Link>
        <Card className="glass-panel">
          <CardContent className="p-8 text-slate-300">Wallet not found in this browser. Import or create it first.</CardContent>
        </Card>
      </div>
    );
  }

  const pending = walletTxs.filter((tx) => txPhase(tx) === "pending").length;
  const ready = walletTxs.filter((tx) => txPhase(tx) === "ready").length;
  const submitted = walletTxs.filter((tx) => txPhase(tx) === "submitted").length;

  return (
    <div className="flex flex-col gap-6">
      <section className="min-w-0 rounded-xl border border-white/8 bg-[#121214] p-5 shadow-[0_18px_50px_-38px_rgba(0,0,0,0.95)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link to="/" className="inline-flex items-center gap-2 text-sm text-sky-300 transition hover:text-sky-200">
              <ArrowLeft className="size-4" /> Back to wallets
            </Link>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 break-words text-3xl font-semibold tracking-tight text-slate-50">
                {resolvedHandle ? handleLabel(resolvedHandle) : wallet.name}
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
                  {resolvedHandle ? `${wallet.name} · ` : ""}
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
          <div className="flex shrink-0 justify-end max-sm:w-full max-sm:justify-start">
            {isWatchOnly ? (
              <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-200">native script not imported</Badge>
            ) : (
              <Link
                to={`/wallets/${encodeURIComponent(wallet.id)}/transactions/new`}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90 max-sm:w-full"
              >
                <Plus className="size-4" /> Create transaction
              </Link>
            )}
          </div>
        </div>
      </section>

      {connectWarning ? (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
          <AlertTriangle className="mr-2 inline size-4" /> {connectWarning}
        </div>
      ) : null}
      {isWatchOnly ? (
        <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
          <AlertTriangle className="mr-2 inline size-4" />
          This wallet was imported from an address or ADA Handle. It can show visible assets, but transaction creation and signing need the native script or wallet export.
        </div>
      ) : null}
      {signStatus ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{signStatus}</div> : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <AppWindow title="Transactions" contentClassName="space-y-4">
            <div>
              <h2 className="text-xl font-semibold text-zinc-50">Transactions</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Copy relay signer invites, watch returned witnesses merge automatically, and keep the manual witness package fallback available.
              </p>
            </div>
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
                  return (
                    <article
                      key={tx.id}
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
                            <h3 className="break-words text-lg font-semibold text-zinc-50">{tx.title}</h3>
                            <Badge variant={phaseBadge(phase)}>{phaseLabel(phase)}</Badge>
                            {highlighted ? <Badge variant="outline">new</Badge> : null}
                          </div>
                          <div className="mt-1 break-all text-sm text-zinc-400">{tx.recipient || "No recipient address saved"}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                            <span>{signed}/{tx.requiredSignatures} matched signatures</span>
                            <span>{pendingSignatureCount(tx)} still needed</span>
                            {tx.relayRoom ? <span className="text-sky-300">relay {tx.relayRoom.status || "open"}</span> : null}
                            {pendingSignatureCount(tx) === 0 && optional.length ? (
                              <span className="text-emerald-300">{optional.length} optional signer{optional.length === 1 ? "" : "s"} unsigned</span>
                            ) : null}
                            {unmatched ? <span className="text-amber-300">{unmatched} unmatched signature{unmatched === 1 ? "" : "s"}</span> : null}
                            {tx.txHash ? <span className="text-emerald-300">tx {tx.txHash.slice(0, 16)}…</span> : null}
                          </div>
                          </div>
                        </div>
                        <div className="flex w-full min-w-0 items-center gap-2 text-sm text-zinc-300 sm:w-auto">
                          {phaseIcon(phase)} {new Date(tx.createdAt).toLocaleString()}
                        </div>
                      </div>

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
                              const label = signerLabel(wallet, keyHash);
                              return (
                                <div
                                  key={keyHash}
                                  className={cn(
                                    "flex min-w-0 items-center justify-between gap-3 overflow-hidden rounded-lg border p-3",
                                    hasSigned ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/7 bg-black/20",
                                  )}
                                >
                                  <div className="flex min-w-0 items-center gap-3">
                                    <Avatar label={label} tone={hasSigned ? "success" : "muted"} />
                                    <div className="min-w-0">
                                      <div className="font-semibold text-zinc-50">{label}</div>
                                      <div className="truncate font-mono text-xs text-zinc-500">{keyHash}</div>
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
                                      ? "Copy the relay invite for a missing signer and send it privately. Returned witnesses merge into this room automatically; the manual package import remains available as a fallback."
                                      : "Copy the invite link, send it privately to a missing signer, then import the returned witness package. The invite carries unsigned transaction details in the URL fragment."
                                    : providerStatus?.services.submit
                                      ? `All required witnesses are present. Submit to ${providerStatus.network} from this wallet page.`
                                      : "All required witnesses are present, but this deployment still has submit disabled."}
                              </div>
                          </div>

                          {unmatched ? (
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                              <span>
                                {unmatched} signature{unmatched === 1 ? " was" : "s were"} captured but did not match a policy signer key hash and will not count toward submit.
                              </span>
                              <Button size="sm" variant="secondary" onClick={() => discardUnmatchedSignatures(tx.id)}>
                                <Trash2 className="size-4" /> Remove unmatched
                              </Button>
                            </div>
                          ) : null}

                          {tx.failureReason && !tx.txHash ? (
                            <div className="rounded-lg border border-rose-400/20 bg-rose-400/10 p-3 text-sm text-rose-100">
                              Last submit attempt failed: {tx.failureReason}
                            </div>
                          ) : null}

                          {!canSign ? (
                            <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                              Missing unsigned tx CBOR — rebuild or recreate the transaction before asking signers to approve it.
                            </div>
                          ) : null}
                        </div>

                        <div className="min-w-0 space-y-2">
                          <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void copyInvite(tx)}>
                            <Copy className="size-4" /> {tx.relayRoom ? "Copy next relay invite" : "Copy signer invite"}
                          </Button>
                          <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void signTransaction(tx)} disabled={!canSign}>
                            <ShieldCheck className="size-4" /> Sign with connected wallet
                          </Button>
                          <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void copySignatures(tx)} disabled={!tx.signatures?.length}>
                            <Copy className="size-4" /> Copy witness package fallback
                          </Button>
                          <Button
                            className="h-auto min-h-10 w-full whitespace-normal px-3 py-2"
                            onClick={() => void submitTransaction(tx)}
                            disabled={phase !== "ready" || !providerStatus?.services.submit}
                          >
                            <ShieldCheck className="size-4" /> Submit signed transaction
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
          </AppWindow>
        </div>

        <div className="min-w-0 space-y-6">
          {!isWatchOnly ? (
            <Card className="glass-panel">
              <CardHeader>
                <CardTitle>Import returned witness package</CardTitle>
                <CardDescription>
                  Paste a signature package from a signer. Both the old single-signature format and the new multi-signature format are accepted. Imported witnesses stay in this browser's local storage until you clear site data.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <textarea
                  className="min-h-48 min-w-0 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm text-slate-100 shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={signaturePackageInput}
                  onChange={(event) => setSignaturePackageInput(event.target.value)}
                  placeholder="Paste the witness package JSON here"
                />
                <Button className="w-full" onClick={importReturnedSignatures}>
                  <FileUp className="size-4" /> Import witness package
                </Button>
              </CardContent>
            </Card>
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
              {resolvedHandle ? (
                <div className="break-all rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                  Resolved {handleLabel(resolvedHandle)} → {resolvedHandle.address}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="glass-panel">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Multisig assets</CardTitle>
                  <CardDescription>
                    {isWatchOnly
                      ? "Fetched directly from the saved address. Import the native script when this needs to become an active multisig wallet."
                      : resolvedHandle
                      ? `ADA Handle ${handleLabel(resolvedHandle)} resolved to this multisig script address.`
                      : "Fetched from the server-managed Cardano provider for this script wallet."}
                  </CardDescription>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void refreshAssets()}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {walletAssets.length === 0 ? (
                <div className="rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-400">
                  <Database className="mr-2 inline size-4 text-sky-300" /> {assetStatus}
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {walletAssets.map((asset) => (
                    <div className="min-w-0 rounded-lg border border-border bg-slate-950/60 p-4" key={asset.unit}>
                      <div className="break-words text-sm text-slate-400">{asset.label}</div>
                      <div className="mt-1 font-mono text-lg font-semibold text-slate-100">
                        {formatRawQuantity(asset.quantity, asset.unit, asset.decimals)}
                      </div>
                      <div className="mt-1 break-all text-xs text-slate-500">{asset.unit}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 text-xs text-slate-500">{assetStatus}</div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
