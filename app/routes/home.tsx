import {
  ArrowRight,
  Check,
  Clock,
  Copy,
  Download,
  FileJson,
  Import,
  Link2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/home";
import { cn } from "../lib/utils";
import { notifyAppStorageChanged, useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import {
  type MultisigWallet,
  type NativeScript,
  type SignatureRecord,
  type Signer,
  type TxDraft,
  DEFAULT_NETWORK,
  LEGACY_STORAGE_KEY,
  NETWORKS,
  STORAGE_KEY,
  TX_STORAGE_KEY,
  cleanSigner,
  createId,
  createSignaturePackage,
  decodeInvite,
  encodeInvite,
  expectedNetworkId,
  formatTargetNetwork,
  isKeyHash,
  isRecord,
  mergeSignatures,
  networkLabel,
  nowIso,
  optionalSignerKeyHashes,
  parseSignaturePackage,
  pendingSignatureCount,
  removeUnmatchedSignatures,
  requiredPendingSignerKeyHashes,
  signatureCount,
  slugify,
  summarizeScript,
  uniqueSigners,
  unmatchedSignatureCount,
  requiredSignatures,
} from "../lib/multisig";

type Mode = "import" | "create";
type ImportMode = "export" | "address" | "signer";
type ParsedScript = { script: NativeScript | null; error: string | null; format: "json" | "cbor" | "empty" };
type AssetLine = { id: string; unit: string; label: string; quantity: string; decimals?: number };
type RecoveredScript = { source: string; txHash: string; scriptHash: string; paymentScript: NativeScript };
type AddressDiscovery = { source?: string; address?: string; handle?: { name: string; address: string }; assets: AssetLine[]; outputs?: number; recoveredScript?: RecoveredScript | null };

const SAMPLE_PAYMENT_SCRIPT = [
  "83030283",
  "8200581c",
  "a".repeat(56),
  "8200581c",
  "b".repeat(56),
  "8200581c",
  "c".repeat(56),
].join("");
const SAMPLE_STAKE_SCRIPT = ["8201818200581c", "d".repeat(56)].join("");

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Cardano Multisig" },
    { name: "description", content: "Collaborative Cardano native-script multisig signing room" },
  ];
}

function emptySigner(label = "Signer"): Signer {
  return { id: createId("signer"), label, keyHash: "", source: "manual" };
}

function trimDecimal(value: string) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatRawQuantity(quantity: string, unit: string, decimals = unit === "lovelace" ? 6 : 0) {
  const label = unit === "lovelace" ? "ADA" : "";
  const raw = BigInt(quantity || "0");
  if (!decimals) return `${raw.toLocaleString()}${label ? ` ${label}` : ""}`;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(decimals, "0")}`;
  return `${trimDecimal(`${whole.toLocaleString()}${fracText}`)}${label ? ` ${label}` : ""}`;
}

type CborValue = number | string | CborValue[];

function normalizeHex(value: string) {
  return value.replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase();
}

function parseCborValue(hex: string, offset = 0): { value: CborValue; offset: number } {
  if (offset >= hex.length) throw new Error("Unexpected end of CBOR.");
  const initial = Number.parseInt(hex.slice(offset, offset + 2), 16);
  offset += 2;
  const major = initial >> 5;
  const additional = initial & 31;

  function readLength() {
    if (additional < 24) return additional;
    const byteLengths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const bytes = byteLengths[additional];
    if (!bytes) throw new Error("Unsupported indefinite-length CBOR in native script.");
    const end = offset + bytes * 2;
    if (end > hex.length) throw new Error("Truncated CBOR length.");
    const length = Number.parseInt(hex.slice(offset, end), 16);
    offset = end;
    return length;
  }

  const length = readLength();
  if (major === 0) return { value: length, offset };
  if (major === 2) {
    const end = offset + length * 2;
    if (end > hex.length) throw new Error("Truncated CBOR byte string.");
    return { value: hex.slice(offset, end), offset: end };
  }
  if (major === 4) {
    const values: CborValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const parsed = parseCborValue(hex, offset);
      values.push(parsed.value);
      offset = parsed.offset;
    }
    return { value: values, offset };
  }
  throw new Error("Unsupported CBOR value in native script.");
}

function cborToNativeScript(value: CborValue): NativeScript {
  if (!Array.isArray(value) || typeof value[0] !== "number") {
    throw new Error("CBOR is not a Cardano native script.");
  }
  const tag = value[0];
  if (tag === 0 && typeof value[1] === "string") return { type: "sig", keyHash: value[1] };
  if ((tag === 1 || tag === 2) && Array.isArray(value[1])) {
    return { type: tag === 1 ? "all" : "any", scripts: value[1].map(cborToNativeScript) };
  }
  if (tag === 3 && typeof value[1] === "number" && Array.isArray(value[2])) {
    return { type: "atLeast", required: value[1], scripts: value[2].map(cborToNativeScript) };
  }
  if ((tag === 4 || tag === 5) && typeof value[1] === "number") {
    return { type: tag === 4 ? "after" : "before", slot: value[1] };
  }
  throw new Error("Unsupported native script CBOR shape.");
}

function parseCborScript(value: string): NativeScript {
  const hex = normalizeHex(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
    throw new Error("Paste valid native-script CBOR hex or JSON.");
  }
  const parsed = parseCborValue(hex);
  if (parsed.offset !== hex.length) throw new Error("Extra bytes after native script CBOR.");
  return cborToNativeScript(parsed.value);
}

function parseScript(value: string, required: boolean): ParsedScript {
  const trimmed = value.trim();
  if (!trimmed) {
    return required ? { script: null, error: "Script is required.", format: "empty" } : { script: null, error: null, format: "empty" };
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        return { script: null, error: "Script JSON must be an object with a type field.", format: "json" };
      }
      return { script: parsed as NativeScript, error: null, format: "json" };
    } catch (error) {
      return { script: null, error: error instanceof Error ? error.message : "Invalid JSON.", format: "json" };
    }
  }
  try {
    return { script: parseCborScript(trimmed), error: null, format: "cbor" };
  } catch (error) {
    return { script: null, error: error instanceof Error ? error.message : "Invalid native-script CBOR.", format: "cbor" };
  }
}

function buildNativeScript(signers: Signer[], threshold: number): NativeScript {
  const sigScripts = signers.map((signer) => ({ type: "sig", keyHash: signer.keyHash }));
  if (threshold <= 1) return { type: "any", scripts: sigScripts };
  if (threshold >= sigScripts.length) return { type: "all", scripts: sigScripts };
  return { type: "atLeast", required: threshold, scripts: sigScripts };
}

function collectSigners(script: NativeScript | null, source: "payment" | "stake") {
  const signers: Signer[] = [];
  function visit(node: NativeScript | null) {
    if (!node) return;
    if (node.type === "sig" && typeof node.keyHash === "string" && isKeyHash(node.keyHash)) {
      signers.push({ id: createId(source), label: `${source === "payment" ? "Payment" : "Stake"} signer ${signers.length + 1}`, keyHash: node.keyHash.toLowerCase(), source });
    }
    if (Array.isArray(node.scripts)) node.scripts.forEach(visit);
  }
  visit(script);
  return signers;
}

function migrateDiscovery(raw: Record<string, unknown>): MultisigWallet["discovery"] | undefined {
  const discovery = isRecord(raw.discovery) ? raw.discovery : raw;
  const address = typeof discovery.address === "string" ? discovery.address : undefined;
  if (!address) return undefined;
  const handle = isRecord(discovery.handle) && typeof discovery.handle.name === "string" && typeof discovery.handle.address === "string"
    ? { name: discovery.handle.name, address: discovery.handle.address }
    : undefined;
  return {
    kind: discovery.kind === "script" ? "script" : "address",
    address,
    source: typeof discovery.source === "string" ? discovery.source : undefined,
    outputs: typeof discovery.outputs === "number" ? discovery.outputs : undefined,
    assets: Array.isArray(discovery.assets) ? (discovery.assets as AssetLine[]) : undefined,
    handle,
  };
}

function migrateWallet(raw: unknown): MultisigWallet | null {
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  const script = isRecord(raw.script) ? (raw.script as NativeScript) : isRecord(raw.paymentScript) ? (raw.paymentScript as NativeScript) : null;
  const discovery = migrateDiscovery(raw);
  if (!script && !discovery?.address) return null;
  const signers = Array.isArray(raw.signers)
    ? (raw.signers as Signer[]).filter((signer) => isKeyHash(signer.keyHash))
    : collectSigners(script, "payment");
  return {
    id: typeof raw.id === "string" ? raw.id : createId("wallet"),
    name: raw.name,
    handle: typeof raw.handle === "string" ? raw.handle : undefined,
    network: NETWORKS.includes(raw.network as any) ? (raw.network as any) : DEFAULT_NETWORK,
    threshold: typeof raw.threshold === "number" ? raw.threshold : requiredSignatures(script),
    signers,
    paymentScript: isRecord(raw.paymentScript) ? (raw.paymentScript as NativeScript) : script || undefined,
    stakeScript: isRecord(raw.stakeScript) ? (raw.stakeScript as NativeScript) : null,
    script: script || undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    imported: Boolean(raw.imported),
    discovery,
  };
}

function readJsonArray<T>(key: string, migrate: (raw: unknown) => T | null): T[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(migrate).filter((item): item is T => Boolean(item));
  } catch {
    return [];
  }
}

function loadWallets() {
  const current = readJsonArray(STORAGE_KEY, migrateWallet);
  return current.length ? current : readJsonArray(LEGACY_STORAGE_KEY, migrateWallet);
}

function saveWallets(wallets: MultisigWallet[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets, null, 2));
}

function migrateDraft(raw: unknown): TxDraft | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  const status = raw.status === "succeeded" || raw.status === "failed" ? raw.status : "pending";
  return {
    id: raw.id,
    walletId: typeof raw.walletId === "string" ? raw.walletId : undefined,
    title: raw.title,
    walletName: String(raw.walletName || "Wallet"),
    network: NETWORKS.includes(raw.network as any) ? (raw.network as any) : DEFAULT_NETWORK,
    recipient: String(raw.recipient || ""),
    lovelace: String(raw.lovelace || ""),
    note: String(raw.note || ""),
    unsignedTxCbor: String(raw.unsignedTxCbor || ""),
    requiredSignatures: Number(raw.requiredSignatures || 1),
    signerKeyHashes: Array.isArray(raw.signerKeyHashes)
      ? raw.signerKeyHashes.map(String).filter(isKeyHash).map((value) => value.toLowerCase())
      : [],
    signatures: Array.isArray(raw.signatures) ? (raw.signatures as SignatureRecord[]) : [],
    createdAt: String(raw.createdAt || nowIso()),
    assets: Array.isArray(raw.assets) ? (raw.assets as AssetLine[]) : undefined,
    status,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    txHash: typeof raw.txHash === "string" ? raw.txHash : undefined,
    failureReason: typeof raw.failureReason === "string" ? raw.failureReason : undefined,
  };
}

function loadDrafts() {
  return readJsonArray(TX_STORAGE_KEY, migrateDraft);
}

function saveDrafts(drafts: TxDraft[]) {
  if (typeof window !== "undefined") window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(drafts, null, 2));
}

function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function walletHref(wallet: MultisigWallet) {
  return `/wallets/${encodeURIComponent(wallet.id)}`;
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

async function keyHashFromAddress(addressHex: string): Promise<string | null> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser");
    const address = CSL.Address.from_bytes(hexToBytes(addressHex));
    const base = CSL.BaseAddress.from_address(address);
    const enterprise = CSL.EnterpriseAddress.from_address(address);
    const reward = CSL.RewardAddress.from_address(address);
    const credential = base?.payment_cred() ?? enterprise?.payment_cred() ?? reward?.payment_cred();
    const keyHash = credential?.to_keyhash();
    return keyHash ? keyHash.to_hex() : null;
  } catch {
    return null;
  }
}

async function keyHashFromSignerInput(value: string): Promise<string | null> {
  const input = value.trim();
  if (isKeyHash(input)) return input.toLowerCase();
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser");
    const address = /^[0-9a-f]+$/i.test(input) ? CSL.Address.from_bytes(hexToBytes(input)) : CSL.Address.from_bech32(input);
    const base = CSL.BaseAddress.from_address(address);
    const enterprise = CSL.EnterpriseAddress.from_address(address);
    const reward = CSL.RewardAddress.from_address(address);
    const credential = base?.payment_cred() ?? enterprise?.payment_cred() ?? reward?.payment_cred();
    const keyHash = credential?.to_keyhash();
    return keyHash ? keyHash.to_hex() : null;
  } catch {
    return null;
  }
}

function looksLikeAddress(value: string) {
  return /^addr(_test)?1[0-9a-z]+$/i.test(value.trim());
}

function normalizeHandleInput(value: string) {
  return value.trim().replace(/^\$/, "");
}

function parseImportSource(value: string):
  | { kind: "empty" }
  | { kind: "wallet"; wallet: MultisigWallet }
  | { kind: "script"; parsed: ParsedScript } {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const wallet = migrateWallet(parsed);
      if (wallet) return { kind: "wallet", wallet };
    } catch {
      // Fall through to script parsing so the user still gets a specific JSON error.
    }
  }
  return { kind: "script", parsed: parseScript(value, true) };
}

function signerMatchesDraft(draft: TxDraft, keyHash: string | null) {
  if (!keyHash) return false;
  return draft.signerKeyHashes.some((hash) => hash.toLowerCase() === keyHash.toLowerCase());
}

function signerSummary(draft: TxDraft) {
  return `${signatureCount(draft)}/${draft.requiredSignatures} matched signatures`;
}

function signerCountLabel(draft: TxDraft) {
  const pending = pendingSignatureCount(draft);
  const optional = optionalSignerKeyHashes(draft).length;
  if (pending <= 0) {
    return optional ? `Threshold reached · ${optional} optional signer${optional === 1 ? "" : "s"} unsigned` : "All policy signers collected";
  }
  return `${pending} signer${pending === 1 ? "" : "s"} still needed`;
}

export default function Home() {
  const { connected, refreshConnectedWallet } = useAppShell();
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [drafts, setDrafts] = useState<TxDraft[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [mode, setMode] = useState<Mode>("import");
  const [importMode, setImportMode] = useState<ImportMode>("export");
  const [walletDialogOpen, setWalletDialogOpen] = useState(false);
  const [threshold, setThreshold] = useState(2);
  const [signers, setSigners] = useState<Signer[]>([emptySigner("Signer 1"), emptySigner("Signer 2"), emptySigner("Signer 3")]);
  const [importHandle, setImportHandle] = useState("");
  const [walletImportText, setWalletImportText] = useState("");
  const [stakeScriptText, setStakeScriptText] = useState("");
  const [addressOrHandle, setAddressOrHandle] = useState("");
  const [discoveringAddress, setDiscoveringAddress] = useState(false);
  const [addressDiscovery, setAddressDiscovery] = useState<AddressDiscovery | null>(null);
  const [addressDiscoveryError, setAddressDiscoveryError] = useState("");
  const [signerSearchInput, setSignerSearchInput] = useState("");
  const [signerSearchKeyHash, setSignerSearchKeyHash] = useState("");
  const [signerSearchError, setSignerSearchError] = useState("");
  const [copied, setCopied] = useState(false);

  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [signaturePackage, setSignaturePackage] = useState("");
  const [status, setStatus] = useState("");
  const [walletSearch, setWalletSearch] = useState("");

  useEffect(() => {
    const loadedWallets = loadWallets();
    const loadedDrafts = loadDrafts();
    setWallets(loadedWallets);

    const invite = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite");
    if (invite) {
      const draft = decodeInvite(invite, migrateDraft);
      if (!draft) {
        setStatus("Invite link is malformed. Ask the coordinator to copy the signer invite again.");
        setDrafts(loadedDrafts);
        setHydrated(true);
        return;
      }
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setDrafts(loadedDrafts.some((item) => item.id === draft.id) ? loadedDrafts : [draft, ...loadedDrafts]);
      setActiveDraftId(draft.id);
      setStatus("Invite loaded. Review the transaction below, connect a signer wallet, then click Sign.");
    } else {
      setDrafts(loadedDrafts);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveWallets(wallets);
    notifyAppStorageChanged();
  }, [wallets, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    saveDrafts(drafts);
    notifyAppStorageChanged();
  }, [drafts, hydrated]);

  const cleanedSigners = useMemo(() => signers.map(cleanSigner), [signers]);
  const validSigners = cleanedSigners.filter((signer) => isKeyHash(signer.keyHash));
  const clampedThreshold = Math.max(1, Math.min(threshold, validSigners.length || 1));
  const draftScript = useMemo(() => buildNativeScript(validSigners, clampedThreshold), [validSigners, clampedThreshold]);
  const canSave = validSigners.length >= 2 && clampedThreshold <= validSigners.length;
  const scriptJson = JSON.stringify(draftScript, null, 2);

  const parsedImportSource = useMemo(() => parseImportSource(walletImportText), [walletImportText]);
  const parsedPayment = useMemo(
    () => (parsedImportSource.kind === "script" ? parsedImportSource.parsed : parseScript("", true)),
    [parsedImportSource],
  );
  const parsedStake = useMemo(
    () => (parsedImportSource.kind === "wallet" ? { script: parsedImportSource.wallet.stakeScript ?? null, error: null, format: "json" as const } : parseScript(stakeScriptText, false)),
    [parsedImportSource, stakeScriptText],
  );
  const importedSigners = useMemo(
    () =>
      parsedImportSource.kind === "wallet"
        ? uniqueSigners(parsedImportSource.wallet.signers)
        : uniqueSigners([...collectSigners(parsedPayment.script, "payment"), ...collectSigners(parsedStake.script, "stake")]),
    [parsedImportSource, parsedPayment.script, parsedStake.script],
  );
  const importThreshold = parsedImportSource.kind === "wallet" ? parsedImportSource.wallet.threshold : requiredSignatures(parsedPayment.script);
  const canImport =
    parsedImportSource.kind === "wallet"
      ? Boolean(parsedImportSource.wallet.paymentScript || parsedImportSource.wallet.discovery?.address)
      : Boolean(parsedPayment.script) && !parsedPayment.error && !parsedStake.error;
  const activeSignerKeyHash = signerSearchKeyHash;
  const signerWalletMatches = useMemo(
    () =>
      activeSignerKeyHash
        ? wallets.filter((wallet) => wallet.signers.some((signer) => signer.keyHash.toLowerCase() === activeSignerKeyHash.toLowerCase()))
        : [],
    [activeSignerKeyHash, wallets],
  );
  const scopedWallets = importMode === "signer" && activeSignerKeyHash ? signerWalletMatches : wallets;
  const visibleWallets = useMemo(() => {
    const query = walletSearch.trim().replace(/^\$/, "").toLowerCase();
    if (!query) return scopedWallets;
    return scopedWallets.filter((wallet) => {
      const isWatchOnly = !wallet.paymentScript && Boolean(wallet.discovery?.address);
      const searchable = [
        wallet.name,
        wallet.handle,
        wallet.id,
        wallet.network,
        wallet.discovery?.address,
        isWatchOnly ? "watch only" : wallet.imported ? "imported" : "created",
        ...wallet.signers.map((signer) => `${signer.label} ${signer.keyHash}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [scopedWallets, walletSearch]);

  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? drafts[0] ?? null;
  const activeNetworkWarning =
    connected && activeDraft && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(activeDraft.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this transaction targets ${formatTargetNetwork(activeDraft.network)}.`
      : "";

  async function refreshConnectedSigner() {
    if (!connected) {
      setSignerSearchError("Connect Lace, Eternl, or VESPR first, or paste a signer address/key hash below.");
      return;
    }
    try {
      const refreshed = await refreshConnectedWallet();
      const keyHash = refreshed.keyHash;
      if (!keyHash) throw new Error("Could not derive a payment key hash from the connected signer wallet.");
      setSignerSearchInput(keyHash);
      setSignerSearchKeyHash(keyHash);
      setSignerSearchError("");
      setStatus(`Signer search refreshed from ${refreshed.name}.`);
    } catch (error) {
      setSignerSearchError(error instanceof Error ? error.message : "Could not refresh signer search.");
    }
  }

  async function searchSignerWallets() {
    const input = signerSearchInput.trim();
    if (!input) {
      setSignerSearchError("Paste a signer address or 56-character key hash, or refresh from the connected wallet.");
      return;
    }
    const keyHash = await keyHashFromSignerInput(input);
    if (!keyHash) {
      setSignerSearchKeyHash("");
      setSignerSearchError("Could not derive a signer key hash from that value.");
      return;
    }
    setSignerSearchKeyHash(keyHash);
    setSignerSearchInput(keyHash);
    setSignerSearchError("");
    setStatus(`Signer search active. ${wallets.filter((wallet) => wallet.signers.some((signer) => signer.keyHash.toLowerCase() === keyHash)).length} saved wallet match${wallets.filter((wallet) => wallet.signers.some((signer) => signer.keyHash.toLowerCase() === keyHash)).length === 1 ? "" : "es"}.`);
  }

  function clearSignerSearch() {
    setSignerSearchInput("");
    setSignerSearchKeyHash("");
    setSignerSearchError("");
  }

  function importWallet() {
    if (!canImport) return;
    const handle = normalizeHandleInput(importHandle);
    const wallet: MultisigWallet =
      parsedImportSource.kind === "wallet"
        ? {
            ...parsedImportSource.wallet,
            id: createId("wallet"),
            name: handle ? `$${handle}` : parsedImportSource.wallet.name,
            handle: handle || parsedImportSource.wallet.handle,
            network: DEFAULT_NETWORK,
            createdAt: nowIso(),
            imported: true,
          }
        : {
            id: createId("wallet"),
            name: handle ? `$${handle}` : "Imported wallet",
            handle: handle || undefined,
            network: DEFAULT_NETWORK,
            threshold: importThreshold,
            signers: importedSigners,
            paymentScript: parsedPayment.script!,
            stakeScript: parsedStake.script,
            script: parsedPayment.script!,
            createdAt: nowIso(),
            imported: true,
          };
    setWallets((current) => [wallet, ...current]);
    setWalletDialogOpen(false);
    setStatus("Wallet imported. Open it to create transactions and track signer progress.");
  }

  async function lookupAddressImport() {
    const input = addressOrHandle.trim();
    if (!input) {
      setAddressDiscovery(null);
      setAddressDiscoveryError("Paste an addr... / addr_test... multisig address or an ADA Handle.");
      return;
    }

    const handle = normalizeHandleInput(input);
    if (!looksLikeAddress(input) && !handle) {
      setAddressDiscovery(null);
      setAddressDiscoveryError("Paste a valid multisig address or ADA Handle.");
      return;
    }

    if (!looksLikeAddress(input) && DEFAULT_NETWORK !== "mainnet") {
      setAddressDiscovery(null);
      setAddressDiscoveryError("ADA Handle lookup is only available on mainnet. On preprod, import from a wallet export or native script instead.");
      return;
    }

    setDiscoveringAddress(true);
    setAddressDiscovery(null);
    setAddressDiscoveryError("");
    try {
      const params = new URLSearchParams({ network: DEFAULT_NETWORK });
      if (looksLikeAddress(input)) params.set("address", input.trim());
      else params.set("handle", handle);

      const response = await fetch(`/api/cardano/assets?${params.toString()}`);
      const body = (await response.json().catch(() => null)) as
        | ({ error?: string; source?: string; address?: string; handle?: { name: string; address: string }; outputs?: number; assets?: AssetLine[]; recoveredScript?: RecoveredScript | null })
        | null;
      if (!response.ok) {
        throw new Error(body?.error || "Could not inspect that address yet.");
      }

      setAddressDiscovery({
        source: body?.source,
        address: body?.address,
        handle: body?.handle,
        outputs: body?.outputs,
        assets: Array.isArray(body?.assets) ? body!.assets : [],
        recoveredScript: body?.recoveredScript || null,
      });
      setStatus(
        body?.recoveredScript
          ? "Native script recovered from historical chain data. You can import this multisig without pasting JSON."
          : "Address discovery loaded. Assets are visible, but no historical native-script witness was found yet.",
      );
    } catch (error) {
      setAddressDiscovery(null);
      setAddressDiscoveryError(error instanceof Error ? error.message : "Could not inspect that address yet.");
    } finally {
      setDiscoveringAddress(false);
    }
  }

  function saveAddressDiscovery() {
    if (!addressDiscovery?.address) {
      setAddressDiscoveryError("Inspect an address or ADA Handle before saving it.");
      return;
    }

    const handle = addressDiscovery.handle?.name || (!looksLikeAddress(addressOrHandle) ? normalizeHandleInput(addressOrHandle) : "");
    const name = handle ? `$${handle.replace(/^\$/, "")}` : "Watch-only address";
    const recoveredPayment = addressDiscovery.recoveredScript?.paymentScript;
    const recoveredSigners = recoveredPayment ? uniqueSigners(collectSigners(recoveredPayment, "payment")) : [];
    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name,
      handle: handle ? handle.replace(/^\$/, "") : undefined,
      network: DEFAULT_NETWORK,
      threshold: recoveredPayment ? requiredSignatures(recoveredPayment) : 0,
      signers: recoveredSigners,
      paymentScript: recoveredPayment || undefined,
      script: recoveredPayment || undefined,
      stakeScript: null,
      createdAt: nowIso(),
      imported: true,
      discovery: {
        kind: recoveredPayment ? "script" : "address",
        address: addressDiscovery.address,
        source: addressDiscovery.source,
        outputs: addressDiscovery.outputs,
        assets: addressDiscovery.assets,
        handle: addressDiscovery.handle,
      },
    };

    setWallets((current) => {
      const withoutDuplicate = current.filter((item) => item.discovery?.address !== addressDiscovery.address);
      return [wallet, ...withoutDuplicate];
    });
    setWalletDialogOpen(false);
    setStatus(
      recoveredPayment
        ? "Multisig wallet imported from ADA Handle/address. The native script was recovered automatically from historical chain data."
        : "Address saved as watch-only. Import the native script or wallet export later to create transactions from it.",
    );
  }

  function saveCreatedWallet() {
    if (!canSave) return;
    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name: "New multisig wallet",
      network: DEFAULT_NETWORK,
      threshold: clampedThreshold,
      signers: validSigners,
      paymentScript: draftScript,
      stakeScript: null,
      script: draftScript,
      createdAt: nowIso(),
      imported: false,
    };
    setWallets((current) => [wallet, ...current]);
    setWalletDialogOpen(false);
    setStatus("Wallet created. Open it to build transactions and share signer invites.");
  }

  async function copyScript() {
    await navigator.clipboard.writeText(scriptJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function copyInvite(draft: TxDraft) {
    const link = `${window.location.origin}/#invite=${encodeInvite(draft)}`;
    await navigator.clipboard.writeText(link);
    setStatus("Invite link copied. Share it privately with the intended signer only.");
  }

  async function signActiveDraft() {
    if (!activeDraft || !connected) return;
    if (activeNetworkWarning) {
      setStatus(activeNetworkWarning);
      return;
    }
    if (!activeDraft.unsignedTxCbor.trim()) {
      setStatus("This invite is missing unsigned transaction CBOR, so a wallet cannot sign it yet.");
      return;
    }
    try {
      const signerKeyHash = connected.keyHash?.toLowerCase() || `unknown-${connected.id}`;
      const witnessCbor = await connected.api.signTx(activeDraft.unsignedTxCbor.trim(), true);
      const signature: SignatureRecord = {
        signerKeyHash,
        signerName: connected.keyHash ? connected.keyHash.toLowerCase() : connected.name,
        walletName: connected.name,
        witnessCbor,
        signedAt: nowIso(),
      };
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === activeDraft.id
            ? { ...draft, signatures: mergeSignatures(draft.signatures, [signature]), updatedAt: nowIso() }
            : draft,
        ),
      );
      setSignaturePackage(createSignaturePackage(activeDraft.id, [signature]));
      setStatus(
        connected.keyHash
          ? "Witness captured. Copy the witness package and send it back to the coordinator."
          : "Witness captured, but the signer key hash could not be verified automatically. The coordinator will see it as unmatched until they confirm the signer.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Wallet refused to sign.");
    }
  }

  function importSignature() {
    try {
      const { draftId, signatures } = parseSignaturePackage(signaturePackage);
      if (!signatures.length) throw new Error("The signature package does not contain any signatures.");
      let found = false;
      setDrafts((current) =>
        current.map((draft) => {
          if (draft.id !== draftId) return draft;
          found = true;
          return { ...draft, signatures: mergeSignatures(draft.signatures, signatures), updatedAt: nowIso() };
        }),
      );
      if (!found) throw new Error("This signature package belongs to a different transaction room.");
      setActiveDraftId(draftId);
      setStatus(`Imported ${signatures.length} signature${signatures.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid signature package.");
    }
  }

  function discardUnmatchedSignatures(draftId: string) {
    setDrafts((current) =>
      current.map((draft) =>
        draft.id === draftId
          ? { ...draft, signatures: removeUnmatchedSignatures(draft), updatedAt: nowIso() }
          : draft,
      ),
    );
    setStatus("Unmatched witness packages removed from this local transaction room.");
  }

  async function copySignaturePackage() {
    if (!signaturePackage.trim()) return;
    await navigator.clipboard.writeText(signaturePackage);
    setStatus("Witness package copied.");
  }

  return (
    <div className="flex flex-col gap-6">
      {activeDraft ? (
        <AppWindow title="Pending signature request" className="border-emerald-400/25">
          <div className="px-5 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#202124] text-zinc-300 ring-1 ring-white/6">
                  <ShieldCheck className="size-6" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-2xl font-semibold leading-tight text-zinc-50">Sign {activeDraft.title}</h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {activeDraft.walletName} · {activeDraft.requiredSignatures}-of-{activeDraft.signerKeyHashes.length || activeDraft.requiredSignatures}
                  </p>
                </div>
              </div>
              <Badge variant="secondary">
                <Clock className="size-3" /> {pendingSignatureCount(activeDraft) <= 0 ? "ready" : `${pendingSignatureCount(activeDraft)} more`}
              </Badge>
            </div>
          </div>
          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-[#111114] p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm text-zinc-400">Required signatures</div>
                    <div className="mt-1 text-3xl font-semibold text-zinc-50">
                      {signatureCount(activeDraft)} / {activeDraft.requiredSignatures}
                    </div>
                    <div className="mt-2 break-all text-sm text-zinc-400">Recipient: {activeDraft.recipient || "Not provided"}</div>
                  </div>
                  <Avatar label={activeDraft.walletName} tone={pendingSignatureCount(activeDraft) ? "primary" : "success"} />
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Required signatures</span>
                    <span>{signatureCount(activeDraft)} / {activeDraft.requiredSignatures}</span>
                  </div>
                  <Progress value={signatureCount(activeDraft)} max={activeDraft.requiredSignatures} />
                </div>
                <div className="mt-5 space-y-3">
                  {activeDraft.signerKeyHashes.map((hash, index) => {
                    const signed = activeDraft.signatures.some((signature) => signature.signerKeyHash.toLowerCase() === hash.toLowerCase());
                    const label = `Signer ${index + 1}`;
                    return (
                      <div
                        key={hash}
                        className={cn(
                          "flex items-center justify-between gap-4 rounded-xl border p-3",
                          signed ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/7 bg-black/20",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar label={label} tone={signed ? "success" : "muted"} />
                          <div className="min-w-0">
                            <div className="font-semibold text-zinc-50">{label}</div>
                            <div className="truncate font-mono text-xs text-zinc-500">{hash}</div>
                          </div>
                        </div>
                        <div
                          className={cn(
                            "flex size-9 shrink-0 items-center justify-center rounded-full border",
                            signed ? "border-emerald-400 text-emerald-300" : "border-white/10 text-transparent",
                          )}
                        >
                          <Check className="size-4" />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {activeDraft.note ? <div className="mt-4 text-sm text-zinc-300">Coordinator note: {activeDraft.note}</div> : null}
              </div>
              {optionalSignerKeyHashes(activeDraft).length && pendingSignatureCount(activeDraft) === 0 ? (
                <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                  Threshold reached. {optionalSignerKeyHashes(activeDraft).length} policy signer{optionalSignerKeyHashes(activeDraft).length === 1 ? "" : "s"} can still sign, but they are no longer required for submit.
                </div>
              ) : null}
              {(activeDraft.assets?.length ? activeDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: activeDraft.lovelace || "0", decimals: 6 }]).length ? (
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Assets</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(activeDraft.assets?.length ? activeDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: activeDraft.lovelace || "0", decimals: 6 }]).map((asset) => (
                      <div key={asset.id} className="rounded-full border border-border px-3 py-1 text-sm text-slate-200">
                        {formatRawQuantity(asset.quantity, asset.unit, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {unmatchedSignatureCount(activeDraft) ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                  <span>
                    {unmatchedSignatureCount(activeDraft)} unmatched signature{unmatchedSignatureCount(activeDraft) === 1 ? " is" : "s are"} stored locally and will not count toward submit.
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => discardUnmatchedSignatures(activeDraft.id)}>
                    <Trash2 className="size-4" /> Remove unmatched
                  </Button>
                </div>
              ) : null}
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                Privacy note: this invite carries the recipient, asset amounts, coordinator note, signer list, and unsigned tx CBOR in the URL fragment. After load it is kept only in this browser's local storage, so use a trusted device and clear site data when the signing handoff is complete.
              </div>
            </div>

            <div className="space-y-3">
              <Card className="border-border bg-slate-950/60">
                <CardHeader>
                  <CardTitle className="text-base">Next signer step</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-300">
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">1. Connect the signer wallet above.</div>
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">2. Confirm the wallet is on {formatTargetNetwork(activeDraft.network)}.</div>
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">3. Click Sign, then copy the witness package back to the coordinator.</div>
                </CardContent>
              </Card>
              {activeNetworkWarning ? (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">{activeNetworkWarning}</div>
              ) : null}
              <Button className="w-full" onClick={() => void signActiveDraft()} disabled={!connected || !activeDraft.unsignedTxCbor.trim()}>
                <ShieldCheck className="size-4" /> Sign loaded invite
              </Button>
              <Button className="w-full" variant="secondary" onClick={copySignaturePackage} disabled={!signaturePackage.trim()}>
                <Copy className="size-4" /> Copy witness package
              </Button>
            </div>
          </div>
        </AppWindow>
      ) : null}

      <Dialog open={walletDialogOpen} onOpenChange={setWalletDialogOpen}>
        <DialogContent onClose={() => setWalletDialogOpen(false)}>
          <DialogHeader>
            <DialogTitle>{mode === "import" ? "Import wallet" : "Create policy"}</DialogTitle>
            <DialogDescription>Import from a wallet export, ADA Handle/address, signer key, or create a fresh M-of-N policy.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-zinc-50">Wallet workspace</h2>
              <p className="mt-1 text-sm text-zinc-400">Keep the first step simple: import something real, or create a fresh M-of-N policy.</p>
            </div>
            <div className="grid grid-cols-2 rounded-lg border border-border bg-slate-950/70 p-1">
              {(["import", "create"] as Mode[]).map((item) => (
                <Button key={item} variant={mode === item ? "default" : "ghost"} size="sm" onClick={() => setMode(item)}>
                  {item === "import" ? <Import className="size-4" /> : <Plus className="size-4" />}
                  {item}
                </Button>
              ))}
            </div>
          </div>

          {mode === "import" ? (
            <>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-slate-950/70 p-1">
                {([
                  { id: "export", label: "Script", icon: FileJson },
                  { id: "address", label: "Address", icon: Search },
                  { id: "signer", label: "Signer", icon: WalletCards },
                ] as { id: ImportMode; label: string; icon: typeof FileJson }[]).map((item) => (
                  <Button key={item.id} type="button" variant={importMode === item.id ? "default" : "ghost"} size="sm" className="min-w-0 px-2" onClick={() => setImportMode(item.id)}>
                    <item.icon className="size-3.5 shrink-0" />
                    {item.label}
                  </Button>
                ))}
              </div>

              {importMode === "export" ? (
                <>
                  <div className="space-y-2">
                    <Label>Wallet export JSON or payment script</Label>
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span>Paste a previously exported wallet JSON, or paste payment native-script CBOR / JSON directly.</span>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setWalletImportText(SAMPLE_PAYMENT_SCRIPT)}>
                        Load sample
                      </Button>
                    </div>
                    <Textarea
                      value={walletImportText}
                      onChange={(event) => setWalletImportText(event.target.value)}
                      placeholder='Paste wallet export JSON or payment native-script CBOR / JSON'
                      className="min-h-48 font-mono text-xs"
                      aria-invalid={parsedImportSource.kind === "script" && Boolean(parsedPayment.error)}
                    />
                    {parsedImportSource.kind === "script" && parsedPayment.error ? <p className="text-sm text-red-300">{parsedPayment.error}</p> : null}
                  </div>

                  {parsedImportSource.kind !== "wallet" ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Stake script (optional)</Label>
                        <Button type="button" variant="ghost" size="sm" onClick={() => setStakeScriptText(SAMPLE_STAKE_SCRIPT)}>
                          Load sample
                        </Button>
                      </div>
                      <Textarea value={stakeScriptText} onChange={(event) => setStakeScriptText(event.target.value)} placeholder="Paste stake native-script CBOR / JSON if it has one" className="min-h-32 font-mono text-xs" aria-invalid={Boolean(parsedStake.error)} />
                      {parsedStake.error ? <p className="text-sm text-red-300">{parsedStake.error}</p> : null}
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    <Label>Display name / ADA Handle (optional)</Label>
                    <Input value={importHandle} onChange={(event) => setImportHandle(event.target.value)} placeholder="$discatalyst" />
                  </div>

                  <div className="rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-300">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span>
                        {parsedImportSource.kind === "wallet" ? (
                          <span className="inline-flex items-center gap-2"><FileJson className="size-4" /> Wallet export detected · {parsedImportSource.wallet.threshold}-of-{parsedImportSource.wallet.signers.length}</span>
                        ) : (
                          <span>Detected {importedSigners.length} signer{importedSigners.length === 1 ? "" : "s"} · payment {summarizeScript(parsedPayment.script)} · stake {summarizeScript(parsedStake.script)}</span>
                        )}
                      </span>
                      <div className="-space-x-2">
                        {importedSigners.slice(0, 5).map((signer) => (
                          <Avatar key={signer.id} label={signer.label || signer.keyHash} className="size-8 border border-slate-950" />
                        ))}
                      </div>
                    </div>
                  </div>
                  <Button onClick={importWallet} disabled={!canImport}>Save imported wallet</Button>
                </>
              ) : null}

              {importMode === "address" ? (
                <>
                  <div className="space-y-2">
                    <Label>Multisig address or ADA Handle</Label>
                    <Input value={addressOrHandle} onChange={(event) => setAddressOrHandle(event.target.value)} placeholder={DEFAULT_NETWORK === "mainnet" ? "addr1... or $treasury" : "addr_test1..."} />
                    <p className="text-sm text-zinc-500">Use this when you know the receiving address or mainnet ADA Handle, but not the full script export.</p>
                  </div>
                  <Button variant="secondary" onClick={() => void lookupAddressImport()} disabled={discoveringAddress}>
                    <Search className="size-4" /> {discoveringAddress ? "Checking address..." : "Inspect address"}
                  </Button>
                  {addressDiscoveryError ? <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">{addressDiscoveryError}</div> : null}
                  {addressDiscovery ? (
                    <div className="space-y-3 rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-300">
                      <div>
                        <div className="font-semibold text-zinc-100">{addressDiscovery.handle ? `$${addressDiscovery.handle.name}` : "Address discovery"}</div>
                        <div className="mt-1 break-all text-xs text-zinc-500">{addressDiscovery.address || "Address not resolved"}</div>
                        <div className="mt-2 text-xs text-zinc-500">Source: {addressDiscovery.source || "unknown"}{typeof addressDiscovery.outputs === "number" ? ` · ${addressDiscovery.outputs} output${addressDiscovery.outputs === 1 ? "" : "s"}` : ""}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {addressDiscovery.assets.slice(0, 8).map((asset) => (
                          <div key={asset.id || asset.unit} className="rounded-full border border-border px-3 py-1 text-xs text-slate-200">
                            {formatRawQuantity(asset.quantity, asset.unit, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0))}
                          </div>
                        ))}
                      </div>
                      {addressDiscovery.recoveredScript ? (
                        <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                          Native script recovered from a historical transaction witness. This can be imported as a full multisig wallet without pasting script JSON.
                          <div className="mt-1 break-all font-mono text-xs text-emerald-200/80">tx {addressDiscovery.recoveredScript.txHash}</div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                          No historical native-script witness was found for this address yet. Save it as watch-only now, or import a wallet export/native script later to create transactions.
                        </div>
                      )}
                      <Button onClick={saveAddressDiscovery} disabled={!addressDiscovery.address}>
                        <Plus className="size-4" /> {addressDiscovery.recoveredScript ? "Import recovered multisig" : "Save watch-only wallet"}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}

              {importMode === "signer" ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-300">
                    <div className="font-semibold text-zinc-100">Find saved wallets by signer</div>
                    <p className="mt-1 text-sm text-zinc-400">Refresh from the connected signer wallet, or paste a signer address/key hash. Matching saved wallets appear on the right.</p>
                    <div className="mt-4 space-y-2">
                      <Label>Signer address or key hash</Label>
                      <Input
                        value={signerSearchInput}
                        onChange={(event) => setSignerSearchInput(event.target.value)}
                        placeholder="addr1... or 56-char key hash"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void searchSignerWallets()}>
                        <Search className="size-4" /> Search saved wallets
                      </Button>
                      <Button variant="secondary" onClick={() => void refreshConnectedSigner()} disabled={!connected}>
                        <RefreshCw className="size-4" /> Refresh from wallet
                      </Button>
                      {activeSignerKeyHash ? (
                        <Button variant="ghost" onClick={clearSignerSearch}>Clear</Button>
                      ) : null}
                    </div>
                    {activeSignerKeyHash ? (
                      <div className="mt-3 break-all rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                        Filtering saved wallets by signer key hash: <span className="font-mono">{activeSignerKeyHash}</span>
                      </div>
                    ) : null}
                    {signerSearchError ? (
                      <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">{signerSearchError}</div>
                    ) : null}
                  </div>

                  {activeSignerKeyHash && !signerWalletMatches.length ? (
                    <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                      No saved multisigs in this browser match this signer yet. Import by address/ADA Handle or wallet export first, then rerun the signer search.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px]">
                <div className="space-y-2">
                  <Label>Signer threshold</Label>
                  <Input type="number" min={1} max={Math.max(validSigners.length, 1)} value={threshold} onChange={(event) => setThreshold(Number(event.target.value || 1))} />
                </div>
                <div className="space-y-2">
                  <Label>Detected rule</Label>
                  <div className="rounded-md border border-border bg-slate-950/60 px-3 py-2 text-sm text-slate-300">{summarizeScript(draftScript)}</div>
                </div>
              </div>
              <div className="space-y-3">
                {signers.map((signer, index) => (
                  <div key={signer.id} className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)_40px]">
                    <div className="flex items-center gap-2">
                      <Avatar label={signer.label || `Signer ${index + 1}`} />
                      <Input value={signer.label} onChange={(event) => setSigners((current) => current.map((item) => item.id === signer.id ? { ...item, label: event.target.value } : item))} placeholder={`Signer ${index + 1}`} />
                    </div>
                    <Input value={signer.keyHash} onChange={(event) => setSigners((current) => current.map((item) => item.id === signer.id ? { ...item, keyHash: event.target.value } : item))} placeholder="56-char key hash" />
                    <Button variant="ghost" onClick={() => setSigners((current) => current.filter((item) => item.id !== signer.id))}>×</Button>
                  </div>
                ))}
                <Button variant="secondary" onClick={() => setSigners((current) => [...current, emptySigner(`Signer ${current.length + 1}`)])}>Add signer</Button>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Generated script JSON</Label>
                  <Button variant="ghost" size="sm" onClick={copyScript}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? "Copied" : "Copy"}</Button>
                </div>
                <Textarea readOnly value={scriptJson} className="min-h-48 font-mono text-xs" />
              </div>
              <Button onClick={saveCreatedWallet} disabled={!canSave}>Save created wallet</Button>
            </>
          )}
          <details className="rounded-xl border border-white/8 bg-black/20 px-5 py-4 text-zinc-200">
            <summary className="cursor-pointer list-none text-sm font-semibold text-zinc-100">Advanced witness import</summary>
            <div className="mt-4 space-y-3">
              <p className="text-sm text-zinc-400">Paste a returned witness package from any signer. Both legacy and new formats still work here.</p>
              <Textarea value={signaturePackage} onChange={(event) => setSignaturePackage(event.target.value)} placeholder="Paste witness package JSON here" className="min-h-40 font-mono text-xs" />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={importSignature}>Import witness package</Button>
                {activeDraft ? <Button variant="ghost" onClick={() => setActiveDraftId(activeDraft.id)}>Back to active room</Button> : null}
              </div>
            </div>
          </details>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <section>
        <AppWindow title="Wallets" contentClassName="p-0">
          <div className="border-b border-white/8 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold text-zinc-50">{importMode === "signer" && activeSignerKeyHash ? "Matching wallets" : "Wallets"}</h2>
                  <Badge variant="secondary">
                    {wallets.length} wallet{wallets.length === 1 ? "" : "s"}
                  </Badge>
                  {drafts.length ? (
                    <Badge variant="outline" className="border-white/10 text-zinc-400">
                      {drafts.length} room{drafts.length === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                  {importMode === "signer" && activeSignerKeyHash
                    ? "These saved multisig policies include the active signer key hash."
                    : "Open a wallet, create transactions, copy signer invites, and track who is still missing."}
                </p>
              </div>
              <Button type="button" className="h-10 px-5 text-sm font-semibold" onClick={() => setWalletDialogOpen(true)}>
                Import or create
              </Button>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-black/20 px-3">
                <Search className="size-4 shrink-0 text-zinc-500" />
                <input
                  value={walletSearch}
                  onChange={(event) => setWalletSearch(event.target.value)}
                  placeholder="Search wallet, handle, signer, status..."
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary">
                  {importMode === "signer" && activeSignerKeyHash ? `${visibleWallets.length} / ${wallets.length}` : visibleWallets.length} shown
                </Badge>
                {walletSearch ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setWalletSearch("")}>Clear search</Button>
                ) : null}
                {importMode === "signer" && activeSignerKeyHash ? (
                  <Button type="button" variant="ghost" size="sm" onClick={clearSignerSearch}>Clear signer</Button>
                ) : null}
              </div>
            </div>
          </div>

          {visibleWallets.length === 0 ? (
            <div className="m-5 rounded-lg border border-dashed border-white/10 bg-black/20 p-8 text-center text-zinc-400">
              {wallets.length === 0
                ? "No wallets saved yet. Import a wallet export, native script, or create a new policy to start."
                : "No wallet matches the current filter. Clear search or signer filtering to see all saved wallets."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-white/[0.015]">
                  <TableHead>Wallet</TableHead>
                  <TableHead>Policy</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Signers</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleWallets.map((wallet) => {
                  const isWatchOnly = !wallet.paymentScript && Boolean(wallet.discovery?.address);
                  const title = wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name;
                  const assetCount = wallet.discovery?.assets?.length || 0;
                  const walletRooms = drafts.filter((draft) => draft.walletId === wallet.id);
                  const readyRooms = walletRooms.filter((draft) => pendingSignatureCount(draft) <= 0).length;
                  const missingForWallet = walletRooms.reduce((total, draft) => total + pendingSignatureCount(draft), 0);
                  return (
                    <TableRow key={wallet.id} className="group">
                      <TableCell className="min-w-80 py-5">
                        <Link to={walletHref(wallet)} className="flex min-w-0 items-center gap-3">
                          <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-white/5 text-zinc-300 ring-1 ring-white/10 transition group-hover:bg-white/8">
                            <WalletCards className="size-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="truncate font-semibold text-zinc-50">{title}</div>
                              <Badge variant="outline" className="border-white/10 text-zinc-400">{wallet.network}</Badge>
                            </div>
                            <div className="mt-1 max-w-md truncate text-xs text-zinc-500">
                              {isWatchOnly ? wallet.discovery?.address : wallet.handle ? wallet.name : wallet.id}
                            </div>
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell className="min-w-60 text-zinc-300">
                        {isWatchOnly ? (
                          <div>
                            <div>{assetCount} visible asset{assetCount === 1 ? "" : "s"}</div>
                            <div className="mt-1 text-xs text-zinc-500">native script still needed to spend</div>
                          </div>
                        ) : (
                          <div>
                            <div>payment {summarizeScript(wallet.paymentScript)}</div>
                            <div className="mt-1 text-xs text-zinc-500">stake {summarizeScript(wallet.stakeScript ?? null)}</div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="min-w-44">
                        <div className="flex flex-wrap gap-2 text-xs">
                          <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-zinc-300">
                            {walletRooms.length} room{walletRooms.length === 1 ? "" : "s"}
                          </span>
                          {readyRooms ? (
                            <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-emerald-200">{readyRooms} ready</span>
                          ) : null}
                          {missingForWallet ? (
                            <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-amber-200">{missingForWallet} missing</span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={isWatchOnly ? "outline" : wallet.imported ? "default" : "secondary"}
                          className={cn(
                            isWatchOnly ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "",
                            wallet.imported && !isWatchOnly ? "bg-zinc-100 text-zinc-950" : "",
                          )}
                        >
                          {isWatchOnly ? "watch-only" : wallet.imported ? "imported" : "created"}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-48">
                        {isWatchOnly ? (
                          <div className="flex items-center gap-2 text-sm text-zinc-400">
                            <Avatar label={title} className="size-8 border border-[#121214]" />
                            <span>watch address</span>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="-space-x-2 whitespace-nowrap">
                                {wallet.signers.slice(0, 6).map((signer, index) => (
                                  <Avatar key={signer.id} label={signer.label || `Signer ${index + 1}`} className="size-8 border border-[#121214]" />
                                ))}
                              </div>
                              {wallet.signers.length > 6 ? <span className="text-xs text-zinc-500">+{wallet.signers.length - 6}</span> : null}
                            </div>
                            <div className="text-xs text-zinc-500">{wallet.threshold}-of-{wallet.signers.length} required</div>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Link to={walletHref(wallet)} className="inline-flex h-8 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90">
                            {isWatchOnly ? "Open watch" : "Open"} <ArrowRight className="size-4" />
                          </Link>
                          <Button size="sm" variant="secondary" onClick={() => downloadJson(`${slugify(wallet.name)}-wallet.json`, wallet)}>
                            <Download className="size-4" /> Export
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}>
                            <Trash2 className="size-4" /> Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </AppWindow>
      </section>

      {drafts.length ? (
        <Card className="glass-panel overflow-hidden rounded-lg">
          <CardHeader className="border-b border-white/8 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-xl">Transaction rooms</CardTitle>
                <CardDescription>Continue signature collection and witness handoff for saved transactions.</CardDescription>
              </div>
              <Badge variant="secondary">
                {drafts.length} room{drafts.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
            {drafts.map((draft) => (
              <article
                key={draft.id}
                className={cn(
                  "rounded-lg border p-4 transition hover:border-white/18",
                  activeDraftId === draft.id ? "border-sky-400/50 bg-sky-400/10" : "border-border bg-black/20",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Avatar label={draft.walletName} tone={pendingSignatureCount(draft) ? "primary" : "success"} />
                    <div>
                      <h3 className="font-semibold text-slate-100">{draft.title}</h3>
                      <div className="text-xs text-slate-500">{draft.walletName}</div>
                    </div>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    <Users className="size-3" /> {signatureCount(draft)} / {draft.requiredSignatures}
                  </Badge>
                </div>
                <div className="mt-3 line-clamp-2 break-all text-sm text-slate-400">{draft.recipient || "No recipient saved"}</div>
                <div className="mt-3 space-y-2">
                  <Progress value={signatureCount(draft)} max={draft.requiredSignatures} />
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{signerCountLabel(draft)}</span>
                    <span>{draft.status}</span>
                  </div>
                </div>
                {requiredPendingSignerKeyHashes(draft).length ? (
                  <div className="mt-2 text-xs text-slate-400">
                    Need {requiredPendingSignerKeyHashes(draft).length} more matching signer{requiredPendingSignerKeyHashes(draft).length === 1 ? "" : "s"} before submit.
                  </div>
                ) : null}
                {unmatchedSignatureCount(draft) ? <div className="mt-2 text-xs text-amber-300">{unmatchedSignatureCount(draft)} unmatched signature{unmatchedSignatureCount(draft) === 1 ? "" : "s"}</div> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="default" size="sm" onClick={() => setActiveDraftId(draft.id)}>Open</Button>
                  <Button variant="secondary" size="sm" onClick={() => void copyInvite(draft)}><Link2 className="size-4" /> Invite</Button>
                  {unmatchedSignatureCount(draft) ? (
                    <Button variant="secondary" size="sm" onClick={() => discardUnmatchedSignatures(draft.id)}>
                      <Trash2 className="size-4" /> Unmatched
                    </Button>
                  ) : null}
                  <Button variant="destructive" size="sm" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2 className="size-4" /> Delete</Button>
                </div>
              </article>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}
    </div>
  );
}
