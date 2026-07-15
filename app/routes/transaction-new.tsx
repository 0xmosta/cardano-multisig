import { Link, useNavigate, useParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Coins,
  Database,
  FileCode2,
  ImageIcon,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  WalletCards,
  X,
} from "lucide-react";
import { AccountSyncPanel } from "../components/account-sync-panel";
import { useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { userFacingError } from "../lib/utils";
import {
  type AssetLine,
  type MultisigWallet as Wallet,
  type NativeScript,
  type Network,
  type SignatureRecord,
  type TxDraft,
  createId,
  expectedNetworkId,
  formatTargetNetwork,
  mergeTransactionDrafts,
  networkLabel,
  nowIso,
} from "../lib/multisig";

type AssetOption = {
  unit: string;
  label: string;
  quantity: string;
  outputCount?: number;
  decimals?: number;
  source: "treasury" | "default";
  subject?: string;
  fingerprint?: string;
  image?: string;
  mediaType?: string;
  policyId?: string;
  assetName?: string;
};

type SelectedAsset = AssetLine & {
  maxQuantity?: string;
  fingerprint?: string;
  image?: string;
  subject?: string;
  policyId?: string;
  assetName?: string;
};

type HandleInfo = {
  name: string;
  address: string;
  holder?: string;
  holderType?: string;
  image?: string;
};

type AssetFetch = {
  assets: AssetOption[];
  handle?: HandleInfo | null;
  source?: string;
  address?: string;
  outputs?: number;
};

const DEFAULT_ASSET: AssetOption = {
  unit: "lovelace",
  label: "ADA",
  quantity: "0",
  decimals: 6,
  source: "default",
};

export function meta() {
  return [{ title: "Create transaction · Cardano Multisig" }];
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

function toRawQuantity(display: string, decimals = 0) {
  const normalized = (display || "0").replace(/,/g, "").trim();
  if (!normalized) return "0";
  const [wholeRaw, fracRaw = ""] = normalized.split(".");
  const whole = BigInt(wholeRaw || "0");
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return (whole * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}

function defaultDisplayAmount(asset: { unit: string; decimals?: number }) {
  return asset.unit === "lovelace" ? "2" : "1";
}

function compactMiddle(value = "", start = 10, end = 6) {
  if (!value || value.length <= start + end + 3) return value;
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
  className = "size-11",
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
      <div className={`${className} overflow-hidden rounded-md border border-white/10 bg-black/30`}>
        <img
          src={asset.image}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(asset.image || "")}
        />
      </div>
    );
  }
  return (
    <div className={`${className} flex shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-300`}>
      {asset.unit === "lovelace" ? <Coins className="size-5 text-sky-200" /> : <ImageIcon className="size-5 text-zinc-400" />}
    </div>
  );
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

async function fetchMultisigAssets(wallet: Wallet): Promise<AssetFetch> {
  const { patterns, stakeAddress } = await walletResolution(wallet);
  const query = assetQuery(patterns, wallet, stakeAddress);
  if (!query) {
    throw new Error("Could not derive the wallet script hash or ADA Handle yet. Re-import the wallet if this persists.");
  }

  const response = await fetch(`/api/cardano/assets?${query}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not fetch multisig assets.");

  return {
    assets: (body.assets || []).map((asset: AssetOption) => ({ ...asset, source: "treasury" as const })),
    handle: body.handle,
    source: body.source,
    address: body.address,
    outputs: body.outputs,
  };
}

export default function NewTransaction() {
  const { walletId } = useParams();
  const navigate = useNavigate();
  const { account, accountState, connected, saveServerState } = useAppShell();

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [multisigAssets, setMultisigAssets] = useState<AssetOption[]>([]);
  const [resolvedHandle, setResolvedHandle] = useState<HandleInfo | null>(null);
  const [handleConflict, setHandleConflict] = useState("");
  const [assetStatus, setAssetStatus] = useState("Loading available assets…");
  const [title, setTitle] = useState("Treasury payment");
  const [recipient, setRecipient] = useState("");
  const [assets, setAssets] = useState<SelectedAsset[]>([
    { id: createId("asset"), unit: "lovelace", label: "ADA", quantity: "2", decimals: 6 },
  ]);
  const [unsignedTxCbor, setUnsignedTxCbor] = useState("");
  const [buildInfo, setBuildInfo] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (account.authenticated && accountState) {
      setWallets(accountState.wallets as Wallet[]);
      return;
    }
    setWallets([]);
  }, [account.authenticated, accountState]);

  const wallet = wallets.find((item) => item.id === walletId);
  const isWatchOnly = wallet ? !wallet.paymentScript : false;
  const assetOptions = useMemo(
    () =>
      (multisigAssets.length ? multisigAssets : [DEFAULT_ASSET]).sort((left, right) => {
        if (left.unit === "lovelace") return -1;
        if (right.unit === "lovelace") return 1;
        return left.label.localeCompare(right.label);
      }),
    [multisigAssets],
  );

  const walletNetworkWarning =
    connected && wallet && connected.networkId >= 0 && connected.networkId !== expectedNetworkId(wallet.network)
      ? `Connected wallet is on ${networkLabel(connected.networkId)}, but this multisig wallet is on ${formatTargetNetwork(wallet.network)}. Switch the wallet network before signing.`
      : "";
  const requestedAssetSummary = assets.map((asset) => {
    const option = assetOptions.find((item) => item.unit === asset.unit);
    return {
      ...asset,
      image: asset.image || option?.image,
      fingerprint: asset.fingerprint || option?.fingerprint,
      policyId: asset.policyId || option?.policyId,
      assetName: asset.assetName || option?.assetName,
      available: option?.quantity,
    };
  });
  const readyToBuild = !handleConflict && Boolean(recipient.trim()) && assets.some((asset) => Number(asset.quantity || "0") > 0);
  const totalAssetCount = assetOptions.filter((asset) => asset.unit !== "lovelace").length;

  useEffect(() => {
    if (!wallet || isWatchOnly) return;
    void refreshMultisigAssets(wallet);
  }, [wallet?.id, isWatchOnly]);

  async function refreshMultisigAssets(target = wallet) {
    if (!target) return;
    setResolvedHandle(null);
    setHandleConflict("");
    setAssetStatus("Loading available assets…");
    try {
      const result = await fetchMultisigAssets(target);
      const fetched = result.assets;
      setResolvedHandle(result.handle || null);
      const savedHandle = handleCandidate(target);
      const resolvedName = result.handle?.name.trim().replace(/^\$/, "").toLowerCase() || "";
      setHandleConflict(
        savedHandle && resolvedName && savedHandle !== resolvedName
          ? `Saved identity $${savedHandle} does not match this payment policy. The policy address resolves to $${resolvedName}.`
          : "",
      );
      setMultisigAssets(fetched.length ? fetched : [DEFAULT_ASSET]);
      const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : "";
      setAssetStatus(
        fetched.length
          ? `${prefix}${fetched.length} asset${fetched.length === 1 ? "" : "s"} available.`
          : `${prefix}No spendable multisig assets found yet.`,
      );
    } catch (error) {
      setMultisigAssets([DEFAULT_ASSET]);
      setAssetStatus(userFacingError(error, "We could not load available assets. Try again."));
    }
  }

  function applyAsset(id: string, unit: string) {
    const chosen = assetOptions.find((asset) => asset.unit === unit) || DEFAULT_ASSET;
    setAssets((current) =>
      current.map((asset) =>
        asset.id === id
          ? {
              ...asset,
              unit: chosen.unit,
              label: chosen.label,
              decimals: chosen.decimals ?? (chosen.unit === "lovelace" ? 6 : 0),
              maxQuantity: chosen.quantity,
              fingerprint: chosen.fingerprint,
              image: chosen.image,
              subject: chosen.subject,
              policyId: chosen.policyId,
              assetName: chosen.assetName,
              quantity: defaultDisplayAmount(chosen),
            }
          : asset,
      ),
    );
  }

  function updateAsset(id: string, patch: Partial<SelectedAsset>) {
    setAssets((current) => current.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)));
  }

  function addAsset() {
    const existing = new Set(assets.map((asset) => asset.unit));
    const next = assetOptions.find((asset) => !existing.has(asset.unit)) || assetOptions[0] || DEFAULT_ASSET;
    setAssets((current) => [
      ...current,
      {
        id: createId("asset"),
        unit: next.unit,
        label: next.label,
        quantity: defaultDisplayAmount(next),
        maxQuantity: next.quantity,
        decimals: next.decimals ?? (next.unit === "lovelace" ? 6 : 0),
        fingerprint: next.fingerprint,
        image: next.image,
        subject: next.subject,
        policyId: next.policyId,
        assetName: next.assetName,
      },
    ]);
  }

  function removeAsset(id: string) {
    setAssets((current) => (current.length > 1 ? current.filter((item) => item.id !== id) : current));
  }

  async function buildUnsignedTx(txAssets: AssetLine[]) {
    if (!wallet) throw new Error("Wallet not loaded.");
    if (!account.authenticated || !account.session) throw new Error("Sign in with a wallet before building a transaction.");
    if (!recipient.trim()) throw new Error("Enter a recipient address.");

    setStatus("Preparing your transaction…");
    const response = await fetch("/api/cardano/build-tx", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cardano-multisig-csrf": account.session.csrfToken,
      },
      body: JSON.stringify({ wallet, recipient: recipient.trim(), assets: txAssets }),
    });
    const body = await response.json();

    if (!response.ok || !body.ok) {
      throw new Error(body.error || "Could not build transaction.");
    }

    setUnsignedTxCbor(body.unsignedTxCbor);
    const minAdaNote = body.adjustedMinAda
      ? ` Output ADA was raised to the minimum ${formatRawQuantity(String(body.minAda || "0"), "lovelace", 6)} required for native assets.`
      : "";
    setBuildInfo(
      `Built from ${body.inputCount} UTxO${body.inputCount === 1 ? "" : "s"}; fee ${formatRawQuantity(String(body.fee || "0"), "lovelace", 6)}.${minAdaNote}`,
    );
    toast.success("Transaction prepared", {
      description: "Review the wallet approval request to continue.",
    });
    return { cbor: String(body.unsignedTxCbor || ""), assets: Array.isArray(body.assets) ? body.assets : txAssets };
  }

  async function createAndMaybeSign() {
    if (!wallet) return;
    if (!account.authenticated || !accountState) {
      setStatus("Sign in before creating a transaction.");
      toast.error("Sign in required");
      return;
    }
    if (handleConflict) {
      setStatus(handleConflict);
      toast.error("Wallet identity mismatch", { description: handleConflict });
      return;
    }
    if (!wallet.paymentScript) {
      setStatus("This wallet was imported from an address or ADA Handle. Import the native script or wallet export before creating transactions.");
      toast.error("Native script required");
      return;
    }

    const now = nowIso();
    const txAssets = assets.map((asset) => ({
      ...asset,
      quantity: toRawQuantity(asset.quantity, asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0)),
    }));

    let builtCbor = unsignedTxCbor.trim();
    let builtAssets = txAssets;
    let signatures: SignatureRecord[] = [];

    try {
      const built = await buildUnsignedTx(txAssets);
      builtCbor = built.cbor;
      builtAssets = built.assets;
    } catch (error) {
      setStatus(userFacingError(error, "We could not prepare the transaction."));
      toast.error("Could not build transaction", {
        description: userFacingError(error, "We could not prepare the transaction."),
      });
      return;
    }

    if (connected) {
      if (walletNetworkWarning) {
        setStatus(walletNetworkWarning);
        toast.warning("Wrong wallet network", { description: walletNetworkWarning });
        return;
      }

      try {
        setStatus(`Requesting ${connected.name} signature…`);
        const witnessCbor = await connected.api.signTx(builtCbor, true);
        signatures = [
          {
            signerKeyHash: connected.keyHash?.toLowerCase() || `unknown-${connected.id}`,
            signerName: connected.keyHash ? connected.keyHash.toLowerCase() : connected.name,
            walletName: connected.name,
            witnessCbor,
            signedAt: nowIso(),
          },
        ];
        setStatus(
          connected.keyHash
            ? "Transaction created and your signature was added."
            : "Transaction created and signed, but we could not match the signing key automatically.",
        );
        toast.success("Transaction signed", {
          description: connected.keyHash ? "Your signature is saved." : "The signer key could not be matched automatically.",
        });
      } catch (error) {
        setStatus(userFacingError(error, "The wallet did not approve the signature."));
        toast.error("Wallet refused to sign", {
          description: userFacingError(error, "The signing request was cancelled or rejected."),
        });
        return;
      }
    } else {
      setStatus("Transaction created. Open it from the wallet to invite signers.");
      toast("Transaction created", {
        description: "Open the wallet to share it with signers.",
      });
    }

    const tx: TxDraft = {
      id: createId("tx"),
      walletId: wallet.id,
      title: title.trim() || "Transaction",
      walletName: wallet.name,
      network: wallet.network as Network,
      recipient: recipient.trim(),
      lovelace: assets.find((asset) => asset.unit === "lovelace")
        ? toRawQuantity(
            assets.find((asset) => asset.unit === "lovelace")!.quantity,
            assets.find((asset) => asset.unit === "lovelace")!.decimals ?? 6,
          )
        : "0",
      note: note.trim(),
      unsignedTxCbor: builtCbor,
      requiredSignatures: Math.max(wallet.threshold || 1, 1),
      signerKeyHashes: wallet.signers.map((signer) => signer.keyHash),
      signatures,
      assets: builtAssets,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    try {
      const nextTransactions = mergeTransactionDrafts(accountState.transactions, [tx]);
      const saved = await saveServerState({ wallets: accountState.wallets, transactions: nextTransactions });
      if (!saved) throw new Error("The server did not save the transaction.");
    } catch (error) {
      const message = userFacingError(error, "We could not save the transaction.");
      setStatus(message);
      toast.error("Could not save transaction", { description: message });
      return;
    }
    toast.success("Transaction saved", {
      description: "It is now available from your wallet on every signed-in device.",
    });
    navigate(`/wallets/${encodeURIComponent(wallet.id)}?draft=${encodeURIComponent(tx.id)}`);
  }

  if (!wallet) {
    return (
      <div className="flex flex-col gap-6">
        <Link className="text-sm text-sky-300" to="/wallets">
          ← Back
        </Link>
        <Card className="glass-panel">
          <CardContent className="p-8 text-slate-300">Wallet not found. Import or create it first.</CardContent>
        </Card>
      </div>
    );
  }

  if (isWatchOnly) {
    return (
      <div className="flex flex-col gap-6">
        <Link className="inline-flex items-center gap-2 text-sm text-sky-300" to={`/wallets/${encodeURIComponent(wallet.id)}`}>
          <ArrowLeft className="size-4" /> Back to wallet
        </Link>
        <Card className="glass-panel">
          <CardHeader>
            <CardTitle>Native script required</CardTitle>
            <CardDescription>
              {wallet.name} was saved from an address or ADA Handle, so it is watch-only. Import the native script or wallet export before creating transactions from this multisig wallet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link to="/wallets/import">Import script or wallet export</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 overflow-x-hidden">
      <AccountSyncPanel compact />
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <Link to={`/wallets/${encodeURIComponent(wallet.id)}`} className="inline-flex items-center gap-2 text-sm text-sky-300 transition hover:text-sky-200">
            <ArrowLeft className="size-4" /> Back to wallet
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-slate-50 sm:text-4xl">Create transaction</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Choose what to send, review the recipient, then create the request for your signers.</p>
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-sm text-slate-400 sm:w-auto">
          <span className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
            <WalletCards className="size-4 text-slate-300" />
            <span className="max-w-56 truncate">{wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name}</span>
          </span>
          <span className="rounded-md border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-emerald-100">
            {wallet.threshold}-of-{wallet.signers.length}
          </span>
        </div>
      </div>

      {handleConflict ? (
        <Card className="border-rose-400/30 bg-rose-400/10">
          <CardContent className="flex gap-3 p-4 text-sm text-rose-100">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{handleConflict} Transaction creation is disabled until the saved identity or imported policy is corrected.</span>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AppWindow title="1. Payment details" className="max-w-full" contentClassName="space-y-5 p-3 sm:p-5">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-white/8 bg-black/20 p-3">
              <div className="text-xs font-medium uppercase text-slate-500">1. Details</div>
              <div className="mt-1 text-sm font-semibold text-slate-100">{recipient.trim() ? "Recipient ready" : "Add recipient"}</div>
            </div>
            <div className="rounded-lg border border-white/8 bg-black/20 p-3">
              <div className="text-xs font-medium uppercase text-slate-500">2. Assets</div>
              <div className="mt-1 truncate text-sm font-semibold text-slate-100">{assets.length} selected</div>
            </div>
            <div className="rounded-lg border border-white/8 bg-black/20 p-3">
              <div className="text-xs font-medium uppercase text-slate-500">3. Review</div>
              <div className="mt-1 text-sm font-semibold text-slate-100">{wallet.threshold} signature{wallet.threshold === 1 ? "" : "s"} required</div>
            </div>
          </div>

          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
            <div className="min-w-0 space-y-2">
              <Label>Transaction name</Label>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} className="h-11" />
            </div>
            <div className="min-w-0 space-y-2">
              <Label>Recipient address</Label>
              <Input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="addr1... or addr_test1..." className="h-11 font-mono text-sm" />
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-400/18 bg-sky-400/[0.08] px-3 py-2.5 text-sm text-sky-100">
            <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
              {assetStatus.toLowerCase().startsWith("loading") ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-sky-200" />
              ) : (
                <Database className="size-4 shrink-0 text-sky-200" />
              )}
              <span className="truncate">{assetStatus}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => refreshMultisigAssets()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
          </div>

          <div className="min-w-0 space-y-3 rounded-lg border border-white/8 bg-black/15 p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Label>2. Assets</Label>
                <div className="mt-1 text-xs text-slate-500">
                  {assetOptions.length} spendable option{assetOptions.length === 1 ? "" : "s"}
                  {totalAssetCount ? `, ${totalAssetCount} native asset${totalAssetCount === 1 ? "" : "s"}` : ""}.
                </div>
              </div>
              <Button variant="secondary" size="sm" onClick={addAsset}>
                Add asset
              </Button>
            </div>
            {assets.map((asset) => {
                const option = assetOptions.find((item) => item.unit === asset.unit);
                const selected = option || ({ ...asset, source: "treasury", outputCount: 0 } satisfies AssetOption);
                return (
                  <div key={asset.id} className="min-w-0 rounded-lg border border-white/8 bg-[#111113] p-3 transition focus-within:border-white/15 hover:border-white/12">
                    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_180px_36px]">
                      <div className="min-w-0">
                        <Select value={asset.unit} onValueChange={(unit) => applyAsset(asset.id, unit)}>
                          <SelectTrigger className="h-auto min-h-16 w-full min-w-0 border-white/10 bg-[#18181b] px-3 py-2 text-left hover:border-white/18 hover:bg-white/[0.04] [&>svg]:ml-auto">
                            <span className="flex min-w-0 flex-1 items-center gap-3">
                              <AssetThumb asset={selected} />
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-slate-100">
                                  {selected.label}
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-slate-500">
                                  {assetSubtitle(selected)}
                                </span>
                              </span>
                            </span>
                          </SelectTrigger>
                          <SelectContent className="max-h-96">
                            {assetOptions.map((choice) => (
                              <SelectItem key={choice.unit} value={choice.unit} className="py-2">
                                <span className="flex min-w-0 items-center gap-3">
                                  <AssetThumb asset={choice} className="size-10" />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold">{choice.label}</span>
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">{assetSubtitle(choice)}</span>
                                  </span>
                                  <span className="ml-3 shrink-0 rounded-md border border-border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground">
                                    {formatRawQuantity(choice.quantity, choice.unit, choice.decimals)}
                                  </span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="min-w-0 rounded-md border border-input bg-[#18181b] px-3 py-2">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                          <span>Amount</span>
                          <span className="min-w-0 truncate text-right">{asset.unit === "lovelace" ? "ADA" : selected.label}</span>
                        </div>
                        <Input
                          value={asset.quantity}
                          onChange={(event) => updateAsset(asset.id, { quantity: event.target.value })}
                          placeholder="0"
                          className="h-9 w-full border-0 bg-transparent px-0 text-right text-lg font-semibold text-slate-50 shadow-none"
                        />
                      </div>
                      <Button variant="ghost" className="h-10 w-full rounded-md lg:h-16" onClick={() => removeAsset(asset.id)} disabled={assets.length === 1} aria-label="Remove asset">
                        <X className="size-4" />
                      </Button>
                    </div>
                    {option?.quantity ? (
                      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1">
                          Available {formatRawQuantity(option.quantity, option.unit, option.decimals)}
                        </span>
                        {option.outputCount ? (
                          <span className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1">
                            {option.outputCount} UTxO{option.outputCount === 1 ? "" : "s"}
                          </span>
                        ) : null}
                        {option.policyId ? <span className="max-w-full truncate rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 font-mono">policy {compactMiddle(option.policyId, 12, 8)}</span> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>

          <div className="min-w-0 space-y-2">
            <Label>Coordinator note</Label>
            <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What signers should check before approving" className="h-11" />
          </div>

          <Collapsible className="min-w-0 rounded-lg border border-white/8 bg-black/20">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="flex h-auto w-full min-w-0 justify-between gap-3 px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/[0.03]">
              <span className="inline-flex min-w-0 items-center gap-2 truncate">
                <FileCode2 className="size-4 text-slate-500" /> Advanced unsigned transaction CBOR
              </span>
              <ChevronDown className="size-4 text-slate-500" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-white/8 p-3">
              <Textarea
                className="min-h-32 font-mono text-sm text-slate-100"
                value={unsignedTxCbor}
                onChange={(event) => setUnsignedTxCbor(event.target.value)}
                placeholder="The server will fill this after Build transaction."
              />
              {buildInfo ? <div className="text-xs text-slate-400">{buildInfo}</div> : null}
            </CollapsibleContent>
          </Collapsible>
        </AppWindow>

        <div className="min-w-0 space-y-4 xl:sticky xl:top-6">
          <Card className="glass-panel min-w-0 overflow-hidden rounded-lg">
            <CardHeader className="border-b border-white/8 px-4 py-4 sm:px-5">
              <CardTitle className="text-lg">3. Review and create</CardTitle>
              <CardDescription>Confirm the recipient and amounts before continuing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4 sm:p-5">
              <div className="space-y-3">
                {requestedAssetSummary.map((asset) => (
                  <div key={asset.id} className="flex min-w-0 items-center gap-3 rounded-md border border-white/8 bg-black/20 p-3">
                    <AssetThumb asset={asset} className="size-10" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-100">{asset.label}</div>
                      <div className="truncate text-xs text-slate-500">{assetSubtitle(asset)}</div>
                    </div>
                    <div className="max-w-20 shrink-0 truncate text-right text-sm font-semibold text-slate-100">{asset.quantity || "0"}</div>
                  </div>
                ))}
              </div>

              <div className="grid gap-2 text-sm">
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-white/8 bg-black/20 px-3 py-2">
                  <span className="text-slate-500">Recipient</span>
                  <span className="max-w-44 truncate text-slate-200">{recipient.trim() || "Not set"}</span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-white/8 bg-black/20 px-3 py-2">
                  <span className="text-slate-500">Signer wallet</span>
                  <span className="inline-flex max-w-44 items-center gap-1.5 truncate text-slate-200">
                    {connected ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-300" /> : null}
                    <span className="truncate">{connected ? connected.name : "Optional"}</span>
                  </span>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-white/8 bg-black/20 px-3 py-2">
                  <span className="text-slate-500">Required</span>
                  <span className="text-slate-200">{wallet.threshold} signature{wallet.threshold === 1 ? "" : "s"}</span>
                </div>
              </div>

              {walletNetworkWarning ? (
                <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
                  <AlertTriangle className="mr-2 inline size-4" /> {walletNetworkWarning}
                </div>
              ) : null}

              <Button className="h-11 w-full rounded-md" onClick={() => void createAndMaybeSign()} disabled={!readyToBuild}>
                {connected ? <ShieldCheck className="size-4" /> : <Send className="size-4" />}
                {connected ? "Create and sign" : "Create transaction"}
              </Button>

              <div className="text-xs leading-relaxed text-slate-500">
                After creation, you can share one link with the remaining signers and follow progress from the wallet.
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}
    </div>
  );
}
