import { Link, useParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock3, Database, Plus, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

type NativeScript = { type: string; keyHash?: string; scripts?: NativeScript[]; required?: number; slot?: number; [key: string]: unknown };
type Signer = { id: string; label: string; keyHash: string; source?: "payment" | "stake" | "manual" };
type Wallet = { id: string; name: string; handle?: string; network: string; threshold: number; signers: Signer[]; paymentScript: NativeScript; stakeScript?: NativeScript | null; imported: boolean; createdAt: string };
type SignatureRecord = { signerKeyHash: string; signerName: string; walletName: string; witnessCbor: string; signedAt: string };
type AssetLine = { id: string; unit: string; label: string; quantity: string; decimals?: number };
type AssetOption = { unit: string; label: string; quantity: string; outputCount?: number; decimals?: number };
type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };
type AssetFetch = { assets: AssetOption[]; handle?: HandleInfo | null; source?: string; address?: string; outputs?: number };
type TxStatus = "pending" | "succeeded" | "failed";
type TxDraft = { id: string; walletId?: string; title: string; walletName: string; network: string; recipient: string; lovelace: string; note: string; unsignedTxCbor: string; requiredSignatures: number; signerKeyHashes: string[]; signatures: SignatureRecord[]; assets?: AssetLine[]; status?: TxStatus; createdAt: string; updatedAt?: string; txHash?: string; failureReason?: string };
const WALLET_KEY = "cardano-multisig.wallets.v2";
const TX_KEY = "cardano-multisig.transactions.v1";

export function meta() { return [{ title: "Wallet · Cardano Multisig" }]; }
function readArray<T>(key: string): T[] { if (typeof window === "undefined") return []; try { const parsed = JSON.parse(window.localStorage.getItem(key) || "[]"); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; } }
function writeArray<T>(key: string, value: T[]) { window.localStorage.setItem(key, JSON.stringify(value, null, 2)); }
function summarizeScript(script?: NativeScript | null) { if (!script) return "not provided"; const leaves = countLeaves(script); if (script.type === "sig") return "1-of-1"; if (script.type === "any") return `1-of-${leaves}`; if (script.type === "all") return `${leaves}-of-${leaves}`; if (script.type === "atLeast") return `${script.required ?? 0}-of-${leaves}`; return script.type; }
function countLeaves(script: NativeScript): number { if (script.type === "sig") return 1; return Array.isArray(script.scripts) ? script.scripts.reduce((sum, child) => sum + countLeaves(child), 0) : 0; }
function signedCount(tx: TxDraft) { const signed = new Set((tx.signatures || []).map((sig) => sig.signerKeyHash.toLowerCase())); return (tx.signerKeyHashes || []).filter((hash) => signed.has(hash.toLowerCase())).length; }
function txStatus(tx: TxDraft): TxStatus { return tx.status || "pending"; }
function statusBadge(status: TxStatus) { if (status === "succeeded") return "default" as const; if (status === "failed") return "destructive" as const; return "outline" as const; }
function statusIcon(status: TxStatus) { if (status === "succeeded") return <CheckCircle2 className="size-4 text-emerald-300" />; if (status === "failed") return <XCircle className="size-4 text-red-300" />; return <Clock3 className="size-4 text-amber-300" />; }
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
function defaultDisplayAmount(asset: { unit: string; decimals?: number }) { return asset.unit === "lovelace" ? "2" : "1"; }
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
async function fetchWalletAssets(wallet: Wallet): Promise<AssetFetch> { const { patterns, stakeAddress } = await walletResolution(wallet); const query = assetQuery(patterns, wallet, stakeAddress); if (!query) throw new Error("Could not derive wallet script hash or ADA Handle."); const res = await fetch(`/api/cardano/assets?${query}`); const body = await res.json(); if (!res.ok) throw new Error(body.error || "Could not load multisig assets."); return { assets: body.assets || [], handle: body.handle, source: body.source, address: body.address, outputs: body.outputs }; }

export default function WalletDetail() {
  const { walletId } = useParams();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [txs, setTxs] = useState<TxDraft[]>([]);
  const [walletAssets, setWalletAssets] = useState<AssetOption[]>([]);
  const [resolvedHandle, setResolvedHandle] = useState<HandleInfo | null>(null);
  const [handleInput, setHandleInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [assetStatus, setAssetStatus] = useState("Loading multisig assets…");
  useEffect(() => { setWallets(readArray<Wallet>(WALLET_KEY)); setTxs(readArray<TxDraft>(TX_KEY)); }, []);
  const wallet = wallets.find((item) => item.id === walletId);
  useEffect(() => { if (wallet) { setHandleInput(wallet.handle || ""); setNameInput(wallet.name || ""); } }, [wallet?.id]);
  const walletTxs = useMemo(() => txs.filter((tx) => tx.walletId === walletId || (!tx.walletId && wallet && tx.walletName === wallet.name)).sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || "")), [txs, wallet, walletId]);
  function updateStatus(id: string, status: TxStatus) { const next = txs.map((tx) => tx.id === id ? { ...tx, status, updatedAt: new Date().toISOString() } : tx); setTxs(next); writeArray(TX_KEY, next); }
  function saveHandle() { if (!wallet) return; const clean = handleInput.trim().replace(/^\$/, ""); const label = nameInput.trim() || wallet.name || (clean ? `$${clean}` : "Imported wallet"); const next = wallets.map((item) => item.id === wallet.id ? { ...item, name: label, handle: clean || undefined } : item); setWallets(next); writeArray(WALLET_KEY, next); void refreshAssets({ ...wallet, name: label, handle: clean || undefined }); }
  async function refreshAssets(target = wallet) { if (!target) return; setAssetStatus("Loading multisig assets from Kupo…"); try { const result = await fetchWalletAssets(target); setWalletAssets(result.assets); setResolvedHandle(result.handle || null); if (result.handle && target && !target.handle) { const next = wallets.map((item) => item.id === target.id ? { ...item, handle: result.handle!.name } : item); setWallets(next); writeArray(WALLET_KEY, next); setHandleInput(result.handle.name); } const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : ""; setAssetStatus(result.assets.length ? `${prefix}Loaded ${result.assets.length} multisig asset${result.assets.length === 1 ? "" : "s"} from ${result.source || "server"}.` : `${prefix}No spendable multisig assets found yet.`); } catch (error) { setWalletAssets([]); setAssetStatus(error instanceof Error ? error.message : "Could not load multisig assets."); } }
  useEffect(() => { if (wallet) void refreshAssets(wallet); }, [wallet?.id]);

  if (!wallet) return <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100"><Link className="text-sm text-sky-300" to="/">← Back</Link><Card className="glass-panel mt-6"><CardContent className="p-8 text-slate-300">Wallet not found in this browser. Import or create it first.</CardContent></Card></main>;
  const pending = walletTxs.filter((tx) => txStatus(tx) === "pending").length;
  const succeeded = walletTxs.filter((tx) => txStatus(tx) === "succeeded").length;
  const failed = walletTxs.filter((tx) => txStatus(tx) === "failed").length;

  return <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><Link to="/" className="inline-flex items-center gap-2 text-sm text-sky-300"><ArrowLeft className="size-4" /> Back to wallets</Link><h1 className="mt-3 text-4xl font-semibold tracking-[-0.06em] text-slate-50">{resolvedHandle ? handleLabel(resolvedHandle) : wallet.name}</h1><p className="mt-2 text-slate-400">{resolvedHandle ? `${wallet.name} · ` : ""}{wallet.network} · {wallet.signers.length} signers · payment {summarizeScript(wallet.paymentScript)} · stake {summarizeScript(wallet.stakeScript)}</p></div><a href={`/wallets/${encodeURIComponent(wallet.id)}/transactions/new`} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs transition hover:bg-primary/90"><Plus className="size-4" /> Create transaction</a></div>
    <section className="grid gap-4 md:grid-cols-4"><Card className="glass-panel"><CardContent className="p-4"><div className="text-2xl font-semibold text-sky-200">{walletTxs.length}</div><div className="text-xs text-slate-400">transactions</div></CardContent></Card><Card className="glass-panel"><CardContent className="p-4"><div className="text-2xl font-semibold text-amber-300">{pending}</div><div className="text-xs text-slate-400">pending</div></CardContent></Card><Card className="glass-panel"><CardContent className="p-4"><div className="text-2xl font-semibold text-emerald-300">{succeeded}</div><div className="text-xs text-slate-400">succeeded</div></CardContent></Card><Card className="glass-panel"><CardContent className="p-4"><div className="text-2xl font-semibold text-red-300">{failed}</div><div className="text-xs text-slate-400">failed</div></CardContent></Card></section>

    <Card className="glass-panel"><CardHeader><CardTitle>Wallet identity</CardTitle><CardDescription>Rename the local label or resolve the treasury ADA Handle so balances come from the exact multisig address.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><div className="space-y-2"><Label>Local label</Label><Input value={nameInput} onChange={(event) => setNameInput(event.target.value)} placeholder="Treasury wallet" /></div><div className="space-y-2"><Label>ADA Handle</Label><Input value={handleInput} onChange={(event) => setHandleInput(event.target.value)} placeholder="$discatalyst" /></div><div className="flex items-end"><Button variant="secondary" onClick={saveHandle}>Save identity</Button></div>{resolvedHandle ? <div className="md:col-span-3 truncate rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">Resolved {handleLabel(resolvedHandle)} → {resolvedHandle.address}</div> : null}</CardContent></Card>
    <Card className="glass-panel"><CardHeader><CardTitle>Transactions</CardTitle><CardDescription>Recovered from this browser. Pending rooms keep their signatures and invite data after reload.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full min-w-[860px] text-left text-sm"><thead className="border-b border-border text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-3 pr-4">Transaction</th><th className="py-3 pr-4">Assets</th><th className="py-3 pr-4">Signatures</th><th className="py-3 pr-4">Status</th><th className="py-3 pr-4">Created</th><th className="py-3 text-right">Actions</th></tr></thead><tbody className="divide-y divide-border">{walletTxs.length === 0 ? <tr><td className="py-6 pr-4 text-slate-400" colSpan={6}>No transactions yet. Create one to start collecting signatures.</td></tr> : walletTxs.map((tx) => { const status = txStatus(tx); const signed = signedCount(tx); const pendingSigners = Math.max((tx.requiredSignatures || 0) - signed, 0); return <tr key={tx.id} className="align-top"><td className="py-4 pr-4"><div className="font-semibold text-slate-100">{tx.title}</div><div className="mt-1 max-w-xs truncate text-xs text-slate-500">{tx.recipient || "No recipient"}</div></td><td className="py-4 pr-4 text-slate-300">{(tx.assets?.length ? tx.assets : [{ label: "ADA", quantity: tx.lovelace || "0", unit: "lovelace", id: "ada" }]).map((asset) => <div key={asset.id} className="mb-1"><span className="font-medium">{formatRawQuantity(asset.quantity, asset.unit, asset.decimals)}</span></div>)}</td><td className="py-4 pr-4"><div className="font-semibold text-slate-100">{signed}/{tx.requiredSignatures} signed</div><div className="text-xs text-amber-300">{pendingSigners} pending</div></td><td className="py-4 pr-4"><Badge variant={statusBadge(status)}>{statusIcon(status)} {status}</Badge></td><td className="py-4 pr-4 text-xs text-slate-400">{tx.createdAt ? new Date(tx.createdAt).toLocaleString() : "—"}</td><td className="py-4 text-right"><div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => updateStatus(tx.id, "succeeded")}>Succeeded</Button><Button size="sm" variant="destructive" onClick={() => updateStatus(tx.id, "failed")}>Failed</Button></div></td></tr>; })}</tbody></table></div></CardContent></Card>
    <Card className="glass-panel"><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Multisig assets</CardTitle><CardDescription>{resolvedHandle ? `ADA Handle ${handleLabel(resolvedHandle)} resolved to this multisig script address.` : "Fetched from the server-managed Kupo indexer for this script wallet."}</CardDescription></div><Button variant="secondary" size="sm" onClick={() => refreshAssets()}><RefreshCw className="size-4" /> Refresh</Button></div></CardHeader><CardContent>{walletAssets.length === 0 ? <div className="rounded-lg border border-border bg-slate-950/60 p-4 text-sm text-slate-400"><Database className="mr-2 inline size-4 text-sky-300" /> {assetStatus}</div> : <div className="grid gap-3 md:grid-cols-3">{walletAssets.map((asset) => <div className="rounded-lg border border-border bg-slate-950/60 p-4" key={asset.unit}><div className="text-sm text-slate-400">{asset.label}</div><div className="mt-1 font-mono text-lg font-semibold text-slate-100">{formatRawQuantity(asset.quantity, asset.unit, asset.decimals)}</div><div className="mt-1 truncate text-xs text-slate-500">{asset.unit}</div></div>)}</div>}<div className="mt-3 text-xs text-slate-500">{assetStatus}</div></CardContent></Card>
    <Card className="glass-panel"><CardHeader><CardTitle>Wallet info</CardTitle><CardDescription>Signer threshold and script summaries for this wallet.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-3"><div className="rounded-lg border border-border bg-slate-950/60 p-4"><div className="text-sm text-slate-400">Payment script</div><div className="mt-1 font-semibold text-slate-100">{summarizeScript(wallet.paymentScript)}</div></div><div className="rounded-lg border border-border bg-slate-950/60 p-4"><div className="text-sm text-slate-400">Stake script</div><div className="mt-1 font-semibold text-slate-100">{summarizeScript(wallet.stakeScript)}</div></div><div className="rounded-lg border border-border bg-slate-950/60 p-4"><div className="text-sm text-slate-400">Signer hashes</div><div className="mt-1 font-semibold text-slate-100">{wallet.signers.length}</div></div></CardContent></Card>

  </main>;
}
