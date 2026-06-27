import { Check, Copy, Download, Import, Plus, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/home";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
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
  parseSignaturePackage,
  pendingSignatureCount,
  signatureCount,
  slugify,
  summarizeScript,
  uniqueSigners,
  unmatchedSignatureCount,
  requiredSignatures,
} from "../lib/multisig";

type Mode = "import" | "create";
type ParsedScript = { script: NativeScript | null; error: string | null; format: "json" | "cbor" | "empty" };
type CardanoWalletApi = {
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getNetworkId(): Promise<number>;
  signTx(txCbor: string, partialSign?: boolean): Promise<string>;
  submitTx?(txCbor: string): Promise<string>;
};
type WalletProvider = { id: string; name: string; icon?: string; enable(): Promise<CardanoWalletApi> };
type ConnectedWallet = { id: string; name: string; api: CardanoWalletApi; networkId: number; addressHex: string; keyHash: string | null };
type AssetLine = { id: string; unit: string; label: string; quantity: string };
type ServerProviderStatus = { mode: "server"; network: string; ready: boolean; services: { blockfrost: boolean; kupo: boolean; ogmios: boolean; submit: boolean } };

declare global {
  interface Window {
    cardano?: Record<string, { name?: string; icon?: string; enable?: () => Promise<CardanoWalletApi> }>;
  }
}

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

function migrateWallet(raw: unknown): MultisigWallet | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !isRecord(raw.script)) return null;
  const script = raw.script as NativeScript;
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
    paymentScript: isRecord(raw.paymentScript) ? (raw.paymentScript as NativeScript) : script,
    stakeScript: isRecord(raw.stakeScript) ? (raw.stakeScript as NativeScript) : null,
    script,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    imported: Boolean(raw.imported),
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

function installedWallets(): WalletProvider[] {
  if (typeof window === "undefined" || !window.cardano) return [];
  return Object.entries(window.cardano)
    .filter(([, wallet]) => typeof wallet.enable === "function")
    .map(([id, wallet]) => ({ id, name: wallet.name || id, icon: wallet.icon, enable: wallet.enable!.bind(wallet) }));
}

function signerMatchesDraft(draft: TxDraft, keyHash: string | null) {
  if (!keyHash) return false;
  return draft.signerKeyHashes.some((hash) => hash.toLowerCase() === keyHash.toLowerCase());
}

function signerSummary(draft: TxDraft) {
  return `${signatureCount(draft)}/${draft.requiredSignatures} matched signatures`;
}

function providerReadyLabel(serverProvider: ServerProviderStatus | null) {
  if (!serverProvider) return "Provider status unavailable";
  if (serverProvider.ready) return `${serverProvider.network} provider ready`;
  return `${serverProvider.network} provider needs attention`;
}

function signerCountLabel(draft: TxDraft) {
  const pending = pendingSignatureCount(draft);
  if (pending <= 0) return "All required signers collected";
  return `${pending} signer${pending === 1 ? "" : "s"} still needed`;
}

export default function Home() {
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [drafts, setDrafts] = useState<TxDraft[]>([]);
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  const [serverProvider, setServerProvider] = useState<ServerProviderStatus | null>(null);

  const [mode, setMode] = useState<Mode>("import");
  const [threshold, setThreshold] = useState(2);
  const [signers, setSigners] = useState<Signer[]>([emptySigner("Signer 1"), emptySigner("Signer 2"), emptySigner("Signer 3")]);
  const [importHandle, setImportHandle] = useState("");
  const [paymentScriptText, setPaymentScriptText] = useState("");
  const [stakeScriptText, setStakeScriptText] = useState("");
  const [copied, setCopied] = useState(false);

  const [txTitle, setTxTitle] = useState("Treasury payment");
  const [txRecipient, setTxRecipient] = useState("");
  const [txLovelace, setTxLovelace] = useState("2000000");
  const [txCbor, setTxCbor] = useState("");
  const [txNote, setTxNote] = useState("");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [signaturePackage, setSignaturePackage] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setWallets(loadWallets());
    setDrafts(loadDrafts());
    setProviders(installedWallets());
    fetch("/api/cardano/provider")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setServerProvider(payload))
      .catch(() => setServerProvider(null));

    const invite = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite");
    if (!invite) return;
    const draft = decodeInvite(invite, migrateDraft);
    if (!draft) {
      setStatus("Invite link is malformed. Ask the coordinator to copy the signer invite again.");
      return;
    }
    setDrafts((current) => (current.some((item) => item.id === draft.id) ? current : [draft, ...current]));
    setActiveDraftId(draft.id);
    setStatus("Invite loaded. Review the transaction below, connect a signer wallet, then click Sign.");
  }, []);

  useEffect(() => saveWallets(wallets), [wallets]);
  useEffect(() => saveDrafts(drafts), [drafts]);

  const cleanedSigners = useMemo(() => signers.map(cleanSigner), [signers]);
  const validSigners = cleanedSigners.filter((signer) => isKeyHash(signer.keyHash));
  const clampedThreshold = Math.max(1, Math.min(threshold, validSigners.length || 1));
  const draftScript = useMemo(() => buildNativeScript(validSigners, clampedThreshold), [validSigners, clampedThreshold]);
  const canSave = validSigners.length >= 2 && clampedThreshold <= validSigners.length;
  const scriptJson = JSON.stringify(draftScript, null, 2);

  const parsedPayment = useMemo(() => parseScript(paymentScriptText, true), [paymentScriptText]);
  const parsedStake = useMemo(() => parseScript(stakeScriptText, false), [stakeScriptText]);
  const importedSigners = useMemo(
    () => uniqueSigners([...collectSigners(parsedPayment.script, "payment"), ...collectSigners(parsedStake.script, "stake")]),
    [parsedPayment.script, parsedStake.script],
  );
  const importThreshold = requiredSignatures(parsedPayment.script);
  const canImport = Boolean(parsedPayment.script) && !parsedPayment.error && !parsedStake.error;

  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? drafts[0] ?? null;
  const selectedSignerHashes = (mode === "import" ? importedSigners : validSigners).map((signer) => signer.keyHash);
  const selectedRequired = mode === "import" ? Math.max(importThreshold, 1) : clampedThreshold;
  const activeNetworkWarning =
    connected && activeDraft && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(activeDraft.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this transaction targets ${formatTargetNetwork(activeDraft.network)}.`
      : "";

  async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function connectWallet(provider: WalletProvider) {
    if (connectingWalletId) return;
    setConnectingWalletId(provider.id);
    setStatus(`Open ${provider.name} and approve the connection...`);

    try {
      const api = await withTimeout(
        provider.enable(),
        12000,
        `${provider.name} did not answer. Unlock Eternl/reopen the wallet popup, then try again.`,
      );
      let networkId = -1;
      let addressHex = "";
      let keyHash: string | null = null;
      try {
        networkId = await withTimeout(api.getNetworkId(), 5000, "Network lookup timed out.");
      } catch {
        networkId = -1;
      }
      try {
        const used = await withTimeout(api.getUsedAddresses(), 5000, "Address lookup timed out.");
        const unused = used.length ? [] : await withTimeout(api.getUnusedAddresses(), 5000, "Unused address lookup timed out.");
        addressHex = used[0] || unused[0] || (await withTimeout(api.getChangeAddress(), 5000, "Change address lookup timed out."));
        keyHash = addressHex ? await keyHashFromAddress(addressHex) : null;
      } catch {
        addressHex = "";
        keyHash = null;
      }
      setConnected({ id: provider.id, name: provider.name, api, networkId, addressHex, keyHash });

      if (activeDraft && networkId >= 0 && networkId !== expectedNetworkId(activeDraft.network)) {
        setStatus(`Connected ${provider.name}, but it is on ${networkLabel(networkId)}. Switch to ${formatTargetNetwork(activeDraft.network)} before signing.`);
      } else if (activeDraft && keyHash && !signerMatchesDraft(activeDraft, keyHash)) {
        setStatus(`Connected ${provider.name}, but this key hash is not one of the required signer hashes for the loaded invite.`);
      } else if (keyHash) {
        setStatus(`Connected ${provider.name}. Signer key hash detected, so the witness can be matched automatically.`);
      } else {
        setStatus(`Connected ${provider.name}. Signing still works, but the signer key hash could not be verified automatically.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not connect ${provider.name}.`);
    } finally {
      setConnectingWalletId(null);
    }
  }

  function importWallet() {
    if (!canImport || !parsedPayment.script) return;
    const handle = importHandle.trim().replace(/^\$/, "");
    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name: handle ? `$${handle}` : "Imported wallet",
      handle: handle || undefined,
      network: DEFAULT_NETWORK,
      threshold: importThreshold,
      signers: importedSigners,
      paymentScript: parsedPayment.script,
      stakeScript: parsedStake.script,
      script: parsedPayment.script,
      createdAt: nowIso(),
      imported: true,
    };
    setWallets((current) => [wallet, ...current]);
    setStatus("Wallet imported. Open it to create transactions and track signer progress.");
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
    setStatus("Wallet created. Open it to build transactions and share signer invites.");
  }

  async function copyScript() {
    await navigator.clipboard.writeText(scriptJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function createDraft() {
    const hashes = uniqueSigners(
      selectedSignerHashes.map((keyHash, index) => ({ id: createId("txsigner"), label: `Signer ${index + 1}`, keyHash })),
    ).map((signer) => signer.keyHash);
    const draft: TxDraft = {
      id: createId("tx"),
      title: txTitle.trim() || "Transaction",
      walletName: mode === "import" ? importHandle.trim().replace(/^\$/, "") || "Imported wallet" : "New multisig wallet",
      network: DEFAULT_NETWORK,
      recipient: txRecipient.trim(),
      lovelace: txLovelace.trim(),
      note: txNote.trim(),
      unsignedTxCbor: txCbor.trim(),
      requiredSignatures: Math.min(Math.max(selectedRequired, 1), Math.max(hashes.length, 1)),
      signerKeyHashes: hashes,
      signatures: [],
      assets: [{ id: createId("asset"), unit: "lovelace", label: "ADA", quantity: txLovelace.trim() }],
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    setDrafts((current) => [draft, ...current]);
    setActiveDraftId(draft.id);
    setStatus("Local signing room created. Copy the signer invite link and send it privately.");
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

  async function copySignaturePackage() {
    if (!signaturePackage.trim()) return;
    await navigator.clipboard.writeText(signaturePackage);
    setStatus("Witness package copied.");
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="space-y-4">
          <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">Cardano native scripts</Badge>
          <div className="space-y-3">
            <h1 className="text-4xl font-semibold tracking-[-0.06em] text-slate-50 sm:text-6xl">Signer-friendly multisig control room.</h1>
            <p className="max-w-3xl text-base leading-7 text-slate-400 sm:text-lg">
              Import a wallet once, create transactions from the wallet page, then send each signer a single invite link. Signers only need to review, connect, sign, and return a witness package.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-slate-950/60 p-4">
              <div className="text-sm font-medium text-slate-100">1. Import or create wallet</div>
              <div className="mt-2 text-sm text-slate-400">Save the policy locally, then open the wallet workspace.</div>
            </div>
            <div className="rounded-xl border border-border bg-slate-950/60 p-4">
              <div className="text-sm font-medium text-slate-100">2. Coordinator copies invite</div>
              <div className="mt-2 text-sm text-slate-400">Each transaction gets one private signer link with clear next steps.</div>
            </div>
            <div className="rounded-xl border border-border bg-slate-950/60 p-4">
              <div className="text-sm font-medium text-slate-100">3. Signer connects and signs</div>
              <div className="mt-2 text-sm text-slate-400">Returned witness packages can be imported without blockchain jargon.</div>
            </div>
          </div>
        </div>

        <Card className="glass-panel overflow-hidden">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <WalletCards className="size-4 text-sky-300" /> Signer wallet
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {connected ? `${connected.name} · ${networkLabel(connected.networkId)}` : providers.length ? "Connect a signer wallet" : "No browser wallet detected"}
                </div>
              </div>
              <Badge variant={connected ? "default" : "secondary"}>{connected ? "connected" : "off"}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {providers.map((provider) => (
                <Button
                  key={provider.id}
                  size="sm"
                  variant={connected?.id === provider.id ? "default" : "secondary"}
                  disabled={Boolean(connectingWalletId)}
                  onClick={() => void connectWallet(provider)}
                >
                  {provider.icon ? <img alt="" className="size-4" src={provider.icon} /> : null}
                  {connectingWalletId === provider.id ? "Waiting..." : provider.name}
                </Button>
              ))}
            </div>
            {connected?.keyHash ? (
              <div className="truncate rounded-md border border-border bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-300">{connected.keyHash}</div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                <div className="text-2xl font-semibold text-sky-200">{wallets.length}</div>
                <div className="text-xs text-slate-400">wallets saved</div>
              </div>
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                <div className="text-2xl font-semibold text-emerald-300">{drafts.length}</div>
                <div className="text-xs text-slate-400">transaction rooms</div>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-slate-950/60 p-3 text-sm text-slate-300">
              {providerReadyLabel(serverProvider)}
            </div>
          </CardContent>
        </Card>
      </section>

      {activeDraft ? (
        <Card className="glass-panel border-sky-400/30">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Loaded signer invite</CardTitle>
                <CardDescription>
                  Review the transaction, connect a signer wallet, then sign. The witness package can be copied back to the coordinator.
                </CardDescription>
              </div>
              <Badge variant="secondary">{signerSummary(activeDraft)}</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                <div className="text-sm text-slate-400">Transaction</div>
                <div className="mt-1 text-xl font-semibold text-slate-100">{activeDraft.title}</div>
                <div className="mt-2 text-sm text-slate-400">Recipient: {activeDraft.recipient || "Not provided"}</div>
                {activeDraft.note ? <div className="mt-3 text-sm text-slate-300">Coordinator note: {activeDraft.note}</div> : null}
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Required</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{activeDraft.requiredSignatures} signatures</div>
                </div>
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Matched</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{signatureCount(activeDraft)}</div>
                </div>
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Still needed</div>
                  <div className="mt-1 text-lg font-semibold text-slate-100">{pendingSignatureCount(activeDraft)}</div>
                </div>
              </div>
              {(activeDraft.assets?.length ? activeDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: activeDraft.lovelace || "0" }]).length ? (
                <div className="rounded-xl border border-border bg-slate-950/60 p-4">
                  <div className="text-sm text-slate-400">Assets</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(activeDraft.assets?.length ? activeDraft.assets : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: activeDraft.lovelace || "0" }]).map((asset) => (
                      <div key={asset.id} className="rounded-full border border-border px-3 py-1 text-sm text-slate-200">
                        {asset.quantity} {asset.label}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {unmatchedSignatureCount(activeDraft) ? (
                <div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">
                  {unmatchedSignatureCount(activeDraft)} unmatched signature{unmatchedSignatureCount(activeDraft) === 1 ? " is" : "s are"} stored locally, so the coordinator still needs to confirm who signed.
                </div>
              ) : null}
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
          </CardContent>
        </Card>
      ) : null}

      <Card className="glass-panel">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Saved wallets</CardTitle>
              <CardDescription>Open a wallet to create transactions, copy signer invites, and track who is still missing.</CardDescription>
            </div>
            <Badge variant="secondary">{wallets.length} saved</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {wallets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-slate-950/40 p-8 text-center text-slate-400">
              No wallets saved yet. Import scripts or create a new policy to start.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {wallets.map((wallet) => (
                <article className="rounded-lg border border-border bg-slate-950/55 p-4 transition hover:border-sky-400/50 hover:bg-slate-900/70" key={wallet.id}>
                  <a href={walletHref(wallet)} className="block space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-lg font-semibold text-slate-100">{wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name}</h3>
                      <Badge variant={wallet.imported ? "default" : "secondary"}>{wallet.imported ? "imported" : "created"}</Badge>
                    </div>
                    <p className="text-sm text-slate-400">
                      {wallet.handle ? `${wallet.name} · ` : ""}
                      {wallet.network} · payment {summarizeScript(wallet.paymentScript)} · stake {summarizeScript(wallet.stakeScript ?? null)} · {wallet.signers.length} signers
                    </p>
                    <div className="text-sm font-medium text-sky-200">Open wallet →</div>
                  </a>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                    <Button variant="secondary" onClick={() => downloadJson(`${slugify(wallet.name)}-wallet.json`, wallet)}>
                      <Download className="size-4" /> Export
                    </Button>
                    <Button variant="destructive" onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}>
                      <Trash2 className="size-4" /> Delete
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="glass-panel">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Wallet workspace</CardTitle>
                <CardDescription>Import an existing native script or create a new M-of-N policy.</CardDescription>
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
          </CardHeader>

          {mode === "import" ? (
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label>ADA Handle (optional)</Label>
                <Input value={importHandle} onChange={(event) => setImportHandle(event.target.value)} placeholder="$discatalyst" />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Payment script CBOR / JSON</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPaymentScriptText(SAMPLE_PAYMENT_SCRIPT)}>Load sample</Button>
                </div>
                <Textarea value={paymentScriptText} onChange={(event) => setPaymentScriptText(event.target.value)} placeholder="Paste payment native-script CBOR hex or JSON" className="min-h-48 font-mono text-xs" aria-invalid={Boolean(parsedPayment.error)} />
                {parsedPayment.error ? <p className="text-sm text-red-300">{parsedPayment.error}</p> : null}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Stake script CBOR / JSON</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setStakeScriptText(SAMPLE_STAKE_SCRIPT)}>Load sample</Button>
                </div>
                <Textarea value={stakeScriptText} onChange={(event) => setStakeScriptText(event.target.value)} placeholder="Paste stake native-script CBOR hex or JSON if it has one" className="min-h-32 font-mono text-xs" aria-invalid={Boolean(parsedStake.error)} />
                {parsedStake.error ? <p className="text-sm text-red-300">{parsedStake.error}</p> : null}
              </div>
              <div className="rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-300">
                Detected {importedSigners.length} signer{importedSigners.length === 1 ? "" : "s"} · payment {summarizeScript(parsedPayment.script)} · stake {summarizeScript(parsedStake.script)}
              </div>
              <Button onClick={importWallet} disabled={!canImport}>Save imported wallet</Button>
            </CardContent>
          ) : (
            <CardContent className="space-y-5">
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
                    <Input value={signer.label} onChange={(event) => setSigners((current) => current.map((item) => item.id === signer.id ? { ...item, label: event.target.value } : item))} placeholder={`Signer ${index + 1}`} />
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
            </CardContent>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="glass-panel">
            <CardHeader>
              <CardTitle>Quick local signing room</CardTitle>
              <CardDescription>
                Compatibility helper for local-only flows. The wallet page remains the main coordinator experience.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={txTitle} onChange={(event) => setTxTitle(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Recipient</Label>
                <Input value={txRecipient} onChange={(event) => setTxRecipient(event.target.value)} placeholder="addr_test..." />
              </div>
              <div className="space-y-2">
                <Label>ADA (lovelace)</Label>
                <Input value={txLovelace} onChange={(event) => setTxLovelace(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Coordinator note</Label>
                <Input value={txNote} onChange={(event) => setTxNote(event.target.value)} placeholder="What the signer should verify before approving" />
              </div>
              <div className="space-y-2">
                <Label>Unsigned transaction CBOR</Label>
                <Textarea value={txCbor} onChange={(event) => setTxCbor(event.target.value)} placeholder="Paste unsigned tx CBOR for a local signing room" className="min-h-32 font-mono text-xs" />
              </div>
              <Button onClick={createDraft}>Create local transaction room</Button>
            </CardContent>
          </Card>

          <Card className="glass-panel">
            <CardHeader>
              <CardTitle>Import witness package</CardTitle>
              <CardDescription>Paste a returned witness package from any signer. Both legacy and new formats work.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea value={signaturePackage} onChange={(event) => setSignaturePackage(event.target.value)} placeholder="Paste witness package JSON here" className="min-h-40 font-mono text-xs" />
              <Button variant="secondary" onClick={importSignature}>Import witness package</Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {drafts.length ? (
        <Card className="glass-panel">
          <CardHeader>
            <CardTitle>Local transaction rooms</CardTitle>
            <CardDescription>Useful for testing invite import and witness handoff without leaving the home screen.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {drafts.map((draft) => (
              <article key={draft.id} className={`rounded-lg border p-4 ${activeDraftId === draft.id ? "border-sky-400/50 bg-sky-400/10" : "border-border bg-slate-950/60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">{draft.title}</h3>
                  <Badge variant="secondary">{signerSummary(draft)}</Badge>
                </div>
                <div className="mt-2 text-sm text-slate-400">{draft.recipient || "No recipient saved"}</div>
                <div className="mt-2 text-xs text-slate-500">{signerCountLabel(draft)}</div>
                {unmatchedSignatureCount(draft) ? <div className="mt-2 text-xs text-amber-300">{unmatchedSignatureCount(draft)} unmatched signature{unmatchedSignatureCount(draft) === 1 ? "" : "s"}</div> : null}
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setActiveDraftId(draft.id)}>Open</Button>
                  <Button variant="secondary" size="sm" onClick={() => void copyInvite(draft)}><Copy className="size-4" /> Invite</Button>
                  <Button variant="destructive" size="sm" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))}><Trash2 className="size-4" /> Delete</Button>
                </div>
              </article>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}
    </main>
  );
}
