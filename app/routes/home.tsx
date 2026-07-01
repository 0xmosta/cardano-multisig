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
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/home";
import { cn } from "../lib/utils";
import { notifyAppStorageChanged, useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Progress } from "../components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Textarea } from "../components/ui/textarea";
import {
  type MultisigWallet,
  type NativeScript,
  type RelayRoomRef,
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
  expectedNetworkId,
  formatTargetNetwork,
  hasMatchedSignature,
  isKeyHash,
  isRecord,
  mergeSignatures,
  networkLabel,
  nowIso,
  normalizeRelayAssetLines,
  normalizeKeyHash,
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
import {
  type RelayRoomCreateResponse,
  type RelayRoomSessionResponse,
  type RelayRoomSignerView,
  applyRelayRoomToDraft,
  draftFromRelaySignerView,
} from "../lib/relay-room";
import { verifySignatureRecordsForDraft } from "../lib/witness-verification";

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
  const relayRoom = isRecord(raw.relayRoom)
    ? {
        roomId: typeof raw.relayRoom.roomId === "string" ? raw.relayRoom.roomId : "",
        createdAt: typeof raw.relayRoom.createdAt === "string" ? raw.relayRoom.createdAt : nowIso(),
        lastSyncAt: typeof raw.relayRoom.lastSyncAt === "string" ? raw.relayRoom.lastSyncAt : undefined,
        sharedInviteUrl: typeof raw.relayRoom.sharedInviteUrl === "string" ? raw.relayRoom.sharedInviteUrl : undefined,
        status:
          raw.relayRoom.status === "submitted" ||
          raw.relayRoom.status === "cancelled" ||
          raw.relayRoom.status === "expired" ||
          raw.relayRoom.status === "open"
            ? raw.relayRoom.status
            : undefined,
      } satisfies RelayRoomRef
    : undefined;
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
    relayRoom: relayRoom?.roomId ? relayRoom : undefined,
  };
}

function loadDrafts() {
  return readJsonArray(TX_STORAGE_KEY, migrateDraft);
}

function saveDrafts(drafts: TxDraft[]) {
  const sanitized = drafts.map((draft) =>
    draft.relayRoom
      ? {
          ...draft,
          relayRoom: {
            roomId: draft.relayRoom.roomId,
            createdAt: draft.relayRoom.createdAt,
            lastSyncAt: draft.relayRoom.lastSyncAt,
            sharedInviteUrl: draft.relayRoom.sharedInviteUrl,
            status: draft.relayRoom.status,
          } as RelayRoomRef,
        }
      : draft,
  );
  if (typeof window !== "undefined") window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(sanitized, null, 2));
}

function draftRelayFingerprint(draft: TxDraft) {
  return JSON.stringify({
    status: draft.status,
    txHash: draft.txHash,
    relayStatus: draft.relayRoom?.status,
    signatures: draft.signatures
      .map((signature) => [
        normalizeKeyHash(signature.matchedSignerKeyHash || signature.signerKeyHash || ""),
        signature.matchStatus || "",
        signature.relayWitnessId || "",
        signature.witnessCbor,
      ])
      .sort(),
  });
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

const RELAY_INVITE_SESSION_KEY = "cardano-multisig.relay-invite.session.v1";

function readRelayInviteSession() {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(RELAY_INVITE_SESSION_KEY) || "null") as unknown;
    if (!isRecord(parsed) || typeof parsed.token !== "string") return null;
    return { token: parsed.token, draftId: typeof parsed.draftId === "string" ? parsed.draftId : undefined };
  } catch {
    return null;
  }
}

function writeRelayInviteSession(token: string, room: RelayRoomSignerView) {
  window.sessionStorage.setItem(
    RELAY_INVITE_SESSION_KEY,
    JSON.stringify({ token, draftId: room.tx.draftId, roomId: room.roomId, savedAt: nowIso() }),
  );
}

function clearRelayInviteSession() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(RELAY_INVITE_SESSION_KEY);
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
  const [relayInviteToken, setRelayInviteToken] = useState<string | null>(null);
  const [relayInviteRoom, setRelayInviteRoom] = useState<RelayRoomSignerView | null>(null);
  const [relayInviteSyncedAt, setRelayInviteSyncedAt] = useState<string | null>(null);
  const [relayInviteSyncing, setRelayInviteSyncing] = useState(false);
  const [signaturePackage, setSignaturePackage] = useState("");
  const [status, setStatus] = useState("");
  const [walletSearch, setWalletSearch] = useState("");
  const [copyingInviteId, setCopyingInviteId] = useState<string | null>(null);
  const signaturePanelRef = useRef<HTMLDivElement>(null);

  async function loadRelayInvite(token: string, options: { quiet?: boolean } = {}) {
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "session", token }),
    });
    const body = (await response.json()) as RelayRoomSessionResponse | { ok: false; error?: string };
    if (!response.ok || !body.ok || body.role !== "signer") {
      throw new Error(("error" in body && body.error) || "Could not load the relay signer room.");
    }
    setRelayInviteToken(token);
    setRelayInviteRoom(body.room);
    setRelayInviteSyncedAt(nowIso());
    setActiveDraftId(body.room.tx.draftId);
    writeRelayInviteSession(token, body.room);
    if (!options.quiet) {
      setStatus(
        body.room.signer.alreadyDelivered
          ? "Signature already delivered to the coordinator. You can close this page or sign again to replace it."
          : "Relay invite loaded. Review the transaction below, connect a signer wallet, then click Sign.",
      );
    }
    return body.room;
  }

  async function refreshRelayInvite() {
    if (!relayInviteToken) return;
    setRelayInviteSyncing(true);
    try {
      const room = await loadRelayInvite(relayInviteToken, { quiet: true });
      setStatus(
        room.signer.alreadyDelivered
          ? "Signature already delivered to the coordinator. The live relay state is up to date."
          : "Relay signer room refreshed.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not refresh the relay signer room.");
    } finally {
      setRelayInviteSyncing(false);
    }
  }

  useEffect(() => {
    const loadedWallets = loadWallets();
    const loadedDrafts = loadDrafts();
    setWallets(loadedWallets);
    setDrafts(loadedDrafts);

    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const relay = hashParams.get("r") || hashParams.get("relay");
    const invite = hashParams.get("invite");
    if (relay) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setStatus("Loading relay signer room…");
      void loadRelayInvite(relay).catch((error) => {
        setRelayInviteToken(null);
        setRelayInviteRoom(null);
        setStatus(
          error instanceof Error
            ? `${error.message} If needed, ask the coordinator for a fresh relay link or the advanced witness package fallback.`
            : "Could not load the relay signer room.",
        );
      });
      setHydrated(true);
      return;
    }
    const restoredRelay = readRelayInviteSession();
    if (restoredRelay?.token) {
      setStatus("Restoring relay signer room...");
      void loadRelayInvite(restoredRelay.token).catch((error) => {
        clearRelayInviteSession();
        setRelayInviteToken(null);
        setRelayInviteRoom(null);
        setStatus(error instanceof Error ? error.message : "Could not restore the relay signer room.");
      });
      setHydrated(true);
      return;
    }
    if (invite) {
      clearRelayInviteSession();
      const draft = decodeInvite(invite, migrateDraft);
      if (!draft) {
        setStatus("Invite link is malformed. Ask the coordinator to copy the signer invite again.");
        setHydrated(true);
        return;
      }
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setDrafts(loadedDrafts.some((item) => item.id === draft.id) ? loadedDrafts : [draft, ...loadedDrafts]);
      setActiveDraftId(draft.id);
      setStatus("Invite loaded. Review the transaction below, connect a signer wallet, then click Sign.");
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

  useEffect(() => {
    if (!relayInviteToken) return;
    let cancelled = false;
    const sync = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const room = await loadRelayInvite(relayInviteToken, { quiet: true });
        if (!cancelled && room.progress.matchedCount >= room.progress.requiredSignatures) {
          setStatus("Threshold reached. You can close this page.");
        }
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Could not refresh the relay signer room.");
      }
    };
    const interval = window.setInterval(() => {
      void sync();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [relayInviteToken]);

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

  const activeDraft = activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) ?? null : null;
  const visibleDraft = relayInviteRoom ? draftFromRelaySignerView(relayInviteRoom) : activeDraft;
  const relayInviteActive = Boolean(relayInviteRoom && relayInviteToken);
  const relayRoomSyncKey = useMemo(
    () =>
      drafts
        .filter((draft) => draft.relayRoom?.roomId)
        .map((draft) => `${draft.id}:${draft.relayRoom?.roomId}`)
        .sort()
        .join("|"),
    [drafts],
  );
  const activeNetworkWarning =
    connected && visibleDraft && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(visibleDraft.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this transaction targets ${formatTargetNetwork(visibleDraft.network)}.`
      : "";

  async function refreshHomeRelayRooms(sourceDrafts: TxDraft[] = drafts) {
    const relayDrafts = sourceDrafts.filter((draft) => draft.relayRoom?.roomId);
    if (!relayDrafts.length) return;

    const rooms = await Promise.all(
      relayDrafts.map(async (draft) => {
        const roomId = draft.relayRoom?.roomId;
        if (!roomId) return null;
        const response = await fetch("/api/cardano/relay-room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: "view", roomId }),
        });
        const body = (await response.json()) as RelayRoomSessionResponse | { ok: false; error?: string };
        if (!response.ok || !body.ok || body.role !== "signer") return null;
        return { draftId: draft.id, room: body.room };
      }),
    );

    const roomsByDraftId = new Map(rooms.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.draftId, item.room]));
    if (!roomsByDraftId.size) return;

    setDrafts((current) =>
      current.map((draft) => {
        const room = roomsByDraftId.get(draft.id);
        if (!room) return draft;
        const synced = applyRelayRoomToDraft(draft, room);
        const next: TxDraft = {
          ...synced,
          relayRoom: {
            ...draft.relayRoom,
            ...synced.relayRoom,
            roomId: room.roomId,
            createdAt: draft.relayRoom?.createdAt || nowIso(),
            lastSyncAt: nowIso(),
            status: room.status,
          },
        };
        return draftRelayFingerprint(next) === draftRelayFingerprint(draft) ? draft : next;
      }),
    );
  }

  useEffect(() => {
    if (!hydrated || !relayRoomSyncKey) return;
    let cancelled = false;
    const sync = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      await refreshHomeRelayRooms().catch(() => undefined);
    };
    void sync();
    const interval = window.setInterval(() => {
      void sync();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hydrated, relayRoomSyncKey]);

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
    toast.success("Wallet imported", {
      description: "Open it to create transactions and track signer progress.",
    });
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
      toast.error("Address lookup failed", {
        description: error instanceof Error ? error.message : "Could not inspect that address yet.",
      });
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
    toast.success(recoveredPayment ? "Multisig wallet imported" : "Watch-only wallet saved", {
      description: recoveredPayment ? "Native script recovered automatically." : "Import the script later to create transactions.",
    });
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
    toast.success("Wallet created", {
      description: "Open it to build transactions and share signer invites.",
    });
  }

  async function copyScript() {
    await navigator.clipboard.writeText(scriptJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
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

  async function syncExistingWitnessesToRelayRoom(draft: TxDraft, relayRoom: RelayRoomRef) {
    if (!draft.signatures?.length || (!relayRoom.sharedInviteUrl && !relayRoom.signerInvites?.length)) return;
    await Promise.all(
      draft.signatures
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

  async function ensureHomeRelayRoom(draft: TxDraft) {
    if (draft.relayRoom?.roomId && draft.relayRoom.sharedInviteUrl) {
      await syncExistingWitnessesToRelayRoom(draft, draft.relayRoom);
      return draft.relayRoom;
    }
    if (!draft.unsignedTxCbor.trim()) throw new Error("This transaction has no unsigned tx CBOR yet, so a short relay link cannot be created.");
    const wallet = wallets.find((item) => item.id === draft.walletId || item.name === draft.walletName);
    const response = await fetch("/api/cardano/relay-room", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intent: "create",
        network: draft.network,
        draft: {
          draftId: draft.id,
          walletId: draft.walletId,
          walletName: draft.walletName,
          title: draft.title,
          note: draft.note,
          recipient: draft.recipient,
          lovelace: draft.lovelace,
          assets: normalizeRelayAssetLines(draft),
          unsignedTxCbor: draft.unsignedTxCbor,
          requiredSignatures: draft.requiredSignatures,
          signerKeyHashes: draft.signerKeyHashes,
          paymentScript: wallet?.paymentScript,
          stakeScript: wallet?.stakeScript ?? null,
        },
        signers: draft.signerKeyHashes.map((keyHash) => ({
          keyHash,
          label: wallet?.signers.find((signer) => signer.keyHash.toLowerCase() === keyHash.toLowerCase())?.label,
        })),
        witnesses: draft.signatures || [],
      }),
    });
    const body = (await response.json()) as RelayRoomCreateResponse | { ok: false; error?: string };
    if (!response.ok || !body.ok) throw new Error(("error" in body && body.error) || "Could not create the short relay invite.");
    const relayRoom: RelayRoomRef = {
      roomId: body.roomId,
      coordinatorToken: body.coordinatorToken,
      sharedInviteUrl: body.sharedInviteUrl,
      signerInvites: body.signerInvites,
      createdAt: nowIso(),
      status: "open",
    };
    setDrafts((current) => current.map((item) => (item.id === draft.id ? { ...item, relayRoom, updatedAt: nowIso() } : item)));
    return relayRoom;
  }

  async function copyInvite(draft: TxDraft) {
    setCopyingInviteId(draft.id);
    setStatus("Preparing short signer link…");
    try {
      const relayRoom = await ensureHomeRelayRoom(draft);
      if (!relayRoom.sharedInviteUrl) throw new Error("Relay room exists, but the shared signer link could not be found.");
      await navigator.clipboard.writeText(relayRoom.sharedInviteUrl);
      setStatus("One signer link copied. Send this same link to every signer; each person opens it, connects their wallet, and signs.");
      toast.success("Signer link copied", {
        description: "Send the same link to every signer.",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create the short signer link.");
      toast.error("Could not copy signer link", {
        description: error instanceof Error ? error.message : "Could not create the short signer link.",
      });
    } finally {
      setCopyingInviteId(null);
    }
  }

  function openTransactionRoom(draftId: string) {
    clearRelayInviteSession();
    setRelayInviteToken(null);
    setRelayInviteRoom(null);
    setActiveDraftId(draftId);
    setStatus("Transaction room opened.");
    toast("Transaction room opened");
    window.requestAnimationFrame(() => {
      signaturePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function signActiveDraft() {
    if (!visibleDraft || !connected) return;
    if (activeNetworkWarning) {
      setStatus(activeNetworkWarning);
      toast.warning("Wrong wallet network", { description: activeNetworkWarning });
      return;
    }
    if (!visibleDraft.unsignedTxCbor.trim()) {
      setStatus("This invite is missing unsigned transaction CBOR, so a wallet cannot sign it yet.");
      toast.error("Unsigned transaction missing");
      return;
    }
    try {
      setStatus(`Requesting ${connected.name} signature…`);
      const signerKeyHash = connected.keyHash?.toLowerCase() || `unknown-${connected.id}`;
      const witnessCbor = await connected.api.signTx(visibleDraft.unsignedTxCbor.trim(), true);
      if (relayInviteRoom && relayInviteToken) {
        const response = await fetch("/api/cardano/relay-room", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            intent: "sign",
            token: relayInviteToken,
            witnessCbor,
            walletName: connected.name,
            signerName: connected.keyHash ? connected.keyHash.toLowerCase() : connected.name,
            signedAt: nowIso(),
          }),
        });
        const body = (await response.json()) as
          | { ok: true; thresholdReached: boolean; matchStatus: "matched" | "unmatched"; submission?: { txHash: string }; autoSubmitError?: string }
          | { ok: false; error?: string };
        if (!response.ok || !body.ok) {
          throw new Error(("error" in body && body.error) || "Could not deliver the signature to the coordinator.");
        }
        const refreshed = await loadRelayInvite(relayInviteToken);
        setSignaturePackage("");
        if (body.matchStatus === "unmatched") {
          setStatus(
            "Witness delivered to the coordinator, but it did not match the expected signer key hash for this invite. The coordinator will see it as non-counting.",
          );
          toast.warning("Witness delivered but unmatched", {
            description: "The coordinator will see it as non-counting.",
          });
          return;
        }
        if (body.submission?.txHash || refreshed.status === "submitted") {
          setStatus(`Signature delivered. Transaction submitted${body.submission?.txHash ? `: ${body.submission.txHash}` : "."}`);
          toast.success("Transaction submitted", {
            description: body.submission?.txHash || "Threshold reached and relay submit completed.",
          });
          return;
        }
        if (body.autoSubmitError) {
          setStatus(`Signature delivered, but automatic submit failed: ${body.autoSubmitError}`);
          toast.warning("Signature delivered", {
            description: `Automatic submit failed: ${body.autoSubmitError}`,
          });
          return;
        }
        setStatus(
          body.thresholdReached || refreshed.progress.matchedCount >= refreshed.progress.requiredSignatures
            ? "Threshold reached. The coordinator can submit manually if automatic relay submit has not completed yet."
            : "Signature delivered to the coordinator. You can close this page.",
        );
        toast.success("Signature delivered", {
          description:
            body.thresholdReached || refreshed.progress.matchedCount >= refreshed.progress.requiredSignatures
              ? "Threshold reached."
              : "The coordinator room updated automatically.",
        });
        return;
      }
      const signature: SignatureRecord = {
        signerKeyHash,
        matchStatus: connected.keyHash ? "matched" : "unmatched",
        signerName: connected.keyHash ? connected.keyHash.toLowerCase() : connected.name,
        walletName: connected.name,
        witnessCbor,
        signedAt: nowIso(),
      };
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === visibleDraft.id
            ? { ...draft, signatures: mergeSignatures(draft.signatures, [signature]), updatedAt: nowIso() }
            : draft,
        ),
      );
      setSignaturePackage(createSignaturePackage(visibleDraft.id, [signature]));
      setStatus(
        connected.keyHash
          ? "Witness captured. Copy the witness package and send it back to the coordinator."
          : "Witness captured, but the signer key hash could not be verified automatically. The coordinator will see it as unmatched until they confirm the signer.",
      );
      toast.success("Witness captured", {
        description: connected.keyHash ? "Copy the witness package fallback if needed." : "Signer key hash could not be verified automatically.",
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Wallet refused to sign.");
      toast.error("Wallet refused to sign", {
        description: error instanceof Error ? error.message : "The signing request was cancelled or rejected.",
      });
    }
  }

  function importSignature() {
    try {
      const { draftId, signatures } = parseSignaturePackage(signaturePackage);
      if (!signatures.length) throw new Error("The signature package does not contain any signatures.");
      const target = drafts.find((draft) => draft.id === draftId);
      if (!target) throw new Error("This signature package belongs to a different transaction room.");
      const verifiedSignatures = verifySignatureRecordsForDraft(target, signatures);
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === draftId
            ? { ...draft, signatures: mergeSignatures(draft.signatures, verifiedSignatures), updatedAt: nowIso() }
            : draft,
        ),
      );
      setActiveDraftId(draftId);
      setStatus(`Imported ${signatures.length} signature${signatures.length === 1 ? "" : "s"}.`);
      toast.success("Witness package imported", {
        description: `${signatures.length} signature${signatures.length === 1 ? "" : "s"} merged.`,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invalid signature package.");
      toast.error("Invalid witness package", {
        description: error instanceof Error ? error.message : "Could not parse the signature package.",
      });
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
    toast("Unmatched witnesses removed");
  }

  async function copySignaturePackage() {
    if (!signaturePackage.trim()) return;
    await navigator.clipboard.writeText(signaturePackage);
    setStatus("Witness package copied.");
    toast.success("Witness package copied");
  }

  return (
    <div id="home" className="flex scroll-mt-24 flex-col gap-6">
      {visibleDraft ? (
        <div ref={signaturePanelRef}>
        <AppWindow title="Pending signature request" className="border-emerald-400/25">
          <div className="px-5 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#202124] text-zinc-300 ring-1 ring-white/6">
                  <ShieldCheck className="size-6" />
                </div>
                <div className="min-w-0">
                  <h2 className="break-words text-2xl font-semibold leading-tight text-zinc-50">Sign {visibleDraft.title}</h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    {visibleDraft.walletName} · {visibleDraft.requiredSignatures}-of-{visibleDraft.signerKeyHashes.length || visibleDraft.requiredSignatures}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {relayInviteActive ? (
                  <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-200">
                    synced {relativeTime(relayInviteSyncedAt || undefined)}
                  </Badge>
                ) : null}
                <Badge variant="secondary">
                  <Clock className="size-3" /> {pendingSignatureCount(visibleDraft) <= 0 ? "ready" : `${pendingSignatureCount(visibleDraft)} more`}
                </Badge>
              </div>
            </div>
          </div>
          <div className="grid min-w-0 gap-6 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 rounded-xl border border-border bg-[#111114] p-4 sm:p-5">
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-400">Required signatures</div>
                    <div className="mt-1 text-3xl font-semibold text-zinc-50">
                      {signatureCount(visibleDraft)} / {visibleDraft.requiredSignatures}
                    </div>
                    <div className="mt-2 break-all text-sm text-zinc-400">Recipient: {visibleDraft.recipient || "Not provided"}</div>
                  </div>
                  <Avatar label={visibleDraft.walletName} tone={pendingSignatureCount(visibleDraft) ? "primary" : "success"} />
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span>Required signatures</span>
                    <span>{signatureCount(visibleDraft)} / {visibleDraft.requiredSignatures}</span>
                  </div>
                  <Progress value={signatureCount(visibleDraft)} max={visibleDraft.requiredSignatures} />
                </div>
                <div className="mt-5 space-y-3">
                  {visibleDraft.signerKeyHashes.map((hash, index) => {
                    const signed = hasMatchedSignature(visibleDraft, hash);
                    const isConnectedSigner = Boolean(connected?.keyHash && normalizeKeyHash(connected.keyHash) === normalizeKeyHash(hash));
                    const signature = visibleDraft.signatures.find(
                      (item) => normalizeKeyHash(item.matchedSignerKeyHash || item.signerKeyHash || "") === normalizeKeyHash(hash),
                    );
                    const label = isConnectedSigner ? `Signer ${index + 1} · You` : `Signer ${index + 1}`;
                    return (
                      <div
                        key={hash}
                        className={cn(
                          "flex min-w-0 items-center justify-between gap-4 overflow-hidden rounded-xl border p-3",
                          signed ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/7 bg-black/20",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar label={label} tone={signed ? "success" : "muted"} />
                          <div className="min-w-0">
                            <div className="font-semibold text-zinc-50">{label}</div>
                            <div className="truncate font-mono text-xs text-zinc-500" title={hash}>{shortHash(hash)}</div>
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
                            signed ? "border-emerald-400 text-emerald-300" : "border-white/10 text-transparent",
                          )}
                        >
                          <Check className="size-4" />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {visibleDraft.note ? <div className="mt-4 break-words text-sm text-zinc-300">Coordinator note: {visibleDraft.note}</div> : null}
              </div>
              {optionalSignerKeyHashes(visibleDraft).length && pendingSignatureCount(visibleDraft) === 0 ? (
                <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                  Threshold reached. {optionalSignerKeyHashes(visibleDraft).length} policy signer{optionalSignerKeyHashes(visibleDraft).length === 1 ? "" : "s"} can still sign, but they are no longer required for submit.
                </div>
              ) : null}
              {(visibleDraft.assets?.length ? visibleDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: visibleDraft.lovelace || "0", decimals: 6 }]).length ? (
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Assets</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(visibleDraft.assets?.length ? visibleDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: visibleDraft.lovelace || "0", decimals: 6 }]).map((asset) => (
                      <div key={asset.id} className="rounded-full border border-border px-3 py-1 text-sm text-slate-200">
                        {formatRawQuantity(asset.quantity, asset.unit, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {unmatchedSignatureCount(visibleDraft) ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                  <span>
                    {unmatchedSignatureCount(visibleDraft)} unmatched signature{unmatchedSignatureCount(visibleDraft) === 1 ? " is" : "s are"} stored locally and will not count toward submit.
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => discardUnmatchedSignatures(visibleDraft.id)}>
                    <Trash2 className="size-4" /> Remove unmatched
                  </Button>
                </div>
              ) : null}
              {relayInviteActive ? (
                <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                  <div className="font-semibold">Automatic relay is active</div>
                  <div className="mt-1">
                    {relayInviteRoom?.signer.alreadyDelivered
                      ? "Your witness is already delivered to the coordinator. You can close this page or sign again to replace it."
                      : "This invite keeps the unsigned transaction details on the server and delivers the witness back automatically after signing."}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                  Privacy note: this invite carries the recipient, asset amounts, coordinator note, signer list, and unsigned tx CBOR in the URL fragment. After load it is kept only in this browser's local storage, so use a trusted device and clear site data when the signing handoff is complete.
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <Card className="border-border bg-slate-950/60">
                <CardHeader>
                  <CardTitle className="text-base">{relayInviteActive ? "Automatic relay" : "Next signer step"}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-300">
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">1. Connect the signer wallet above.</div>
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">2. Confirm the wallet is on {formatTargetNetwork(visibleDraft.network)}.</div>
                  <div className="rounded-lg border border-border bg-slate-900/70 p-3">
                    {relayInviteActive
                      ? "3. Click Sign. Your witness is delivered back to the coordinator automatically."
                      : "3. Click Sign, then copy the witness package back to the coordinator."}
                  </div>
                  {relayInviteActive ? (
                    <div className="rounded-lg border border-border bg-slate-900/70 p-3">
                      Live status: {signatureCount(visibleDraft)} of {visibleDraft.requiredSignatures} required signatures synced {relativeTime(relayInviteSyncedAt || undefined)}.
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              {activeNetworkWarning ? (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">{activeNetworkWarning}</div>
              ) : null}
              <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" onClick={() => void signActiveDraft()} disabled={!connected || !visibleDraft.unsignedTxCbor.trim()}>
                <ShieldCheck className="size-4" /> {relayInviteRoom?.signer.alreadyDelivered ? "Sign again and replace" : relayInviteActive ? "Sign and deliver" : "Sign loaded invite"}
              </Button>
              {relayInviteActive ? (
                <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={() => void refreshRelayInvite()} disabled={relayInviteSyncing}>
                  <RefreshCw className={cn("size-4", relayInviteSyncing ? "animate-spin" : "")} /> Refresh live status
                </Button>
              ) : null}
              {!relayInviteActive ? (
                <Button className="h-auto min-h-10 w-full whitespace-normal px-3 py-2" variant="secondary" onClick={copySignaturePackage} disabled={!signaturePackage.trim()}>
                  <Copy className="size-4" /> Copy witness package
                </Button>
              ) : null}
            </div>
          </div>
        </AppWindow>
        </div>
      ) : null}

      {!visibleDraft ? (
        <AppWindow title="Workspace" contentClassName="p-5">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-200">
                  {DEFAULT_NETWORK}
                </Badge>
                <Badge variant="secondary">
                  {wallets.length} wallet{wallets.length === 1 ? "" : "s"}
                </Badge>
                <Badge variant="secondary">
                  {drafts.length} transaction{drafts.length === 1 ? "" : "s"}
                </Badge>
              </div>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-50">Cardano multisig workspace</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
                Use this page to start a wallet or handle an incoming signer link. Wallet management and transaction tracking now live in their own pages.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button type="button" onClick={() => setWalletDialogOpen(true)}>
                  <Import className="size-4" /> Import or create
                </Button>
                <Button asChild variant="secondary">
                  <Link to="/wallets">
                    <WalletCards className="size-4" /> Wallets
                  </Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link to="/transactions">
                    <Users className="size-4" /> Transactions
                  </Link>
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              <Link to="/wallets" className="group rounded-lg border border-border bg-black/20 p-4 transition hover:border-white/18 hover:bg-white/[0.04]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-zinc-50">Manage wallets</div>
                    <div className="mt-1 text-sm text-zinc-400">Open saved multisig policies and signer rules.</div>
                  </div>
                  <ArrowRight className="size-5 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-zinc-200" />
                </div>
              </Link>
              <Link to="/transactions" className="group rounded-lg border border-border bg-black/20 p-4 transition hover:border-white/18 hover:bg-white/[0.04]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold text-zinc-50">Track transactions</div>
                    <div className="mt-1 text-sm text-zinc-400">Review signature progress and coordinator rooms.</div>
                  </div>
                  <ArrowRight className="size-5 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-zinc-200" />
                </div>
              </Link>
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
            <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="import">
                  <Import className="size-4" /> import
                </TabsTrigger>
                <TabsTrigger value="create">
                  <Plus className="size-4" /> create
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {mode === "import" ? (
            <>
              <Tabs value={importMode} onValueChange={(value) => setImportMode(value as ImportMode)}>
                <TabsList className="grid w-full grid-cols-3">
                  {([
                    { id: "export", label: "Script", icon: FileJson },
                    { id: "address", label: "Address", icon: Search },
                    { id: "signer", label: "Signer", icon: WalletCards },
                  ] as { id: ImportMode; label: string; icon: typeof FileJson }[]).map((item) => (
                    <TabsTrigger key={item.id} value={item.id} className="min-w-0 px-2">
                      <item.icon className="size-3.5 shrink-0" />
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

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
                  {addressDiscoveryError ? (
                    <Card>
                      <CardContent className="p-4 text-sm text-muted-foreground">{addressDiscoveryError}</CardContent>
                    </Card>
                  ) : null}
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
                        <Card>
                          <CardContent className="p-4 text-sm text-muted-foreground">
                          Native script recovered from a historical transaction witness. This can be imported as a full multisig wallet without pasting script JSON.
                          <div className="mt-1 break-all font-mono text-xs">tx {addressDiscovery.recoveredScript.txHash}</div>
                          </CardContent>
                        </Card>
                      ) : (
                        <Card>
                          <CardContent className="p-4 text-sm text-muted-foreground">
                          No historical native-script witness was found for this address yet. Save it as watch-only now, or import a wallet export/native script later to create transactions.
                          </CardContent>
                        </Card>
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
                      <Card className="mt-3">
                        <CardContent className="p-4 text-sm text-muted-foreground">{signerSearchError}</CardContent>
                      </Card>
                    ) : null}
                  </div>

                  {activeSignerKeyHash && !signerWalletMatches.length ? (
                    <Card>
                      <CardContent className="p-4 text-sm text-muted-foreground">No saved multisigs in this browser match this signer yet. Import by address/ADA Handle or wallet export first, then rerun the signer search.</CardContent>
                    </Card>
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
          <Collapsible className="rounded-xl border border-white/8 bg-black/20 px-5 py-4 text-zinc-200">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="h-auto justify-start p-0 text-sm font-semibold text-zinc-100 hover:bg-transparent">
                Advanced witness import
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 space-y-3">
              <p className="text-sm text-zinc-400">Paste a returned witness package from any signer. Both legacy and new formats still work here.</p>
              <Textarea value={signaturePackage} onChange={(event) => setSignaturePackage(event.target.value)} placeholder="Paste witness package JSON here" className="min-h-40 font-mono text-xs" />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={importSignature}>Import witness package</Button>
                {activeDraft ? <Button variant="ghost" onClick={() => setActiveDraftId(activeDraft.id)}>Back to active room</Button> : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
          </DialogBody>
        </DialogContent>
      </Dialog>

      {false ? (
      <>
      <section id="wallets" className="scroll-mt-24">
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
              <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 max-sm:w-full">
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
            <>
              <div className="grid gap-3 p-5">
                {visibleWallets.map((wallet) => {
                  const isWatchOnly = !wallet.paymentScript && Boolean(wallet.discovery?.address);
                  const title = wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name;
                  const assetCount = wallet.discovery?.assets?.length || 0;
                  const walletRooms = drafts.filter((draft) => draft.walletId === wallet.id);
                  const readyRooms = walletRooms.filter((draft) => pendingSignatureCount(draft) <= 0).length;
                  const missingForWallet = walletRooms.reduce((total, draft) => total + pendingSignatureCount(draft), 0);
                  return (
                    <article key={wallet.id} className="min-w-0 overflow-hidden rounded-xl border border-border bg-black/20 p-4 shadow-sm">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-white/5 text-zinc-300 ring-1 ring-white/10">
                          <WalletCards className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <Link to={walletHref(wallet)} className="block w-full max-w-[calc(100vw-8rem)] truncate font-semibold text-zinc-50 underline-offset-4 hover:underline">
                            {title}
                          </Link>
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                            <span className="sr-only">
                              {title}
                            </span>
                            <Badge variant="outline" className="shrink-0 border-white/10 text-zinc-400">{wallet.network}</Badge>
                            <Badge
                              variant={isWatchOnly ? "outline" : wallet.imported ? "default" : "secondary"}
                              className={cn(
                                "shrink-0",
                                isWatchOnly ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "",
                                wallet.imported && !isWatchOnly ? "bg-zinc-100 text-zinc-950" : "",
                              )}
                            >
                              {isWatchOnly ? "watch-only" : wallet.imported ? "imported" : "created"}
                            </Badge>
                          </div>
                          <div className="mt-1 break-all text-xs text-zinc-500">
                            {isWatchOnly ? wallet.discovery?.address : wallet.handle ? wallet.name : wallet.id}
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 text-sm text-zinc-300">
                        <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Policy</div>
                          {isWatchOnly ? (
                            <div className="mt-1">
                              <div>{assetCount} visible asset{assetCount === 1 ? "" : "s"}</div>
                              <div className="mt-1 text-xs text-zinc-500">native script still needed to spend</div>
                            </div>
                          ) : (
                            <div className="mt-1 space-y-1">
                              <div>payment {summarizeScript(wallet.paymentScript)}</div>
                              <div className="text-xs text-zinc-500">stake {summarizeScript(wallet.stakeScript ?? null)}</div>
                            </div>
                          )}
                        </div>

                        <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Activity</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <span className="rounded-md border border-white/8 bg-black/20 px-2 py-1 text-zinc-300">
                              {walletRooms.length} room{walletRooms.length === 1 ? "" : "s"}
                            </span>
                            {readyRooms ? (
                              <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-emerald-200">{readyRooms} ready</span>
                            ) : null}
                            {missingForWallet ? (
                              <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-amber-200">{missingForWallet} missing</span>
                            ) : null}
                          </div>
                        </div>

                        <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
                          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Signers</div>
                          {isWatchOnly ? (
                            <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                              <Avatar label={title} className="size-8 border border-[#121214]" />
                              <span>watch address</span>
                            </div>
                          ) : (
                            <div className="mt-2 flex min-w-0 items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-2">
                                <div className="-space-x-2 whitespace-nowrap">
                                  {wallet.signers.slice(0, 5).map((signer, index) => (
                                    <Avatar key={signer.id} label={signer.label || `Signer ${index + 1}`} className="size-8 border border-[#121214]" />
                                  ))}
                                </div>
                                {wallet.signers.length > 5 ? <span className="text-xs text-zinc-500">+{wallet.signers.length - 5}</span> : null}
                              </div>
                              <div className="shrink-0 text-xs text-zinc-500">{wallet.threshold}-of-{wallet.signers.length} required</div>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <Button asChild className="min-w-0">
                          <Link to={walletHref(wallet)}>
                            {isWatchOnly ? "Open watch" : "Open"} <ArrowRight className="size-4" />
                          </Link>
                        </Button>
                        <Button size="sm" variant="secondary" className="h-10 min-w-0" onClick={() => downloadJson(`${slugify(wallet.name)}-wallet.json`, wallet)}>
                          <Download className="size-4" /> Export
                        </Button>
                        <Button size="sm" variant="destructive" className="col-span-2 h-10 min-w-0 sm:col-span-1" onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}>
                          <Trash2 className="size-4" /> Delete
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>

            </>
          )}
        </AppWindow>
      </section>

      <section id="transactions" className="scroll-mt-24">
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
                  "min-w-0 overflow-hidden rounded-lg border p-4 transition hover:border-white/18",
                  activeDraftId === draft.id ? "border-sky-400/50 bg-sky-400/10" : "border-border bg-black/20",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar label={draft.walletName} tone={pendingSignatureCount(draft) ? "primary" : "success"} />
                    <div className="min-w-0">
                      <h3 className="break-words font-semibold text-slate-100">{draft.title}</h3>
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
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-slate-500">
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
                  <Button className="min-w-20 flex-1" variant="default" size="sm" onClick={() => openTransactionRoom(draft.id)}>Open</Button>
                  <Button className="min-w-20 flex-1" variant="secondary" size="sm" onClick={() => void copyInvite(draft)} disabled={copyingInviteId === draft.id}>
                    <Link2 className="size-4" /> {copyingInviteId === draft.id ? "Copying…" : "Invite"}
                  </Button>
                  {unmatchedSignatureCount(draft) ? (
                    <Button className="min-w-28 flex-1" variant="secondary" size="sm" onClick={() => discardUnmatchedSignatures(draft.id)}>
                      <Trash2 className="size-4" /> Unmatched
                    </Button>
                  ) : null}
                  <Button className="min-w-24 flex-1" variant="destructive" size="sm" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2 className="size-4" /> Delete</Button>
                </div>
              </article>
            ))}
          </CardContent>
        </Card>
      ) : null}
      </section>
      </>
      ) : null}

      {status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}
    </div>
  );
}
