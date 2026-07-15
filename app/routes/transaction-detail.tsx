import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Progress } from "../components/ui/progress";
import {
  type AssetLine,
  type MultisigWallet,
  type TxDraft,
  hasMatchedSignature,
  normalizeKeyHash,
  optionalSignerKeyHashes,
  pendingSignatureCount,
  signatureCount,
} from "../lib/multisig";
import {
  RELAY_SYNC_INTERVAL_MS,
  applyRelayRoomToDraft,
  hasActiveRelayRoom,
  type RelayRoomSessionResponse,
  type RelayRoomViewResponse,
} from "../lib/relay-room";
import { cn, userFacingError } from "../lib/utils";

type TransactionState = "pending" | "ready" | "submitted";
type RelaySync = { status: "idle" | "syncing" | "synced" | "failed"; at?: string; error?: string };

export function meta() {
  return [{ title: "Transaction · Cardano Multisig" }];
}

function transactionState(tx: TxDraft): TransactionState {
  if (tx.txHash || tx.relayRoom?.status === "submitted" || tx.status === "succeeded") return "submitted";
  return pendingSignatureCount(tx) <= 0 ? "ready" : "pending";
}

function stateLabel(state: TransactionState) {
  if (state === "submitted") return "Submitted";
  if (state === "ready") return "Ready to submit";
  return "Awaiting signatures";
}

function stateDescription(state: TransactionState, missing: number) {
  if (state === "submitted") return "The transaction was submitted to the Cardano network.";
  if (state === "ready") return "The required signature threshold has been reached.";
  return `${missing} more signature${missing === 1 ? " is" : "s are"} required.`;
}

function walletHref(tx: TxDraft, focusTransaction = false) {
  if (!tx.walletId) return "/wallets";
  const base = `/wallets/${encodeURIComponent(tx.walletId)}`;
  return focusTransaction ? `${base}?draft=${encodeURIComponent(tx.id)}` : base;
}

function newTransactionHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}/transactions/new` : "/wallets";
}

function relayTokenFromInviteUrl(inviteUrl: string) {
  try {
    const parsed = new URL(inviteUrl, window.location.origin);
    return new URLSearchParams(parsed.hash.replace(/^#/, "")).get("r") || "";
  } catch {
    return inviteUrl.split("#r=")[1]?.trim() || "";
  }
}

function relativeTime(value?: string) {
  if (!value) return "never";
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return "unknown";
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

function formatQuantity(asset: AssetLine) {
  const decimals = asset.decimals ?? (asset.unit === "lovelace" ? 6 : 0);
  const quantity = BigInt(asset.quantity || "0");
  if (!decimals) return quantity.toLocaleString();
  const scale = 10n ** BigInt(decimals);
  const whole = quantity / scale;
  const fraction = quantity % scale;
  const fractionText = fraction ? `.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}` : "";
  return `${whole.toLocaleString()}${fractionText}`;
}

function explorerTxUrl(network: string, txHash: string) {
  const subdomain = network === "mainnet" ? "" : `${network}.`;
  return `https://${subdomain}cardanoscan.io/transaction/${txHash}`;
}

function signerLabel(wallet: MultisigWallet | undefined, keyHash: string, index: number) {
  return wallet?.signers.find((signer) => normalizeKeyHash(signer.keyHash) === normalizeKeyHash(keyHash))?.label || `Signer ${index + 1}`;
}

export default function TransactionDetailRoute() {
  const { transactionId = "" } = useParams();
  const { account, accountState, refreshServerState } = useAppShell();
  const [transaction, setTransaction] = useState<TxDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [relaySync, setRelaySync] = useState<RelaySync>({ status: "idle" });
  const relaySyncInFlightRef = useRef(false);

  useEffect(() => {
    const decodedId = transactionId;
    if (accountState) {
      setTransaction(accountState.transactions.find((tx) => tx.id === decodedId) || null);
      setLoading(false);
      return;
    }
    if (!account.authenticated) {
      setTransaction(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    refreshServerState()
      .then((snapshot) => {
        if (!cancelled) setTransaction(snapshot?.transactions.find((tx) => tx.id === decodedId) || null);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(userFacingError(error, "We could not load this transaction."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.authenticated, accountState, transactionId]);

  const wallet = useMemo(
    () => accountState?.wallets.find((item) => item.id === transaction?.walletId || item.name === transaction?.walletName),
    [accountState?.wallets, transaction?.walletId, transaction?.walletName],
  );

  async function refreshRelay() {
    if (!transaction?.relayRoom?.roomId || relaySyncInFlightRef.current) return;
    relaySyncInFlightRef.current = true;
    setRelaySync({ status: "syncing", at: new Date().toISOString() });
    try {
      const token = transaction.relayRoom.coordinatorToken || relayTokenFromInviteUrl(transaction.relayRoom.sharedInviteUrl || "");
      const response = await fetch("/api/cardano/relay-room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(token ? { intent: "session", token } : { intent: "view", roomId: transaction.relayRoom.roomId }),
      });
      const body = (await response.json()) as RelayRoomSessionResponse | RelayRoomViewResponse | { ok: false; error?: string };
      if (!response.ok || !body.ok) throw new Error(("error" in body && body.error) || "Could not load relay state.");
      setTransaction((current) => (current ? applyRelayRoomToDraft(current, body.room) : current));
      setRelaySync({ status: "synced", at: new Date().toISOString() });
    } catch (error) {
      setRelaySync({ status: "failed", at: new Date().toISOString(), error: userFacingError(error, "Signature progress could not be refreshed.") });
    } finally {
      relaySyncInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!transaction || !hasActiveRelayRoom(transaction)) return;
    let cancelled = false;
    const sync = () => {
      if (!cancelled && document.visibilityState !== "hidden") void refreshRelay();
    };
    sync();
    const interval = window.setInterval(sync, RELAY_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [transaction?.id, transaction?.relayRoom?.roomId]);

  if (loading) {
    return (
      <Empty>
        <EmptyHeader>
          <Loader2 className="size-5 animate-spin text-sky-200" />
          <EmptyTitle>Loading transaction</EmptyTitle>
          <EmptyDescription>Loading the saved transaction details.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!transaction) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{loadError ? "Could not load transaction" : "Transaction not found"}</EmptyTitle>
          <EmptyDescription>{loadError || (account.authenticated ? "This transaction is not part of the signed-in account." : "Sign in with your wallet to open this transaction.")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="secondary"><Link to="/transactions"><ArrowLeft className="size-4" /> Back to transactions</Link></Button>
        </EmptyContent>
      </Empty>
    );
  }

  const state = transactionState(transaction);
  const signed = signatureCount(transaction);
  const missing = pendingSignatureCount(transaction);
  const optional = new Set(optionalSignerKeyHashes(transaction).map(normalizeKeyHash));
  const assets = transaction.assets?.length
    ? transaction.assets
    : [{ id: "ada", unit: "lovelace", label: "ADA", quantity: transaction.lovelace || "0", decimals: 6 }];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button asChild variant="ghost" className="-ml-3"><Link to="/transactions"><ArrowLeft className="size-4" /> Transactions</Link></Button>
        {transaction.relayRoom && relaySync.status === "failed" ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => void refreshRelay()}>
            <RefreshCw className="size-4" /> Try again
          </Button>
        ) : null}
      </div>

      <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
        <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <Avatar label={transaction.title} tone={state === "pending" ? "primary" : "success"} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="break-words text-2xl font-semibold text-zinc-50 sm:text-3xl">{transaction.title}</h1>
                <Badge variant={state === "submitted" ? "default" : state === "ready" ? "secondary" : "outline"}>{stateLabel(state)}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                <span>{transaction.walletName}</span><span>·</span><span>{transaction.network}</span>
              </div>
            </div>
          </div>
          <Button asChild className="w-full sm:w-auto">
            <Link to={walletHref(transaction, true)}>Manage signatures <ArrowRight className="size-4" /></Link>
          </Button>
        </div>
      </section>

      {relaySync.error ? <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200">{relaySync.error}</div> : null}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <AppWindow title="Transaction status" contentClassName="space-y-5">
            <div className="flex items-start gap-3">
              {state === "submitted" ? <CheckCircle2 className="mt-0.5 size-5 text-emerald-300" /> : state === "ready" ? <ShieldCheck className="mt-0.5 size-5 text-emerald-300" /> : <Clock3 className="mt-0.5 size-5 text-amber-300" />}
              <div><div className="font-semibold text-zinc-50">{stateLabel(state)}</div><div className="mt-1 text-sm text-zinc-400">{stateDescription(state, missing)}</div></div>
            </div>
            <div>
              <div className="flex items-center justify-between text-sm text-zinc-400"><span>Required signatures</span><span className="font-medium text-zinc-100">{signed}/{transaction.requiredSignatures}</span></div>
              <Progress className="mt-2" value={signed} max={transaction.requiredSignatures} />
            </div>
          </AppWindow>

          <AppWindow title="Transfer details" contentClassName="space-y-5">
            <div><div className="text-xs uppercase tracking-wide text-zinc-500">Recipient</div><div className="mt-2 break-all rounded-lg border border-white/8 bg-black/20 p-3 font-mono text-sm text-zinc-200">{transaction.recipient || "No recipient saved"}</div></div>
            <div><div className="text-xs uppercase tracking-wide text-zinc-500">Assets</div><div className="mt-2 grid gap-2 sm:grid-cols-2">{assets.map((asset) => <div key={asset.id} className="rounded-lg border border-white/8 bg-black/20 p-3"><div className="break-words font-medium text-zinc-100">{asset.label || asset.unit}</div><div className="mt-1 break-all text-sm text-zinc-400">{formatQuantity(asset)}{asset.unit === "lovelace" ? " ADA" : ""}</div></div>)}</div></div>
            {transaction.note ? <div><div className="text-xs uppercase tracking-wide text-zinc-500">Note</div><div className="mt-2 whitespace-pre-wrap rounded-lg border border-white/8 bg-black/20 p-3 text-sm text-zinc-300">{transaction.note}</div></div> : null}
          </AppWindow>

          <AppWindow title="Signers" contentClassName="space-y-2">
            {transaction.signerKeyHashes.map((keyHash, index) => {
              const hasSigned = hasMatchedSignature(transaction, keyHash);
              return <div key={keyHash} className={cn("flex min-w-0 items-center justify-between gap-3 rounded-lg border p-3", hasSigned ? "border-emerald-400/30 bg-emerald-400/10" : "border-white/8 bg-black/20")}><div className="flex min-w-0 items-center gap-3"><Avatar label={signerLabel(wallet, keyHash, index)} tone={hasSigned ? "success" : "muted"} /><div className="min-w-0"><div className="font-medium text-zinc-100">{signerLabel(wallet, keyHash, index)}</div><div className="truncate font-mono text-xs text-zinc-500" title={keyHash}>{keyHash}</div></div></div><div className="flex shrink-0 items-center gap-2">{optional.has(normalizeKeyHash(keyHash)) && !hasSigned ? <Badge variant="outline">optional</Badge> : null}<Badge variant={hasSigned ? "default" : "outline"}>{hasSigned ? "signed" : "waiting"}</Badge>{hasSigned ? <Check className="size-4 text-emerald-300" /> : null}</div></div>;
            })}
          </AppWindow>

          {transaction.txHash ? <Card><CardHeader><CardTitle>On-chain transaction</CardTitle><CardDescription>The submitted transaction identifier.</CardDescription></CardHeader><CardContent><div className="flex min-w-0 flex-col gap-3 sm:flex-row"><code className="min-w-0 flex-1 break-all rounded-lg border border-white/8 bg-black/20 p-3 text-xs text-zinc-300">{transaction.txHash}</code><Button asChild variant="secondary"><a href={explorerTxUrl(transaction.network, transaction.txHash)} target="_blank" rel="noreferrer">Explorer <ExternalLink className="size-4" /></a></Button></div></CardContent></Card> : null}
        </div>

        <aside className="min-w-0 space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader><CardTitle>Next action</CardTitle><CardDescription>{state === "pending" ? "Open the wallet to sign or share this request with others." : state === "ready" ? "All required signatures are present; submission can complete automatically." : "This transaction is complete. You can review the wallet or create another one."}</CardDescription></CardHeader>
            <CardContent className="space-y-2">
              <Button asChild className="w-full"><Link to={walletHref(transaction, true)}><ShieldCheck className="size-4" /> Manage signatures</Link></Button>
              <Button asChild variant="secondary" className="w-full"><Link to={walletHref(transaction)}><WalletCards className="size-4" /> View wallet</Link></Button>
              <Button asChild variant="outline" className="w-full"><Link to={newTransactionHref(transaction)}>New transaction <ArrowRight className="size-4" /></Link></Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Reference</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div><div className="text-zinc-500">Created</div><div className="mt-1 text-zinc-200">{new Date(transaction.createdAt).toLocaleString()}</div></div>
              <div><div className="text-zinc-500">Transaction ID</div><div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs text-zinc-300">{transaction.id}</code><Button type="button" size="icon-sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(transaction.id); toast.success("Transaction ID copied"); }}><Copy className="size-4" /></Button></div></div>
              {transaction.relayRoom ? <div><div className="text-zinc-500">Signature progress updated</div><div className="mt-1 text-zinc-200">{relativeTime(relaySync.at || transaction.relayRoom.lastSyncAt)}</div></div> : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
