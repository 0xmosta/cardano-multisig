import { ArrowRight, CheckCircle2, Clock, Cloud, Loader2, Plus, RefreshCw, Search, ShieldCheck, Users } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/transactions";
import { AccountSyncPanel } from "../components/account-sync-panel";
import { useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DataTable } from "../components/ui/data-table";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import {
  type TxDraft,
  pendingSignatureCount,
  signatureCount,
} from "../lib/multisig";
import {
  RELAY_SYNC_INTERVAL_MS,
  applyRelayRoomToDraft,
  hasActiveRelayRoom,
  relayDraftFingerprint,
  type RelayRoomSessionResponse,
  type RelayRoomViewResponse,
} from "../lib/relay-room";
import { cn } from "../lib/utils";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Transactions · Cardano Multisig" }];
}

function transactionState(tx: TxDraft) {
  if (tx.txHash || tx.relayRoom?.status === "submitted" || tx.status === "succeeded") return "submitted";
  if (pendingSignatureCount(tx) <= 0) return "ready";
  return "pending";
}

function statusBadgeVariant(state: ReturnType<typeof transactionState>) {
  if (state === "submitted") return "default" as const;
  if (state === "ready") return "secondary" as const;
  return "outline" as const;
}

function walletHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}` : "/wallets";
}

function newTransactionHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}/transactions/new` : "/wallets";
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

function TransactionMobileCard({ tx }: { tx: TxDraft }) {
  const signed = signatureCount(tx);
  const missing = pendingSignatureCount(tx);
  const state = transactionState(tx);
  return (
    <article className="min-w-0 rounded-lg border border-border bg-black/20 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar label={tx.walletName} tone={missing ? "primary" : "success"} />
        <div className="min-w-0 flex-1">
          <div className="break-words font-semibold text-foreground">{tx.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{tx.walletName}</span>
            <span>·</span>
            <span>{tx.network}</span>
            <Badge variant={statusBadgeVariant(state)}>{state}</Badge>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-md border border-white/8 bg-white/[0.025] p-3">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Required signatures</span>
          <span className="font-medium text-foreground">{signed}/{tx.requiredSignatures}</span>
        </div>
        <Progress className="mt-2" value={signed} max={tx.requiredSignatures} />
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          {state === "submitted" ? <CheckCircle2 className="size-3" /> : missing ? <Clock className="size-3" /> : <ShieldCheck className="size-3" />}
          {state === "submitted" ? "Submitted" : missing ? `${missing} more required` : "Ready to submit"}
        </div>
      </div>

      <div className="mt-3 break-all rounded-md border border-white/8 bg-black/20 p-3 text-xs text-muted-foreground">
        {tx.txHash ? `Transaction ${tx.txHash}` : tx.recipient || "No recipient saved"}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button asChild className="min-w-0 px-2">
          <Link to={walletHref(tx)}>
            Wallet <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button asChild variant="secondary" className="min-w-0 px-2">
          <Link to={newTransactionHref(tx)}>
            <Plus className="size-4" /> New
          </Link>
        </Button>
      </div>
    </article>
  );
}

export default function TransactionsRoute() {
  const { account, accountState, refreshServerState, saveServerState } = useAppShell();
  const [transactions, setTransactions] = useState<TxDraft[]>([]);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const transactionsRef = useRef<TxDraft[]>([]);
  const accountStateRef = useRef(accountState);
  const relaySyncInFlightRef = useRef(false);

  transactionsRef.current = transactions;
  accountStateRef.current = accountState;

  const relaySyncKey = useMemo(
    () =>
      transactions
        .filter(hasActiveRelayRoom)
        .map((tx) => `${tx.id}:${tx.relayRoom?.roomId}`)
        .sort()
        .join("|"),
    [transactions],
  );

  async function refreshRelayRooms(source = transactionsRef.current) {
    if (relaySyncInFlightRef.current) return false;
    const relayTransactions = source.filter(hasActiveRelayRoom);
    if (!relayTransactions.length) return false;
    relaySyncInFlightRef.current = true;
    setSyncing(true);
    try {
      const updates = await Promise.all(
        relayTransactions.map(async (tx) => {
          const token = tx.relayRoom?.coordinatorToken || relayTokenFromInviteUrl(tx.relayRoom?.sharedInviteUrl || "");
          const response = await fetch("/api/cardano/relay-room", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(token ? { intent: "session", token } : { intent: "view", roomId: tx.relayRoom!.roomId }),
          });
          const body = (await response.json()) as RelayRoomSessionResponse | RelayRoomViewResponse | { ok: false; error?: string };
          if (!response.ok || !body.ok || (body.role !== "coordinator" && body.role !== "viewer")) return null;
          return { txId: tx.id, room: body.room };
        }),
      );
      const byId = new Map(updates.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.txId, item.room]));
      if (!byId.size) return false;
      const applyRooms = (current: TxDraft[]) =>
        current.map((tx) => {
          const room = byId.get(tx.id);
          if (!room) return tx;
          const next = applyRelayRoomToDraft(tx, room);
          return relayDraftFingerprint(next) === relayDraftFingerprint(tx) ? tx : next;
        });
      const next = applyRooms(source);
      if (!next.some((tx, index) => tx !== source[index])) return false;
      setTransactions((current) => applyRooms(current));
      const currentAccountState = accountStateRef.current;
      if (account.authenticated && currentAccountState) {
        await saveServerState({ wallets: currentAccountState.wallets, transactions: applyRooms(currentAccountState.transactions) });
      }
      return true;
    } finally {
      relaySyncInFlightRef.current = false;
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (account.authenticated) {
      if (accountState) {
        setLoading(false);
        setLoadError("");
        setTransactions(accountState.transactions);
        return;
      }
      let cancelled = false;
      setLoading(true);
      setLoadError("");
      refreshServerState()
        .then((state) => {
          if (!cancelled && state) {
            setTransactions(state.transactions);
          }
        })
        .catch((error) => {
          if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load server transactions.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    setLoading(false);
    setLoadError("");
    setTransactions([]);
  }, [account.authenticated, accountState]);

  useEffect(() => {
    if (!account.authenticated || !accountState || !relaySyncKey) return;
    let cancelled = false;
    const sync = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      await refreshRelayRooms(transactionsRef.current).catch(() => undefined);
    };
    void sync();
    const interval = window.setInterval(() => {
      void sync();
    }, RELAY_SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [account.authenticated, Boolean(accountState), relaySyncKey]);

  const visibleTransactions = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return transactions;
    return transactions.filter((tx) =>
      [
        tx.title,
        tx.walletName,
        tx.recipient,
        tx.network,
        transactionState(tx),
        tx.txHash,
        ...(tx.signerKeyHashes || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(value),
    );
  }, [query, transactions]);

  const readyCount = transactions.filter((tx) => transactionState(tx) === "ready").length;
  const submittedCount = transactions.filter((tx) => transactionState(tx) === "submitted").length;
  const columns = useMemo<ColumnDef<TxDraft>[]>(
    () => [
      {
        header: "Transaction",
        cell: ({ row }) => {
          const tx = row.original;
          return (
            <div className="flex min-w-0 items-start gap-3">
              <Avatar label={tx.walletName} tone={pendingSignatureCount(tx) ? "primary" : "success"} />
              <div className="min-w-0">
                <div className="break-words font-semibold text-foreground">{tx.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{tx.walletName} · {tx.network}</div>
                <div className="mt-2 line-clamp-1 max-w-md break-all text-xs text-muted-foreground">{tx.recipient || "No recipient saved"}</div>
              </div>
            </div>
          );
        },
      },
      {
        header: "Signatures",
        cell: ({ row }) => {
          const tx = row.original;
          const signed = signatureCount(tx);
          const missing = pendingSignatureCount(tx);
          const state = transactionState(tx);
          return (
            <div className="min-w-36 space-y-2">
              <Badge variant={state === "submitted" ? "default" : missing ? "secondary" : "outline"}>
                <Users className="size-3" /> {signed}/{tx.requiredSignatures}
              </Badge>
              <Progress value={signed} max={tx.requiredSignatures} />
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {state === "submitted" ? <CheckCircle2 className="size-3" /> : missing ? <Clock className="size-3" /> : <ShieldCheck className="size-3" />}
                {state === "submitted" ? "submitted" : missing ? `${missing} more` : "ready"}
              </div>
            </div>
          );
        },
      },
      {
        header: "Status",
        cell: ({ row }) => {
          const tx = row.original;
          const state = transactionState(tx);
          return (
            <div className="space-y-1">
              <Badge variant={statusBadgeVariant(state)}>{state}</Badge>
              {tx.txHash ? <div className="max-w-40 truncate font-mono text-xs text-muted-foreground">{tx.txHash}</div> : null}
            </div>
          );
        },
      },
      {
        id: "actions",
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => {
          const tx = row.original;
          return (
            <div className="flex justify-end gap-2">
              <Button asChild size="sm">
                <Link to={walletHref(tx)}>
                  Open wallet <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button asChild size="sm" variant="secondary">
                <Link to={newTransactionHref(tx)}>
                  <Plus className="size-4" /> New
                </Link>
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-zinc-50 sm:text-3xl">Transactions</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Track pending signature rooms, open wallet coordinators, and continue transaction work from {account ? "server-synced account state" : "this browser"}.</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Badge variant="secondary">
            {transactions.length} room{transactions.length === 1 ? "" : "s"}
          </Badge>
          {readyCount ? <Badge className="bg-emerald-300 text-emerald-950">{readyCount} ready</Badge> : null}
          {submittedCount ? <Badge variant="secondary">{submittedCount} submitted</Badge> : null}
          <Button type="button" size="sm" variant="secondary" className="max-sm:flex-1" onClick={() => void refreshRelayRooms()} disabled={syncing}>
            <RefreshCw className={cn("size-4", syncing ? "animate-spin" : "")} /> Sync
          </Button>
        </div>
      </div>

      <AccountSyncPanel />

      <AppWindow title="Transaction rooms" contentClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/8 p-4 sm:p-5">
          <div className="relative min-w-full flex-1 sm:min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transaction, wallet, recipient, signer..."
              className="pl-9"
            />
          </div>
          <Badge variant="secondary" className="max-sm:w-full max-sm:justify-center">
            <span>{visibleTransactions.length}</span>
            <span>shown</span>
          </Badge>
        </div>
        <div className="p-3 sm:p-5">
          {loading ? (
            <Empty>
              <EmptyHeader>
                <Loader2 className="size-5 animate-spin text-sky-200" />
                <EmptyTitle>Loading server transactions</EmptyTitle>
                <EmptyDescription>Fetching transaction rooms for your authenticated account.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : loadError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Could not load transactions</EmptyTitle>
                <EmptyDescription>{loadError}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="secondary" onClick={() => void refreshServerState()}>
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : transactions.length ? (
            <DataTable
              columns={columns}
              data={visibleTransactions}
              emptyLabel="No transaction matches."
              renderMobileRow={(tx) => <TransactionMobileCard tx={tx} />}
            />
          ) : (
            <Empty>
              <EmptyHeader>
                {account ? <Cloud className="size-5 text-sky-200" /> : <Clock className="size-5 text-muted-foreground" />}
                <EmptyTitle>{account ? "No server transaction rooms yet" : "Sign in to load transactions"}</EmptyTitle>
                <EmptyDescription>{account ? "Create a transaction from a synced wallet to open a coordinator room." : "Use the account menu to authenticate; PostgreSQL is the source of truth for transaction rooms."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </AppWindow>
    </div>
  );
}
