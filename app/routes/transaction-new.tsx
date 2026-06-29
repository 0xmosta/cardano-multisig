import { Link, useNavigate, useParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Database, RefreshCw } from "lucide-react";
import { AppWindow } from "../components/ui/app-window";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { WalletConnectorBar } from "../components/ui/wallet-connector-bar";
import { installedBrowserWallets, type BrowserWalletApi, type BrowserWalletProvider } from "../lib/browser-wallets";
import {
  type AssetLine,
  type MultisigWallet as Wallet,
  type NativeScript,
  type Network,
  type SignatureRecord,
  type TxDraft,
  TX_STORAGE_KEY,
  STORAGE_KEY as WALLET_KEY,
  createId,
  expectedNetworkId,
  formatTargetNetwork,
  networkLabel,
  nowIso,
} from "../lib/multisig";

type CardanoWalletApi = BrowserWalletApi;

type WalletProvider = BrowserWalletProvider<BrowserWalletApi>;

type ConnectedWallet = {
  id: string;
  name: string;
  api: CardanoWalletApi;
  networkId: number;
  keyHash: string | null;
};

type AssetOption = {
  unit: string;
  label: string;
  quantity: string;
  outputCount?: number;
  decimals?: number;
  source: "treasury" | "default";
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
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
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

function signerMatchesWallet(wallet: Wallet, keyHash: string | null) {
  if (!keyHash) return false;
  return wallet.signers.some((signer) => signer.keyHash.toLowerCase() === keyHash.toLowerCase());
}

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
  const [assets, setAssets] = useState<AssetLine[]>([
    { id: createId("asset"), unit: "lovelace", label: "ADA", quantity: "2", decimals: 6 },
  ]);
  const [unsignedTxCbor, setUnsignedTxCbor] = useState("");
  const [buildInfo, setBuildInfo] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setWallets(readArray<Wallet>(WALLET_KEY));
    setProviders(installedBrowserWallets());
  }, []);

  const wallet = wallets.find((item) => item.id === walletId);
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

  useEffect(() => {
    if (!wallet) return;
    void refreshMultisigAssets(wallet);
  }, [wallet?.id]);

  async function refreshMultisigAssets(target = wallet) {
    if (!target) return;
    setAssetStatus("Loading multisig assets from the configured Cardano provider…");
    try {
      const result = await fetchMultisigAssets(target);
      const fetched = result.assets;
      setResolvedHandle(result.handle || null);
      setMultisigAssets(fetched.length ? fetched : [DEFAULT_ASSET]);
      const prefix = result.handle ? `Resolved ${handleLabel(result.handle)} · ` : "";
      setAssetStatus(
        fetched.length
          ? `${prefix}Loaded ${fetched.length} multisig asset${fetched.length === 1 ? "" : "s"} from ${result.source || "server"}.`
          : `${prefix}No spendable multisig assets found yet.`,
      );
    } catch (error) {
      setMultisigAssets([DEFAULT_ASSET]);
      setAssetStatus(error instanceof Error ? error.message : "Could not fetch multisig assets.");
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
              quantity: defaultDisplayAmount(chosen),
            }
          : asset,
      ),
    );
  }

  function updateAsset(id: string, patch: Partial<AssetLine>) {
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
      },
    ]);
  }

  async function connect(provider: WalletProvider) {
    if (connecting) return;
    setConnecting(provider.id);
    setStatus(`Open ${provider.name} and approve the connection...`);

    try {
      const api = await withTimeout(
        provider.enable(),
        12000,
        `${provider.name} did not answer. Unlock Eternl/reopen the wallet popup, then try again.`,
      );

      let networkId = -1;
      let keyHash: string | null = null;
      try {
        networkId = await withTimeout(api.getNetworkId(), 5000, "Network lookup timed out.");
      } catch {
        networkId = -1;
      }

      try {
        const used = await withTimeout(api.getUsedAddresses(), 5000, "Address lookup timed out.");
        const unused = used.length
          ? []
          : await withTimeout(api.getUnusedAddresses(), 5000, "Unused address lookup timed out.");
        const addressHex =
          used[0] || unused[0] || (await withTimeout(api.getChangeAddress(), 5000, "Change address lookup timed out."));
        keyHash = addressHex ? await keyHashFromAddress(addressHex) : null;
      } catch {
        keyHash = null;
      }

      setConnected({ id: provider.id, name: provider.name, api, networkId, keyHash });

      if (wallet && networkId >= 0 && networkId !== expectedNetworkId(wallet.network)) {
        setStatus(
          `Connected ${provider.name}, but it is on ${networkLabel(networkId)}. Switch it to ${formatTargetNetwork(wallet.network)} before signing.`,
        );
      } else if (wallet && keyHash && !signerMatchesWallet(wallet, keyHash)) {
        setStatus(
          `Connected ${provider.name}, but this key hash is not listed for the multisig policy. Use one of the required signer wallets.`,
        );
      } else if (keyHash) {
        setStatus(`Connected ${provider.name}. Signer key hash detected, so the signature can be matched automatically.`);
      } else {
        setStatus(
          `Connected ${provider.name}. Signing still works, but the signer key hash could not be verified automatically.`,
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not connect ${provider.name}.`);
    } finally {
      setConnecting(null);
    }
  }

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
    return { cbor: String(body.unsignedTxCbor || ""), assets: Array.isArray(body.assets) ? body.assets : txAssets };
  }

  async function createAndMaybeSign() {
    if (!wallet) return;

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
      setStatus(error instanceof Error ? error.message : "Could not build transaction.");
      return;
    }

    if (connected) {
      if (walletNetworkWarning) {
        setStatus(walletNetworkWarning);
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
            ? "Transaction built and signed by the connected wallet. The coordinator can share invite links immediately."
            : "Transaction built and signed, but the signer key hash could not be verified. The coordinator may need to confirm the signer manually.",
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Wallet refused to sign.");
        return;
      }
    } else {
      setStatus("Transaction built as pending. Next step: open the wallet page and copy the signer invite link.");
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

    const next = [tx, ...readArray<TxDraft>(TX_STORAGE_KEY)];
    writeArray(TX_STORAGE_KEY, next);
    navigate(`/wallets/${encodeURIComponent(wallet.id)}?draft=${encodeURIComponent(tx.id)}`);
  }

  if (!wallet) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100">
        <Link className="text-sm text-sky-300" to="/">
          ← Back
        </Link>
        <Card className="glass-panel mt-6">
          <CardContent className="p-8 text-slate-300">Wallet not found. Import or create it first.</CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link to={`/wallets/${encodeURIComponent(wallet.id)}`} className="inline-flex items-center gap-2 text-sm text-sky-300">
            <ArrowLeft className="size-4" /> Back to wallet
          </Link>
          <h1 className="mt-3 text-4xl font-semibold text-slate-50">Create transaction</h1>
          <p className="mt-2 max-w-3xl text-slate-400">
            Pick assets from the multisig wallet “{resolvedHandle ? handleLabel(resolvedHandle) : wallet.name}”. The server builds
            the unsigned transaction from multisig UTxOs; any connected browser wallet is used only for signing.
          </p>
        </div>

        <WalletConnectorBar
          className="w-full lg:max-w-xl"
          providers={providers}
          connected={connected ? { id: connected.id, name: connected.name, networkLabel: networkLabel(connected.networkId), keyHash: connected.keyHash } : null}
          connectingId={connecting}
          onConnect={(provider) => void connect(provider)}
          emptyLabel={providers.length ? "Connect only to sign" : "No browser wallet detected"}
        />
      </div>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <AppWindow title="New transaction" contentClassName="space-y-5">
          <div>
            <h2 className="text-xl font-semibold text-zinc-50">Transaction details</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Select assets, enter the recipient, then build the unsigned transaction. After saving, the wallet page becomes the
              coordinator view for copying invite links and tracking missing signers.
            </p>
          </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Recipient address</Label>
                <Input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="addr_test..." />
              </div>
            </div>

            <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  <Database className="mr-2 inline size-4" /> {assetStatus}
                </span>
                <Button variant="secondary" size="sm" onClick={() => refreshMultisigAssets()}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Assets</Label>
                <Button variant="secondary" size="sm" onClick={addAsset}>
                  Add asset
                </Button>
              </div>
              {assets.map((asset) => {
                const option = assetOptions.find((item) => item.unit === asset.unit);
                return (
                  <div key={asset.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_150px_40px]">
                    <select
                      className="h-10 rounded-md border border-input bg-transparent px-3 py-1 text-base text-slate-100 shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      value={asset.unit}
                      onChange={(event) => applyAsset(asset.id, event.target.value)}
                    >
                      {assetOptions.map((choice) => (
                        <option className="bg-slate-950 text-slate-100" key={choice.unit} value={choice.unit}>
                          {choice.label} · {formatRawQuantity(choice.quantity, choice.unit, choice.decimals)}
                        </option>
                      ))}
                    </select>
                    <Input
                      value={asset.quantity}
                      onChange={(event) => updateAsset(asset.id, { quantity: event.target.value })}
                      placeholder="Amount"
                    />
                    <Button variant="ghost" onClick={() => setAssets((current) => current.filter((item) => item.id !== asset.id))}>
                      ×
                    </Button>
                    {option?.quantity ? (
                      <div className="md:col-span-3 text-xs text-slate-500">Available: {formatRawQuantity(option.quantity, option.unit, option.decimals)}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="space-y-2">
              <Label>Coordinator note (optional)</Label>
              <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What signers should check before approving" />
            </div>

            <div className="space-y-2">
              <Label>Unsigned transaction CBOR</Label>
              <textarea
                className="min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm text-slate-100 shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={unsignedTxCbor}
                onChange={(event) => setUnsignedTxCbor(event.target.value)}
                placeholder="The server will fill this after Build transaction."
              />
              {buildInfo ? <div className="text-xs text-slate-400">{buildInfo}</div> : null}
            </div>
        </AppWindow>

        <div className="space-y-6">
          <Card className="glass-panel">
            <CardHeader>
              <CardTitle>What happens next</CardTitle>
              <CardDescription>Keep signers focused on one simple action at a time.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-300">
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                1. Build and save the transaction.
              </div>
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                2. On the wallet page, copy the signer invite link for this transaction and share it privately only; it carries unsigned transaction details in the URL fragment.
              </div>
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                3. Each signer opens the link, connects a wallet, signs, and sends the witness package back.
              </div>
              <div className="rounded-lg border border-border bg-slate-950/60 p-3">
                4. Import returned witness packages on the wallet page until the missing signer list is empty.
              </div>
            </CardContent>
          </Card>

          {walletNetworkWarning ? (
            <Card className="border-amber-400/30 bg-amber-400/10">
              <CardContent className="flex gap-3 p-4 text-sm text-amber-100">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div>{walletNetworkWarning}</div>
              </CardContent>
            </Card>
          ) : null}

          <Button className="w-full" onClick={() => void createAndMaybeSign()}>
            Build and save transaction
          </Button>
        </div>
      </section>

      {status ? <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-sm text-sky-100">{status}</div> : null}
    </main>
  );
}
