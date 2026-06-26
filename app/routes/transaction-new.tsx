import { Link, useNavigate, useParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Database, RefreshCw, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";

type NativeScript = { type: string; keyHash?: string; scripts?: NativeScript[]; required?: number; slot?: number; [key: string]: unknown };
type Signer = { id: string; label: string; keyHash: string };
type Wallet = { id: string; name: string; handle?: string; network: string; threshold: number; signers: Signer[]; paymentScript?: NativeScript; stakeScript?: NativeScript | null };
type CardanoWalletApi = { getUsedAddresses(): Promise<string[]>; getUnusedAddresses(): Promise<string[]>; getChangeAddress(): Promise<string>; getNetworkId(): Promise<number>; signTx(txCbor: string, partialSign?: boolean): Promise<string> };
type WalletProvider = { id: string; name: string; icon?: string; enable(): Promise<CardanoWalletApi> };
type ConnectedWallet = { id: string; name: string; api: CardanoWalletApi; networkId: number };
type AssetOption = { unit: string; label: string; quantity: string; outputCount?: number; decimals?: number; source: "treasury" | "default" };
type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };
type AssetFetch = { assets: AssetOption[]; handle?: HandleInfo | null; source?: string; address?: string; outputs?: number };
type AssetLine = { id: string; unit: string; label: string; quantity: string; maxQuantity?: string; decimals?: number };
type TxDraft = { id: string; walletId: string; title: string; walletName: string; network: string; recipient: string; lovelace: string; note: string; unsignedTxCbor: string; requiredSignatures: number; signerKeyHashes: string[]; signatures: Array<{ signerKeyHash: string; signerName: string; walletName: string; witnessCbor: string; signedAt: string }>; assets: AssetLine[]; status: "pending" | "succeeded" | "failed"; createdAt: string; updatedAt: string };
const WALLET_KEY = "cardano-multisig.wallets.v2";
const TX_KEY = "cardano-multisig.transactions.v1";
const DEFAULT_ASSET: AssetOption = { unit: "lovelace", label: "ADA", quantity: "0", decimals: 6, source: "default" };
export function meta() { return [{ title: "Create transaction · Cardano Multisig" }]; }
function readArray<T>(key: string): T[] { if (typeof window === "undefined") return []; try { const parsed = JSON.parse(window.localStorage.getItem(key) || "[]"); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; } }
function writeArray<T>(key: string, value: T[]) { window.localStorage.setItem(key, JSON.stringify(value, null, 2)); }
function installedWallets(): WalletProvider[] { const cardano = typeof window === "undefined" ? null : (window as unknown as { cardano?: Record<string, { name?: string; icon?: string; enable?: () => Promise<CardanoWalletApi> }> }).cardano; if (!cardano) return []; return Object.entries(cardano).filter(([, wallet]) => typeof wallet.enable === "function").map(([id, wallet]) => ({ id, name: wallet.name || id, icon: wallet.icon, enable: wallet.enable!.bind(wallet) })); }
function createId(prefix = "id") { const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10); return `${prefix}_${random}`; }
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }); try { return await Promise.race([promise, timeout]); } finally { if (timer) clearTimeout(timer); } }
function networkLabel(networkId: number) { if (networkId < 0) return "connected"; return networkId === 1 ? "mainnet" : networkId === 0 ? "testnet" : `network ${networkId}`; }
function trimDecimal(value: string) { return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1"); }
function formatRawQuantity(quantity: string, unit: string, decimals = unit === "lovelace" ? 6 : 0) {
  const label = unit === "lovelace" ? "ADA" : "";
  const raw = BigInt(quantity || "0");
  if (!decimals) return `${raw.toLocaleString()}${label ? ` ${label}` : ""}`;
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const frac = raw % scale;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(decimals, "0")}`;
  const text = trimDecimal(`${whole.toLocaleString()}${fracText}`);
  return `${text}${label ? ` ${label}` : ""}`;
}
function toRawQuantity(display: string, decimals = 0) {
  const normalized = (display || "0").replace(/,/g, "").trim();
  if (!normalized) return "0";
  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  const whole = BigInt(wholeRaw || "0");
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return (whole * (10n ** BigInt(decimals)) + BigInt(frac || "0")).toString();
}
function defaultDisplayAmount(asset: { unit: string; decimals?: number }) { return asset.unit === "lovelace" ? "2" : "1"; }
function handleCandidate(wallet: { name?: string; handle?: string }) {
  const candidate = (wallet.handle || wallet.name || "").trim().replace(/^\$/, "").toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,31}$/.test(candidate) ? candidate : "";
}
function assetQuery(patterns: string[], wallet: { name?: string; handle?: string }, stakeAddress?: string | null) {
  const params = new URLSearchParams();
  if (patterns.length) params.set("patterns", patterns.join(","));
  const handle = handleCandidate(wallet);
  if (handle) params.set("handle", handle);
  if (stakeAddress) params.set("stakeAddress", stakeAddress);
  return params.toString();
}
function handleLabel(handle?: HandleInfo | null) { return handle ? `$${handle.name}` : ""; }
function assetLabel(unit: string) { if (unit === "lovelace") return "ADA"; const [, nameHex = ""] = unit.split("."); try { const decoded = new TextDecoder().decode(Uint8Array.from((nameHex.match(/../g) || []).map((byte) => parseInt(byte, 16)))); if (/^[\x20-\x7E]{1,32}$/.test(decoded)) return decoded; } catch {} return nameHex ? `${nameHex.slice(0, 12)}${nameHex.length > 12 ? "…" : ""}` : `${unit.slice(0, 16)}…`; }
function scriptToCsl(CSL: any, script: NativeScript): any {
  if (script.type === "sig" && script.keyHash) return CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)));
  const children = CSL.NativeScripts.new();
  for (const child of script.scripts || []) children.add(scriptToCsl(CSL, child));
  if (script.type === "all") return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(children));
  if (script.type === "any") return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(children));
  if (script.type === "atLeast") return CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(Number(script.required || 1), children));
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
      stakeAddress = CSL.RewardAddress.new(networkId, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(stakeHash))).to_address().to_bech32();
    }
    return { patterns: Array.from(new Set(patterns)), stakeAddress };
  } catch { return { patterns: [], stakeAddress: null }; }
}
async function fetchMultisigAssets(wallet: Wallet): Promise<AssetFetch> { const { patterns, stakeAddress } = await walletResolution(wallet); const query = assetQuery(patterns, wallet, stakeAddress); if (!query) throw new Error("Could not derive the wallet script hash or ADA Handle yet. Re-import the wallet if this persists."); const res = await fetch(`/api/cardano/assets?${query}`); const body = await res.json(); if (!res.ok) throw new Error(body.error || "Could not fetch multisig assets."); return { assets: (body.assets || []).map((asset: { unit: string; label: string; quantity: string; outputCount?: number; decimals?: number }) => ({ ...asset, source: "treasury" as const })), handle: body.handle, source: body.source, address: body.address, outputs: body.outputs }; }

export default function NewTransaction() {
  const { walletId } = useParams();
  const navigate = useNavigate();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [multisigAssets, setMultisigAssets] = useState<AssetOption[]>([]);
  const [resolvedHandle, setResolvedHandle] = useState<HandleInfo | null>(null);
  const [assetStatus, setAssetStatus] = useState("Loading multisig assets…");
  const [title, setTitle] = useState("Treasury payment");
  const [recipient, setRecipient] = useState("");
  const [assets, setAssets] = useState<AssetLine[]>([{ id: createId("asset"), unit: "lovelace", label: "ADA", quantity: "2", decimals: 6 }]);
  const [unsignedTxCbor, setUnsignedTxCbor] = useState("");
  const [buildInfo, setBuildInfo] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { setWallets(readArray<Wallet>(WALLET_KEY)); setProviders(installedWallets()); }, []);
  const wallet = wallets.find((item) => item.id === walletId);
  const assetOptions = useMemo(() => (multisigAssets.length ? multisigAssets : [DEFAULT_ASSET]).sort((a,b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label)), [multisigAssets]);
  const lovelaceAsset = assets.find((asset) => asset.unit === "lovelace");
  const lovelace = lovelaceAsset ? toRawQuantity(lovelaceAsset.quantity, lovelaceAsset.decimals ?? 6) : "0";
  useEffect(() => { if (!wallet) return; void refreshMultisigAssets(wallet); }, [wallet?.id]);
  async function refreshMultisigAssets(target = wallet) { if (!target) return; setAssetStatus("Loading multisig assets from Kupo…"); try { const result = await fetchMultisigAssets(target); const fetched = result.assets; setResolvedHandle(result.handle || null); setMultisigAssets(fetched.length ? fetched : [DEFAULT_ASSET]); const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : ""; setAssetStatus(fetched.length ? `${prefix}Loaded ${fetched.length} multisig asset${fetched.length === 1 ? "" : "s"} from ${result.source || "server"}.` : `${prefix}No spendable multisig assets found yet.`); } catch (error) { setMultisigAssets([DEFAULT_ASSET]); setAssetStatus(error instanceof Error ? error.message : "Could not fetch multisig assets."); } }
  function applyAsset(id: string, unit: string) { const chosen = assetOptions.find((asset) => asset.unit === unit) || DEFAULT_ASSET; setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, unit: chosen.unit, label: chosen.label, decimals: chosen.decimals ?? (chosen.unit === "lovelace" ? 6 : 0), maxQuantity: chosen.quantity, quantity: defaultDisplayAmount(chosen) } : asset)); }
  function updateAsset(id: string, patch: Partial<AssetLine>) { setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset)); }
  function addAsset() { const existing = new Set(assets.map((asset) => asset.unit)); const next = assetOptions.find((asset) => !existing.has(asset.unit)) || assetOptions[0] || DEFAULT_ASSET; setAssets((current) => [...current, { id: createId("asset"), unit: next.unit, label: next.label, quantity: defaultDisplayAmount(next), maxQuantity: next.quantity, decimals: next.decimals ?? (next.unit === "lovelace" ? 6 : 0) }]); }
  async function connect(provider: WalletProvider) { if (connecting) return; setConnecting(provider.id); setStatus(`Open ${provider.name} and approve the connection...`); try { const api = await withTimeout(provider.enable(), 12000, `${provider.name} did not answer. Unlock Eternl/reopen the wallet popup, then try again.`); setConnected({ id: provider.id, name: provider.name, api, networkId: -1 }); setConnecting(null); try { const networkId = await withTimeout(api.getNetworkId(), 5000, "Network lookup timed out."); setConnected({ id: provider.id, name: provider.name, api, networkId }); } catch {} setStatus(`Connected ${provider.name}.`); } catch (error) { setStatus(error instanceof Error ? error.message : `Could not connect ${provider.name}.`); setConnecting(null); } }
  async function buildUnsignedTx(txAssets: AssetLine[]) {
    if (!wallet) throw new Error("Wallet not loaded.");
    if (!recipient.trim()) throw new Error("Enter a recipient address.");
    setStatus("Building balanced unsigned transaction from multisig UTxOs…");
    const response = await fetch("/api/cardano/build-tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet, recipient: recipient.trim(), assets: txAssets }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "Could not build transaction.");
    setUnsignedTxCbor(body.unsignedTxCbor);
    const minAdaNote = body.adjustedMinAda ? ` Output ADA was raised to the minimum ${formatRawQuantity(String(body.minAda || "0"), "lovelace", 6)} required for native assets.` : "";
    setBuildInfo(`Built from ${body.inputCount} UTxO${body.inputCount === 1 ? "" : "s"}; fee ${formatRawQuantity(String(body.fee || "0"), "lovelace", 6)}.${minAdaNote}`);
    return { cbor: String(body.unsignedTxCbor || ""), assets: Array.isArray(body.assets) ? body.assets : txAssets };
  }
  async function createAndMaybeSign() {
    if (!wallet) return;
    const now = new Date().toISOString();
    const txAssets = assets.map((asset) => ({ ...asset, quantity: toRawQuantity(asset.quantity, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0)) }));
    let builtCbor = unsignedTxCbor.trim();
    let builtAssets = txAssets;
    let signatures: TxDraft["signatures"] = [];
    try { const built = await buildUnsignedTx(txAssets); builtCbor = built.cbor; builtAssets = built.assets; } catch (error) { setStatus(error instanceof Error ? error.message : "Could not build transaction."); return; }
    if (connected) {
      try {
        setStatus(`Requesting ${connected.name} signature…`);
        const witnessCbor = await connected.api.signTx(builtCbor, true);
        signatures = [{ signerKeyHash: "unknown", signerName: connected.name, walletName: connected.name, witnessCbor, signedAt: new Date().toISOString() }];
        setStatus("Transaction built and signed by connected wallet.");
      } catch (error) { setStatus(error instanceof Error ? error.message : "Wallet refused to sign."); return; }
    } else { setStatus("Transaction built as pending. Connect a signer wallet from the wallet page to sign it."); }
    const tx: TxDraft = { id: createId("tx"), walletId: wallet.id, title: title.trim() || "Transaction", walletName: wallet.name, network: wallet.network, recipient: recipient.trim(), lovelace, note: note.trim(), unsignedTxCbor: builtCbor, requiredSignatures: Math.max(wallet.threshold || 1, 1), signerKeyHashes: wallet.signers.map((signer) => signer.keyHash), signatures, assets: builtAssets, status: "pending", createdAt: now, updatedAt: now };
    const next = [tx, ...readArray<TxDraft>(TX_KEY)]; writeArray(TX_KEY, next); navigate(`/wallets/${encodeURIComponent(wallet.id)}`);
  }
  if (!wallet) return <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100"><Link className="text-sm text-sky-300" to="/">← Back</Link><Card className="glass-panel mt-6"><CardContent className="p-8 text-slate-300">Wallet not found. Import or create it first.</CardContent></Card></main>;
  return <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8"><div className="flex flex-wrap items-center justify-between gap-4"><div><Link to={`/wallets/${encodeURIComponent(wallet.id)}`} className="inline-flex items-center gap-2 text-sm text-sky-300"><ArrowLeft className="size-4" /> Back to wallet</Link><h1 className="mt-3 text-4xl font-semibold tracking-[-0.06em] text-slate-50">Create transaction</h1><p className="mt-2 text-slate-400">Pick assets from the multisig wallet “{resolvedHandle ? handleLabel(resolvedHandle) : wallet.name}”. Connected wallets are used only to sign, never as the asset source.</p></div><Card className="glass-panel w-full max-w-sm"><CardContent className="space-y-3 p-4"><div className="flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-medium"><WalletCards className="size-4 text-sky-300" /> Signer wallet</div><Badge variant={connected ? "default" : "secondary"}>{connected ? "connected" : "off"}</Badge></div><div className="text-xs text-slate-400">{connected ? `${connected.name} · ${networkLabel(connected.networkId)}` : providers.length ? "Connect only to sign — assets come from the multisig wallet" : "No browser wallet detected"}</div><div className="flex flex-wrap gap-2">{providers.map((provider) => <Button key={provider.id} size="sm" variant="secondary" disabled={Boolean(connecting)} onClick={() => connect(provider)}>{connecting === provider.id ? "Waiting..." : provider.name}</Button>)}</div></CardContent></Card></div>
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]"><Card className="glass-panel"><CardHeader><CardTitle>Transaction details</CardTitle><CardDescription>Select assets, enter the recipient, then the server builds a balanced unsigned transaction from the multisig UTxOs. The connected browser wallet is used only for signing.</CardDescription></CardHeader><CardContent className="space-y-5"><div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label>Title</Label><Input value={title} onChange={(event) => setTitle(event.target.value)} /></div><div className="space-y-2"><Label>Recipient address</Label><Input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="addr..." /></div></div><div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100"><div className="flex flex-wrap items-center justify-between gap-3"><span><Database className="mr-2 inline size-4" /> {assetStatus}</span><Button variant="secondary" size="sm" onClick={() => refreshMultisigAssets()}><RefreshCw className="size-4" /> Refresh</Button></div></div><div className="space-y-3"><div className="flex items-center justify-between"><Label>Assets</Label><Button variant="secondary" size="sm" onClick={addAsset}>Add asset</Button></div>{assets.map((asset) => { const option = assetOptions.find((item) => item.unit === asset.unit); return <div key={asset.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_40px]"><select className="h-10 rounded-md border border-input bg-transparent px-3 py-1 text-base text-slate-100 shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]" value={asset.unit} onChange={(event) => applyAsset(asset.id, event.target.value)}>{assetOptions.map((option) => <option className="bg-slate-950 text-slate-100" key={option.unit} value={option.unit}>{option.label} · {formatRawQuantity(option.quantity, option.unit, option.decimals)}</option>)}</select><Input value={asset.quantity} onChange={(event) => updateAsset(asset.id, { quantity: event.target.value })} placeholder="Quantity" /><Button variant="secondary" size="icon" disabled={assets.length <= 1} onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))}><Trash2 className="size-4" /></Button><div className="md:col-span-3 -mt-1 truncate text-xs text-slate-500">Available: {formatRawQuantity(option?.quantity || asset.maxQuantity || "0", asset.unit, option?.decimals ?? asset.decimals)} · unit {asset.unit}</div></div>; })}</div><details className="rounded-lg border border-border bg-slate-950/40 p-3 text-sm text-slate-400"><summary className="cursor-pointer text-slate-200">Advanced: unsigned transaction CBOR</summary><Textarea className="mt-3 min-h-32 font-mono text-xs" value={unsignedTxCbor} onChange={(event) => setUnsignedTxCbor(event.target.value)} placeholder="Generated automatically when you build the transaction." />{buildInfo ? <div className="mt-2 text-xs text-sky-200">{buildInfo}</div> : null}</details><div className="space-y-2"><Label>Note</Label><Textarea className="min-h-24" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Purpose shown to co-signers" /></div><Button className="w-full" onClick={createAndMaybeSign}><ShieldCheck className="size-4" /> {connected ? "Build & sign transaction" : "Build pending transaction"}</Button>{status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}</CardContent></Card><Card className="glass-panel"><CardHeader><CardTitle>Preview</CardTitle><CardDescription>{wallet.threshold || 1} required signatures from {wallet.signers.length} signers.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="rounded-lg border border-border bg-slate-950/60 p-4"><div className="text-sm text-slate-400">Wallet</div><div className="font-semibold text-slate-100">{resolvedHandle ? handleLabel(resolvedHandle) : wallet.name}</div></div>{assets.map((asset) => <div key={asset.id} className="rounded-lg border border-border bg-slate-950/60 p-4"><div className="text-sm text-slate-400">{asset.label || assetLabel(asset.unit)}</div><div className="font-mono text-sm text-slate-100">{asset.quantity || "0"} {asset.label || assetLabel(asset.unit)}</div><div className="mt-1 truncate text-xs text-slate-500">{asset.unit}</div></div>)}<div className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-100">The app builds the unsigned transaction for you. It stays <b>pending</b> until enough signer witnesses are collected and submission is confirmed.</div></CardContent></Card></section></main>;
}
