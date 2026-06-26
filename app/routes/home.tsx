import { Check, Download, Import, Plus, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/home";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";

type Network = "mainnet" | "preprod" | "preview";
type Mode = "import" | "create";

type Signer = { id: string; label: string; keyHash: string; source?: "payment" | "stake" | "manual" };
type NativeScript = { type: string; keyHash?: string; scripts?: NativeScript[]; required?: number; slot?: number; [key: string]: unknown };
type MultisigWallet = {
  id: string; name: string; network: Network; threshold: number; signers: Signer[];
  paymentScript: NativeScript; stakeScript?: NativeScript | null; script: NativeScript; createdAt: string; imported: boolean; handle?: string;
};
type ParsedScript = { script: NativeScript | null; error: string | null; format: "json" | "cbor" | "empty" };
type CardanoWalletApi = {
  getUsedAddresses(): Promise<string[]>; getUnusedAddresses(): Promise<string[]>; getChangeAddress(): Promise<string>; getNetworkId(): Promise<number>;
  signTx(txCbor: string, partialSign?: boolean): Promise<string>; submitTx?(txCbor: string): Promise<string>;
};
type WalletProvider = { id: string; name: string; icon?: string; enable(): Promise<CardanoWalletApi> };
type ConnectedWallet = { id: string; name: string; api: CardanoWalletApi; networkId: number; addressHex: string; keyHash: string | null };
type SignatureRecord = { signerKeyHash: string; signerName: string; walletName: string; witnessCbor: string; signedAt: string };
type AssetLine = { id: string; unit: string; label: string; quantity: string };
type TxStatus = "pending" | "succeeded" | "failed";
type TxDraft = {
  id: string; walletId?: string; title: string; walletName: string; network: Network; recipient: string; lovelace: string; note: string;
  unsignedTxCbor: string; requiredSignatures: number; signerKeyHashes: string[]; signatures: SignatureRecord[]; createdAt: string;
  assets?: AssetLine[]; status?: TxStatus; updatedAt?: string; txHash?: string; failureReason?: string;
};
type ServerProviderStatus = { mode: "server"; ready: boolean; services: { kupo: boolean; ogmios: boolean; submit: boolean } };

declare global { interface Window { cardano?: Record<string, { name?: string; icon?: string; enable?: () => Promise<CardanoWalletApi> }> } }

const STORAGE_KEY = "cardano-multisig.wallets.v2";
const TX_STORAGE_KEY = "cardano-multisig.transactions.v1";
const LEGACY_STORAGE_KEY = "cardano-multisig.wallets.v1";
const NETWORKS: Network[] = ["mainnet"];
const SAMPLE_PAYMENT_SCRIPT = ["83030283", "8200581c", "a".repeat(56), "8200581c", "b".repeat(56), "8200581c", "c".repeat(56)].join("");
const SAMPLE_STAKE_SCRIPT = ["8201818200581c", "d".repeat(56)].join("");

export function meta({}: Route.MetaArgs) {
  return [{ title: "Cardano Multisig" }, { name: "description", content: "Collaborative Cardano native-script multisig signing room" }];
}

const nowIso = () => new Date().toISOString();
function createId(prefix = "id") { const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10); return `${prefix}_${random}`; }
function emptySigner(label = "Signer"): Signer { return { id: createId("signer"), label, keyHash: "", source: "manual" }; }
function isKeyHash(value: string) { return /^[0-9a-fA-F]{56}$/.test(value.trim()); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function cleanSigner(signer: Signer): Signer { return { ...signer, label: signer.label.trim() || "Unnamed signer", keyHash: signer.keyHash.trim().toLowerCase() }; }
type CborValue = number | string | CborValue[];
function normalizeHex(value: string) { return value.replace(/^0x/i, "").replace(/\s+/g, "").toLowerCase(); }
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
  if (major === 2) { const end = offset + length * 2; if (end > hex.length) throw new Error("Truncated CBOR byte string."); return { value: hex.slice(offset, end), offset: end }; }
  if (major === 4) { const values: CborValue[] = []; for (let index = 0; index < length; index += 1) { const parsed = parseCborValue(hex, offset); values.push(parsed.value); offset = parsed.offset; } return { value: values, offset }; }
  throw new Error("Unsupported CBOR value in native script.");
}
function cborToNativeScript(value: CborValue): NativeScript {
  if (!Array.isArray(value) || typeof value[0] !== "number") throw new Error("CBOR is not a Cardano native script.");
  const tag = value[0];
  if (tag === 0 && typeof value[1] === "string") return { type: "sig", keyHash: value[1] };
  if ((tag === 1 || tag === 2) && Array.isArray(value[1])) return { type: tag === 1 ? "all" : "any", scripts: value[1].map(cborToNativeScript) };
  if (tag === 3 && typeof value[1] === "number" && Array.isArray(value[2])) return { type: "atLeast", required: value[1], scripts: value[2].map(cborToNativeScript) };
  if ((tag === 4 || tag === 5) && typeof value[1] === "number") return { type: tag === 4 ? "after" : "before", slot: value[1] };
  throw new Error("Unsupported native script CBOR shape.");
}
function parseCborScript(value: string): NativeScript {
  const hex = normalizeHex(value);
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) throw new Error("Paste valid native-script CBOR hex or JSON.");
  const parsed = parseCborValue(hex);
  if (parsed.offset !== hex.length) throw new Error("Extra bytes after native script CBOR.");
  return cborToNativeScript(parsed.value);
}
function parseScript(value: string, required: boolean): ParsedScript {
  const trimmed = value.trim();
  if (!trimmed) return required ? { script: null, error: "Script is required.", format: "empty" } : { script: null, error: null, format: "empty" };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { const parsed = JSON.parse(trimmed) as unknown; if (!isRecord(parsed) || typeof parsed.type !== "string") return { script: null, error: "Script JSON must be an object with a type field.", format: "json" }; return { script: parsed as NativeScript, error: null, format: "json" }; }
    catch (error) { return { script: null, error: error instanceof Error ? error.message : "Invalid JSON.", format: "json" }; }
  }
  try { return { script: parseCborScript(trimmed), error: null, format: "cbor" }; }
  catch (error) { return { script: null, error: error instanceof Error ? error.message : "Invalid native-script CBOR.", format: "cbor" }; }
}
function buildNativeScript(signers: Signer[], threshold: number): NativeScript {
  const sigScripts = signers.map((signer) => ({ type: "sig", keyHash: signer.keyHash }));
  if (threshold <= 1) return { type: "any", scripts: sigScripts };
  if (threshold >= sigScripts.length) return { type: "all", scripts: sigScripts };
  return { type: "atLeast", required: threshold, scripts: sigScripts };
}
function countLeafScripts(script: NativeScript | null): number { if (!script) return 0; if (script.type === "sig") return 1; return Array.isArray(script.scripts) ? script.scripts.reduce((total, child) => total + countLeafScripts(child), 0) : 0; }
function requiredSignatures(script: NativeScript | null): number {
  if (!script) return 0; const children = Array.isArray(script.scripts) ? script.scripts : [];
  if (script.type === "sig") return 1; if (script.type === "any") return children.length ? 1 : 0;
  if (script.type === "all") return children.reduce((total, child) => total + requiredSignatures(child), 0);
  if (script.type === "atLeast") return Number(script.required || 0);
  return children.reduce((total, child) => Math.max(total, requiredSignatures(child)), 0);
}
function summarizeScript(script: NativeScript | null) { if (!script) return "Not provided"; const leaves = countLeafScripts(script); if (script.type === "sig") return "1-of-1"; if (script.type === "any") return `1-of-${leaves}`; if (script.type === "all") return `${leaves}-of-${leaves}`; if (script.type === "atLeast") return `${script.required ?? 0}-of-${leaves}`; return `${script.type} script`; }
function collectSigners(script: NativeScript | null, source: "payment" | "stake") {
  const signers: Signer[] = [];
  function visit(node: NativeScript | null) { if (!node) return; if (node.type === "sig" && typeof node.keyHash === "string" && isKeyHash(node.keyHash)) signers.push({ id: createId(source), label: `${source === "payment" ? "Payment" : "Stake"} signer ${signers.length + 1}`, keyHash: node.keyHash.toLowerCase(), source }); if (Array.isArray(node.scripts)) node.scripts.forEach(visit); }
  visit(script); return signers;
}
function uniqueSigners(signers: Signer[]) { const seen = new Map<string, Signer>(); for (const signer of signers) if (!seen.has(signer.keyHash)) seen.set(signer.keyHash, signer); return [...seen.values()]; }
function migrateWallet(raw: unknown): MultisigWallet | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !isRecord(raw.script)) return null; const script = raw.script as NativeScript;
  const signers = Array.isArray(raw.signers) ? (raw.signers as Signer[]).filter((signer) => isKeyHash(signer.keyHash)) : collectSigners(script, "payment");
  return { id: typeof raw.id === "string" ? raw.id : createId("wallet"), name: raw.name, handle: typeof raw.handle === "string" ? raw.handle : undefined, network: NETWORKS.includes(raw.network as Network) ? raw.network as Network : "mainnet", threshold: typeof raw.threshold === "number" ? raw.threshold : requiredSignatures(script), signers, paymentScript: isRecord(raw.paymentScript) ? raw.paymentScript as NativeScript : script, stakeScript: isRecord(raw.stakeScript) ? raw.stakeScript as NativeScript : null, script, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(), imported: Boolean(raw.imported) };
}
function readJsonArray<T>(key: string, migrate: (raw: unknown) => T | null): T[] { if (typeof window === "undefined") return []; try { const stored = window.localStorage.getItem(key); if (!stored) return []; const parsed = JSON.parse(stored) as unknown; if (!Array.isArray(parsed)) return []; return parsed.map(migrate).filter((item): item is T => Boolean(item)); } catch { return []; } }
function loadWallets(): MultisigWallet[] { const current = readJsonArray(STORAGE_KEY, migrateWallet); return current.length ? current : readJsonArray(LEGACY_STORAGE_KEY, migrateWallet); }
function saveWallets(wallets: MultisigWallet[]) { if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets, null, 2)); }
function migrateDraft(raw: unknown): TxDraft | null { if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") return null; const status = raw.status === "succeeded" || raw.status === "failed" ? raw.status : "pending"; return { id: raw.id, walletId: typeof raw.walletId === "string" ? raw.walletId : undefined, title: raw.title, walletName: String(raw.walletName || "Wallet"), network: NETWORKS.includes(raw.network as Network) ? raw.network as Network : "mainnet", recipient: String(raw.recipient || ""), lovelace: String(raw.lovelace || ""), note: String(raw.note || ""), unsignedTxCbor: String(raw.unsignedTxCbor || ""), requiredSignatures: Number(raw.requiredSignatures || 1), signerKeyHashes: Array.isArray(raw.signerKeyHashes) ? raw.signerKeyHashes.map(String).filter(isKeyHash).map((x) => x.toLowerCase()) : [], signatures: Array.isArray(raw.signatures) ? raw.signatures as SignatureRecord[] : [], createdAt: String(raw.createdAt || nowIso()), assets: Array.isArray(raw.assets) ? raw.assets as AssetLine[] : undefined, status, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined, txHash: typeof raw.txHash === "string" ? raw.txHash : undefined, failureReason: typeof raw.failureReason === "string" ? raw.failureReason : undefined }; }
function loadDrafts() { return readJsonArray(TX_STORAGE_KEY, migrateDraft); }
function saveDrafts(drafts: TxDraft[]) { if (typeof window !== "undefined") window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(drafts, null, 2)); }
function slugify(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "cardano-multisig"; }
function downloadJson(name: string, value: unknown) { const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
function walletHref(wallet: MultisigWallet) { return `/wallets/${encodeURIComponent(wallet.id)}`; }
function encodeInvite(draft: TxDraft) { const payload = JSON.stringify({ type: "cardano-multisig-invite", version: 1, draft: { ...draft, signatures: [] } }); return btoa(unescape(encodeURIComponent(payload))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decodeInvite(value: string): TxDraft | null { try { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const json = decodeURIComponent(escape(atob(normalized))); const parsed = JSON.parse(json) as unknown; if (!isRecord(parsed) || parsed.type !== "cardano-multisig-invite" || !isRecord(parsed.draft)) return null; return migrateDraft(parsed.draft); } catch { return null; } }
function hexToBytes(hex: string) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
async function keyHashFromAddress(addressHex: string): Promise<string | null> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser"); const address = CSL.Address.from_bytes(hexToBytes(addressHex));
    const base = CSL.BaseAddress.from_address(address); const enterprise = CSL.EnterpriseAddress.from_address(address); const reward = CSL.RewardAddress.from_address(address);
    const credential = base?.payment_cred() ?? enterprise?.payment_cred() ?? reward?.payment_cred(); const keyHash = credential?.to_keyhash();
    return keyHash ? keyHash.to_hex() : null;
  } catch { return null; }
}
function networkLabel(networkId: number) { if (networkId < 0) return "connected"; return networkId === 1 ? "mainnet" : networkId === 0 ? "testnet" : `network ${networkId}`; }
function installedWallets(): WalletProvider[] { if (typeof window === "undefined" || !window.cardano) return []; return Object.entries(window.cardano).filter(([, wallet]) => typeof wallet.enable === "function").map(([id, wallet]) => ({ id, name: wallet.name || id, icon: wallet.icon, enable: wallet.enable!.bind(wallet) })); }
function signatureCount(draft: TxDraft) { const signed = new Set(draft.signatures.map((sig) => sig.signerKeyHash.toLowerCase())); return draft.signerKeyHashes.filter((hash) => signed.has(hash.toLowerCase())).length; }
function pendingSignatureCount(draft: TxDraft) { return Math.max(draft.requiredSignatures - signatureCount(draft), 0); }

function ScriptPreview({ title, script }: { title: string; script: NativeScript | null }) {
  return <div className="rounded-lg border border-border bg-slate-950/80"><div className="flex items-center justify-between border-b border-border px-4 py-3"><span className="text-sm font-medium text-slate-200">{title}</span><Badge variant="outline">{summarizeScript(script)}</Badge></div><pre className="code-scroll max-h-80 overflow-auto p-4 text-xs leading-5 text-slate-300"><code>{script ? JSON.stringify(script, null, 2) : "// Paste native-script CBOR hex or JSON to preview"}</code></pre></div>;
}

export default function Home() {
  const [wallets, setWallets] = useState<MultisigWallet[]>([]); const [drafts, setDrafts] = useState<TxDraft[]>([]); const [providers, setProviders] = useState<WalletProvider[]>([]); const [connected, setConnected] = useState<ConnectedWallet | null>(null); const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null); const [serverProvider, setServerProvider] = useState<ServerProviderStatus | null>(null);
  const [mode, setMode] = useState<Mode>("import"); const [threshold, setThreshold] = useState(2); const [signers, setSigners] = useState<Signer[]>([emptySigner("Signer 1"), emptySigner("Signer 2"), emptySigner("Signer 3")]);
  const [importHandle, setImportHandle] = useState(""); const [paymentScriptText, setPaymentScriptText] = useState(""); const [stakeScriptText, setStakeScriptText] = useState(""); const [copied, setCopied] = useState(false);
  const [txTitle, setTxTitle] = useState("Treasury payment"); const [txRecipient, setTxRecipient] = useState(""); const [txLovelace, setTxLovelace] = useState("2000000"); const [txCbor, setTxCbor] = useState(""); const [txNote, setTxNote] = useState(""); const [activeDraftId, setActiveDraftId] = useState<string | null>(null); const [signaturePackage, setSignaturePackage] = useState(""); const [status, setStatus] = useState("");

  useEffect(() => { setWallets(loadWallets()); setDrafts(loadDrafts()); setProviders(installedWallets()); fetch("/api/cardano/provider").then((response) => response.ok ? response.json() : null).then((payload) => setServerProvider(payload)).catch(() => setServerProvider(null)); const invite = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("invite"); if (invite) { const draft = decodeInvite(invite); if (draft) { setDrafts((current) => current.some((item) => item.id === draft.id) ? current : [draft, ...current]); setActiveDraftId(draft.id); setStatus("Invite loaded. Connect the signer wallet to sign this transaction."); } } }, []);
  useEffect(() => saveWallets(wallets), [wallets]); useEffect(() => saveDrafts(drafts), [drafts]);

  const cleanedSigners = useMemo(() => signers.map(cleanSigner), [signers]); const validSigners = cleanedSigners.filter((signer) => isKeyHash(signer.keyHash)); const clampedThreshold = Math.max(1, Math.min(threshold, validSigners.length || 1)); const draftScript = useMemo(() => buildNativeScript(validSigners, clampedThreshold), [validSigners, clampedThreshold]); const canSave = validSigners.length >= 2 && clampedThreshold <= validSigners.length; const scriptJson = JSON.stringify(draftScript, null, 2);
  const parsedPayment = useMemo(() => parseScript(paymentScriptText, true), [paymentScriptText]); const parsedStake = useMemo(() => parseScript(stakeScriptText, false), [stakeScriptText]); const importedSigners = useMemo(() => uniqueSigners([...collectSigners(parsedPayment.script, "payment"), ...collectSigners(parsedStake.script, "stake")]), [parsedPayment.script, parsedStake.script]); const importThreshold = requiredSignatures(parsedPayment.script); const canImport = Boolean(parsedPayment.script) && !parsedPayment.error && !parsedStake.error;
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) ?? drafts[0] ?? null; const selectedSignerHashes = (mode === "import" ? importedSigners : validSigners).map((signer) => signer.keyHash); const selectedRequired = mode === "import" ? Math.max(importThreshold, 1) : clampedThreshold;

  async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error(message)), milliseconds); });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timeoutId) clearTimeout(timeoutId); }
  }
  async function connectWallet(provider: WalletProvider) {
    if (connectingWalletId) return;
    setConnectingWalletId(provider.id);
    setStatus(`Open ${provider.name} and approve the connection...`);
    try {
      const api = await withTimeout(provider.enable(), 12000, `${provider.name} did not answer. Unlock Eternl/reopen the wallet popup, then try again.`);
      setConnected({ id: provider.id, name: provider.name, api, networkId: -1, addressHex: "", keyHash: null });
      setConnectingWalletId(null);
      setStatus(`Connected ${provider.name}. Recovering wallet details...`);

      let networkId = -1;
      let addressHex = "";
      let keyHash: string | null = null;
      try { networkId = await withTimeout(api.getNetworkId(), 5000, "Network lookup timed out."); } catch { networkId = -1; }
      try {
        const used = await withTimeout(api.getUsedAddresses(), 5000, "Address lookup timed out.");
        const unused = used.length ? [] : await withTimeout(api.getUnusedAddresses(), 5000, "Unused address lookup timed out.");
        addressHex = used[0] || unused[0] || await withTimeout(api.getChangeAddress(), 5000, "Change address lookup timed out.");
        keyHash = addressHex ? await keyHashFromAddress(addressHex) : null;
      } catch {
        addressHex = "";
        keyHash = null;
      }
      setConnected({ id: provider.id, name: provider.name, api, networkId, addressHex, keyHash });
      setStatus(keyHash ? `Connected ${provider.name}. Signer key hash detected.` : `Connected ${provider.name}. You can sign; key hash detection was skipped or timed out.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not connect ${provider.name}.`);
      setConnectingWalletId(null);
    }
  }
  function importWallet() { if (!canImport || !parsedPayment.script) return; const handle = importHandle.trim().replace(/^\$/, ""); const wallet: MultisigWallet = { id: createId("wallet"), name: handle ? `$${handle}` : "Imported wallet", handle: handle || undefined, network: "mainnet", threshold: importThreshold, signers: importedSigners, paymentScript: parsedPayment.script, stakeScript: parsedStake.script, script: parsedPayment.script, createdAt: nowIso(), imported: true }; setWallets((current) => [wallet, ...current]); }
  function saveCreatedWallet() { if (!canSave) return; const wallet: MultisigWallet = { id: createId("wallet"), name: "New multisig wallet", network: "mainnet", threshold: clampedThreshold, signers: validSigners, paymentScript: draftScript, stakeScript: null, script: draftScript, createdAt: nowIso(), imported: false }; setWallets((current) => [wallet, ...current]); }
  async function copyScript() { await navigator.clipboard.writeText(scriptJson); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  function createDraft() { const hashes = uniqueSigners(selectedSignerHashes.map((keyHash, index) => ({ id: createId("txsigner"), label: `Signer ${index + 1}`, keyHash }))).map((signer) => signer.keyHash); const draft: TxDraft = { id: createId("tx"), title: txTitle.trim() || "Transaction", walletName: mode === "import" ? (importHandle.trim().replace(/^\$/, "") || "Imported wallet") : "New multisig wallet", network: "mainnet", recipient: txRecipient.trim(), lovelace: txLovelace.trim(), note: txNote.trim(), unsignedTxCbor: txCbor.trim(), requiredSignatures: Math.min(Math.max(selectedRequired, 1), Math.max(hashes.length, 1)), signerKeyHashes: hashes, signatures: [], assets: [{ id: createId("asset"), unit: "lovelace", label: "ADA", quantity: txLovelace.trim() }], status: "pending", createdAt: nowIso(), updatedAt: nowIso() }; setDrafts((current) => [draft, ...current]); setActiveDraftId(draft.id); setStatus("Transaction room created. Copy the invite link and send it privately to signers."); }
  async function copyInvite(draft: TxDraft) { const link = `${window.location.origin}${window.location.pathname}#invite=${encodeInvite(draft)}`; await navigator.clipboard.writeText(link); setStatus("Invite link copied. Send it privately to the intended signers only."); }
  async function signActiveDraft() { if (!activeDraft || !connected) return; if (!activeDraft.unsignedTxCbor.trim()) { setStatus("Paste an unsigned transaction CBOR before signing."); return; } const signerKeyHash = connected.keyHash?.toLowerCase() || "unknown"; const witnessCbor = await connected.api.signTx(activeDraft.unsignedTxCbor.trim(), true); const signature: SignatureRecord = { signerKeyHash, signerName: signerKeyHash === "unknown" ? connected.name : signerKeyHash, walletName: connected.name, witnessCbor, signedAt: nowIso() }; setDrafts((current) => current.map((draft) => draft.id === activeDraft.id ? { ...draft, signatures: [...draft.signatures.filter((sig) => sig.signerKeyHash !== signerKeyHash), signature] } : draft)); setSignaturePackage(JSON.stringify({ type: "cardano-multisig-signature", version: 1, draftId: activeDraft.id, signature }, null, 2)); setStatus("Partial witness captured. Send the signature package back to the coordinator or keep collecting locally."); }
  function importSignature() { try { const parsed = JSON.parse(signaturePackage) as unknown; if (!isRecord(parsed) || parsed.type !== "cardano-multisig-signature" || !isRecord(parsed.signature) || typeof parsed.draftId !== "string") throw new Error("Invalid signature package"); const signature = parsed.signature as SignatureRecord; setDrafts((current) => current.map((draft) => draft.id === parsed.draftId ? { ...draft, signatures: [...draft.signatures.filter((sig) => sig.signerKeyHash !== signature.signerKeyHash), signature] } : draft)); setActiveDraftId(parsed.draftId); setStatus("Signature package imported."); } catch (error) { setStatus(error instanceof Error ? error.message : "Invalid signature package"); } }
  async function copySignaturePackage() { if (!signaturePackage.trim()) return; await navigator.clipboard.writeText(signaturePackage); setStatus("Signature package copied."); }

  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
    <section className="grid gap-6 lg:grid-cols-[1fr_420px] lg:items-end"><div className="space-y-5"><Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">Cardano native scripts</Badge><div className="space-y-4"><h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.08em] text-slate-50 sm:text-7xl lg:text-8xl">Multisig control room.</h1><p className="max-w-2xl text-base leading-7 text-slate-400 sm:text-lg">Import native-script CBOR/JSON, review saved wallets, and open wallet workspaces for transactions and signer tracking.</p></div></div><Card className="glass-panel overflow-hidden"><CardContent className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><WalletCards className="size-4 text-sky-300" /> Wallet</div><div className="mt-1 text-xs text-slate-400">{connected ? `${connected.name} · ${networkLabel(connected.networkId)}` : providers.length ? "Connect a signer wallet" : "No browser wallet detected"}</div></div><Badge variant={connected ? "default" : "secondary"}>{connected ? "connected" : "off"}</Badge></div><div className="flex flex-wrap gap-2">{providers.length ? providers.map((provider) => <Button key={provider.id} size="sm" variant={connected?.id === provider.id ? "default" : "secondary"} disabled={Boolean(connectingWalletId)} onClick={() => connectWallet(provider)}>{provider.icon ? <img alt="" className="size-4" src={provider.icon} /> : null}{connectingWalletId === provider.id ? "Waiting..." : provider.name}</Button>) : null}</div>{connected?.keyHash ? <div className="truncate rounded-md border border-border bg-slate-950/60 px-3 py-2 font-mono text-[11px] text-slate-300">{connected.keyHash}</div> : null}<div className="grid grid-cols-2 gap-3"><div className="rounded-lg border border-border bg-slate-950/60 p-3"><div className="text-2xl font-semibold text-sky-200">{wallets.length}</div><div className="text-xs text-slate-400">wallets</div></div><div className="rounded-lg border border-border bg-slate-950/60 p-3"><div className="text-2xl font-semibold text-sky-200">{serverProvider?.ready ? "on" : "—"}</div><div className="text-xs text-slate-400">server</div></div></div></CardContent></Card></section>

    <Card className="glass-panel"><CardHeader><div className="flex items-center justify-between gap-4"><div><CardTitle>Saved wallets</CardTitle><CardDescription>Open a wallet to review transactions, create new ones, and track signer approvals.</CardDescription></div><Badge variant="secondary">{wallets.length} saved</Badge></div></CardHeader><CardContent>{wallets.length === 0 ? <div className="rounded-lg border border-dashed border-border bg-slate-950/40 p-8 text-center text-slate-400">No wallets saved yet. Import scripts or create a new policy to start.</div> : <div className="grid gap-3 md:grid-cols-2">{wallets.map((wallet) => <article className="rounded-lg border border-border bg-slate-950/55 p-4 transition hover:border-sky-400/50 hover:bg-slate-900/70" key={wallet.id}><a href={walletHref(wallet)} className="block space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold text-slate-100">{wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name}</h3><Badge variant={wallet.imported ? "default" : "secondary"}>{wallet.imported ? "imported" : "created"}</Badge></div><p className="text-sm text-slate-400">{wallet.handle ? `${wallet.name} · ` : ""}{wallet.network} · payment {summarizeScript(wallet.paymentScript)} · stake {summarizeScript(wallet.stakeScript ?? null)} · {wallet.signers.length} signers</p><div className="text-sm font-medium text-sky-200">Open wallet →</div></a><div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3"><Button variant="secondary" onClick={() => downloadJson(`${slugify(wallet.name)}-wallet.json`, wallet)}><Download className="size-4" /> Export</Button><Button variant="destructive" onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}><Trash2 className="size-4" /> Delete</Button></div></article>)}</div>}</CardContent></Card>

    <section><Card className="glass-panel"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Wallet workspace</CardTitle><CardDescription>Import an existing wallet or create a new M-of-N policy.</CardDescription></div><div className="grid grid-cols-2 rounded-lg border border-border bg-slate-950/70 p-1">{(["import", "create"] as Mode[]).map((item) => <Button key={item} variant={mode === item ? "default" : "ghost"} size="sm" onClick={() => setMode(item)}>{item === "import" ? <Import className="size-4" /> : <Plus className="size-4" />}{item}</Button>)}</div></div></CardHeader>{mode === "import" ? <CardContent className="space-y-5"><div className="space-y-2"><Label>ADA Handle (optional)</Label><Input value={importHandle} onChange={(event) => setImportHandle(event.target.value)} placeholder="$discatalyst" /></div><div className="space-y-2"><div className="flex items-center justify-between"><Label>Payment script CBOR / JSON</Label><Button type="button" variant="ghost" size="sm" onClick={() => setPaymentScriptText(SAMPLE_PAYMENT_SCRIPT)}>Load sample</Button></div><Textarea value={paymentScriptText} onChange={(event) => setPaymentScriptText(event.target.value)} placeholder="Paste payment native-script CBOR hex or JSON" className="min-h-52 font-mono text-xs" aria-invalid={Boolean(parsedPayment.error)} />{parsedPayment.error ? <p className="text-sm text-red-300">{parsedPayment.error}</p> : null}</div><div className="space-y-2"><div className="flex items-center justify-between"><Label>Stake script CBOR / JSON</Label><Button type="button" variant="ghost" size="sm" onClick={() => setStakeScriptText(SAMPLE_STAKE_SCRIPT)}>Load sample</Button></div><Textarea value={stakeScriptText} onChange={(event) => setStakeScriptText(event.target.value)} placeholder="Paste stake native-script CBOR hex or JSON if it has one" className="min-h-40 font-mono text-xs" aria-invalid={Boolean(parsedStake.error)} />{parsedStake.error ? <p className="text-sm text-red-300">{parsedStake.error}</p> : null}</div><div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-4 text-sm leading-6 text-sky-100"><div className="mb-1 flex items-center gap-2 font-medium"><ShieldCheck className="size-4" /> Import safety</div>Importing preserves script data for verification. It does not prove fund control; verify the address and run a dust transaction before moving value.</div><Button disabled={!canImport} onClick={importWallet} className="w-full"><Import className="size-4" /> Import existing wallet</Button></CardContent> : <CardContent className="space-y-5"><div className="rounded-lg border border-border bg-slate-950/60 p-3 text-sm text-slate-300">New wallets are mainnet-only. You can rename the saved wallet later from its wallet page.</div><div className="space-y-2"><Label>Required signatures</Label><Input min={1} max={Math.max(validSigners.length, 1)} type="number" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></div><div className="space-y-3"><div className="flex items-center justify-between"><Label>Signers</Label><Button variant="secondary" size="sm" onClick={() => setSigners((current) => [...current, emptySigner(`Signer ${current.length + 1}`)])}><Plus className="size-4" /> Add signer</Button></div>{signers.map((signer, index) => <div className="grid gap-2 sm:grid-cols-[160px_1fr_40px]" key={signer.id}><Input aria-label={`Signer ${index + 1} label`} value={signer.label} onChange={(event) => setSigners((current) => current.map((item) => item.id === signer.id ? { ...item, label: event.target.value } : item))} /><Input aria-label={`Signer ${index + 1} payment key hash`} aria-invalid={signer.keyHash.length > 0 && !isKeyHash(signer.keyHash)} placeholder="56-char payment key hash" value={signer.keyHash} onChange={(event) => setSigners((current) => current.map((item) => item.id === signer.id ? { ...item, keyHash: event.target.value } : item))} /><Button aria-label={`Remove signer ${index + 1}`} variant="secondary" size="icon" disabled={signers.length <= 2} onClick={() => setSigners((current) => current.filter((item) => item.id !== signer.id))}><Trash2 className="size-4" /></Button></div>)}</div><div className="grid gap-3 sm:grid-cols-2"><Button disabled={!canSave} onClick={saveCreatedWallet}><Check className="size-4" /> Save workspace</Button><Button variant="secondary" disabled={validSigners.length === 0} onClick={copyScript}>{copied ? "Copied" : "Copy script"}</Button></div></CardContent>}</Card>
</section>


    {status ? <div className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-full border border-sky-400/30 bg-slate-950/95 px-4 py-2 text-sm text-sky-100 shadow-2xl">{status}</div> : null}
  </main>;
}
