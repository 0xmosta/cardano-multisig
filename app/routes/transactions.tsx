import { Archive, ArrowRight, CheckCircle2, ChevronRight, Clock, Cloud, Copy, CopyPlus, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck, Users } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
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
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  type TxDraft,
  hasMatchedSignature,
  normalizeKeyHash,
  pendingSignatureCount,
  signatureCount,
  sortTransactionDraftsNewestFirst,
} from "../lib/multisig";
import {
  RELAY_SYNC_INTERVAL_MS,
  applyRelayRoomToDraft,
  hasActiveRelayRoom,
  relayDraftFingerprint,
  type RelayRoomSessionResponse,
  type RelayRoomViewResponse,
} from "../lib/relay-room";
import { cn, userFacingError } from "../lib/utils";
import { toast } from "sonner";

type InboxFilter = "action" | "all" | "needs-you" | "waiting" | "ready" | "completed" | "archived";
type SignerAttention = "needs-you" | "signed" | "not-signer" | "not-connected";

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

function transactionStateLabel(state: ReturnType<typeof transactionState>) {
  if (state === "submitted") return "Completed";
  if (state === "ready") return "Ready";
  return "Waiting";
}

function connectedSignerAttention(tx: TxDraft, connectedKeyHash?: string | null): SignerAttention {
  const connectedSigner = normalizeKeyHash(connectedKeyHash || "");
  if (!connectedSigner) return "not-connected";
  if (!tx.signerKeyHashes.some((keyHash) => normalizeKeyHash(keyHash) === connectedSigner)) return "not-signer";
  return hasMatchedSignature(tx, connectedSigner) ? "signed" : "needs-you";
}

function transactionInboxState(tx: TxDraft, connectedKeyHash?: string | null): "needs-you" | "waiting" | "ready" | "completed" {
  const state = transactionState(tx);
  if (state === "submitted") return "completed";
  if (state === "ready") return "ready";
  if (connectedSignerAttention(tx, connectedKeyHash) === "needs-you") return "needs-you";
  return "waiting";
}

function matchesInboxFilter(tx: TxDraft, filter: InboxFilter, connectedKeyHash?: string | null) {
  if (filter === "archived") return Boolean(tx.archivedAt);
  if (tx.archivedAt) return false;
  if (filter === "all") return true;
  const state = transactionInboxState(tx, connectedKeyHash);
  if (filter === "action") return state === "needs-you" || state === "ready";
  return state === filter;
}

function transactionHref(tx: TxDraft) {
  return `/transactions/${encodeURIComponent(tx.id)}`;
}

function manageTransactionHref(tx: TxDraft) {
  return tx.walletId
    ? `/wallets/${encodeURIComponent(tx.walletId)}?draft=${encodeURIComponent(tx.id)}`
    : transactionHref(tx);
}

function newSimilarHref(tx: TxDraft) {
  return tx.walletId
    ? `/wallets/${encodeURIComponent(tx.walletId)}/transactions/new?from=${encodeURIComponent(tx.id)}`
    : transactionHref(tx);
}

function primaryTransactionAction(tx: TxDraft, connectedKeyHash?: string | null) {
  const state = transactionInboxState(tx, connectedKeyHash);
  if (state === "needs-you") return { label: "Sign", href: manageTransactionHref(tx), icon: ShieldCheck };
  if (state === "ready") return { label: "Submit", href: manageTransactionHref(tx), icon: ArrowRight };
  return { label: "View", href: transactionHref(tx), icon: ChevronRight };
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

function TransactionMobileCard({
  tx,
  connectedKeyHash,
  busy,
  onCopyLink,
  onToggleArchive,
}: {
  tx: TxDraft;
  connectedKeyHash?: string | null;
  busy: boolean;
  onCopyLink: (tx: TxDraft) => void;
  onToggleArchive: (tx: TxDraft) => void;
}) {
  const signed = signatureCount(tx);
  const missing = pendingSignatureCount(tx);
  const state = transactionState(tx);
  const signerAttention = connectedSignerAttention(tx, connectedKeyHash);
  const primary = primaryTransactionAction(tx, connectedKeyHash);
  const PrimaryIcon = primary.icon;
  return (
    <article className="min-w-0 rounded-xl border border-border bg-black/20 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar label={tx.walletName} tone={missing ? "primary" : "success"} />
        <div className="min-w-0 flex-1">
          <Link to={transactionHref(tx)} className="break-words font-semibold text-foreground underline-offset-4 hover:text-sky-200 hover:underline">{tx.title}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{tx.walletName}</span>
            <span>·</span>
            <span>{tx.network}</span>
            <Badge variant={statusBadgeVariant(state)}>{transactionStateLabel(state)}</Badge>
            {signerAttention === "needs-you" ? <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-200">Your signature</Badge> : null}
            {signerAttention === "signed" ? <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">You signed</Badge> : null}
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

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-white/8 pt-3">
        <Button asChild size="sm" className="col-span-2">
          <Link to={primary.href}><PrimaryIcon className="size-4" /> {primary.label}</Link>
        </Button>
        {tx.relayRoom?.sharedInviteUrl && state !== "submitted" ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onCopyLink(tx)}><Copy className="size-4" /> Copy link</Button>
        ) : tx.walletId ? (
          <Button asChild size="sm" variant="secondary"><Link to={newSimilarHref(tx)}><CopyPlus className="size-4" /> Similar</Link></Button>
        ) : <span />}
        {state === "submitted" || tx.archivedAt ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onToggleArchive(tx)}>
            {tx.archivedAt ? <RotateCcw className="size-4" /> : <Archive className="size-4" />} {tx.archivedAt ? "Restore" : "Archive"}
          </Button>
        ) : tx.walletId && tx.relayRoom?.sharedInviteUrl ? (
          <Button asChild size="sm" variant="ghost"><Link to={newSimilarHref(tx)}><CopyPlus className="size-4" /> Similar</Link></Button>
        ) : null}
      </div>
    </article>
  );
}

export default function TransactionsRoute() {
  const navigate = useNavigate();
  const { account, accountState, connected, refreshServerState, saveServerState } = useAppShell();
  const [transactions, setTransactions] = useState<TxDraft[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("action");
  const [syncing, setSyncing] = useState(false);
  const [mutatingId, setMutatingId] = useState("");
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
          if (
            !response.ok ||
            !body.ok ||
            (body.role !== "coordinator" && body.role !== "signer" && body.role !== "viewer")
          ) {
            return null;
          }
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
          if (!cancelled) setLoadError(userFacingError(error, "We could not load your transactions."));
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

  async function copySignerLink(tx: TxDraft) {
    const link = tx.relayRoom?.sharedInviteUrl;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Signer link copied", { description: "Share it privately with the transaction signers." });
    } catch {
      toast.error("Could not copy signer link");
    }
  }

  async function toggleArchived(tx: TxDraft) {
    if (!account.authenticated || !accountStateRef.current || mutatingId) return;
    const previous = transactionsRef.current;
    const archivedAt = tx.archivedAt ? undefined : new Date().toISOString();
    const next = previous.map((item) =>
      item.id === tx.id
        ? { ...item, archivedAt, updatedAt: new Date().toISOString() }
        : item,
    );
    setMutatingId(tx.id);
    setTransactions(next);
    try {
      await saveServerState({ wallets: accountStateRef.current.wallets, transactions: next });
      toast.success(archivedAt ? "Transaction archived" : "Transaction restored");
    } catch (error) {
      setTransactions(previous);
      toast.error(archivedAt ? "Could not archive transaction" : "Could not restore transaction", {
        description: userFacingError(error, "Try again in a moment."),
      });
    } finally {
      setMutatingId("");
    }
  }

  const visibleTransactions = useMemo(() => {
    const value = query.trim().toLowerCase();
    const matchingQuery = value
      ? transactions.filter((tx) =>
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
        )
      : transactions;
    const matchingInbox = matchingQuery.filter((tx) => matchesInboxFilter(tx, filter, connected?.keyHash));
    return sortTransactionDraftsNewestFirst(matchingInbox);
  }, [connected?.keyHash, filter, query, transactions]);

  const inboxCounts = useMemo(() => {
    const counts: Record<InboxFilter, number> = { action: 0, all: 0, "needs-you": 0, waiting: 0, ready: 0, completed: 0, archived: 0 };
    for (const tx of transactions) {
      if (tx.archivedAt) {
        counts.archived += 1;
        continue;
      }
      counts.all += 1;
      const state = transactionInboxState(tx, connected?.keyHash);
      counts[state] += 1;
      if (state === "needs-you" || state === "ready") counts.action += 1;
    }
    return counts;
  }, [connected?.keyHash, transactions]);

  const readyCount = transactions.filter((tx) => !tx.archivedAt && transactionState(tx) === "ready").length;
  const submittedCount = transactions.filter((tx) => !tx.archivedAt && transactionState(tx) === "submitted").length;
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
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-semibold text-foreground">{tx.title}</span>
                  {connectedSignerAttention(tx, connected?.keyHash) === "needs-you" ? <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-200">Your signature</Badge> : null}
                  {connectedSignerAttention(tx, connected?.keyHash) === "signed" ? <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">You signed</Badge> : null}
                </div>
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
              <Badge variant={statusBadgeVariant(state)}>{transactionStateLabel(state)}</Badge>
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
          const primary = primaryTransactionAction(tx, connected?.keyHash);
          const PrimaryIcon = primary.icon;
          const state = transactionState(tx);
          return (
            <div className="flex justify-end gap-2">
              <Button asChild size="sm">
                <Link to={primary.href}><PrimaryIcon className="size-4" /> {primary.label}</Link>
              </Button>
              {tx.relayRoom?.sharedInviteUrl && state !== "submitted" ? (
                <Button type="button" size="icon-sm" variant="secondary" title="Copy signer link" aria-label={`Copy signer link for ${tx.title}`} onClick={() => void copySignerLink(tx)}><Copy className="size-4" /></Button>
              ) : null}
              {tx.walletId ? (
                <Button asChild size="icon-sm" variant="ghost" title="Create a similar transaction"><Link to={newSimilarHref(tx)} aria-label={`Create a transaction similar to ${tx.title}`}><CopyPlus className="size-4" /></Link></Button>
              ) : null}
              {state === "submitted" || tx.archivedAt ? (
                <Button type="button" size="icon-sm" variant="ghost" disabled={mutatingId === tx.id} title={tx.archivedAt ? "Restore transaction" : "Archive completed transaction"} aria-label={`${tx.archivedAt ? "Restore" : "Archive"} ${tx.title}`} onClick={() => void toggleArchived(tx)}>
                  {tx.archivedAt ? <RotateCcw className="size-4" /> : <Archive className="size-4" />}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [connected?.keyHash, mutatingId],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-zinc-50 sm:text-3xl">Transactions</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">See what needs your attention, what is waiting for others, and what is complete.</p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Badge variant="secondary">{inboxCounts.all} active</Badge>
          {readyCount ? <Badge className="bg-emerald-300 text-emerald-950">{readyCount} ready</Badge> : null}
          {submittedCount ? <Badge variant="secondary">{submittedCount} completed</Badge> : null}
          <Button type="button" size="sm" variant="secondary" className="max-sm:flex-1" onClick={() => void refreshRelayRooms()} disabled={syncing}>
            <RefreshCw className={cn("size-4", syncing ? "animate-spin" : "")} /> Refresh
          </Button>
        </div>
      </div>

      <AccountSyncPanel />

      <AppWindow title="Transactions" contentClassName="p-0">
        <div className="space-y-3 border-b border-white/8 p-4 sm:p-5">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as InboxFilter)} className="min-w-0">
            <div className="overflow-x-auto pb-1">
              <TabsList className="h-auto min-w-max">
                {([
                  ["action", "Action needed"],
                  ["all", "All"],
                  ["needs-you", "Needs you"],
                  ["waiting", "Waiting"],
                  ["ready", "Ready"],
                  ["completed", "Completed"],
                  ["archived", "Archived"],
                ] as Array<[InboxFilter, string]>).map(([value, label]) => (
                  <TabsTrigger key={value} value={value}>
                    {label} <span className="text-[11px] opacity-70">{inboxCounts[value]}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
          <div className="flex flex-wrap items-center gap-3">
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
        </div>
        <div className="p-3 sm:p-5">
          {loading ? (
            <Empty>
              <EmptyHeader>
                <Loader2 className="size-5 animate-spin text-sky-200" />
                <EmptyTitle>Loading transactions</EmptyTitle>
                <EmptyDescription>Loading your saved transaction requests.</EmptyDescription>
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
              emptyLabel={filter === "all" ? "No transaction matches." : filter === "action" ? "Nothing needs your attention." : "Nothing in this section."}
              renderMobileRow={(tx) => <TransactionMobileCard tx={tx} connectedKeyHash={connected?.keyHash} busy={mutatingId === tx.id} onCopyLink={(item) => void copySignerLink(item)} onToggleArchive={(item) => void toggleArchived(item)} />}
              onRowClick={(tx) => navigate(transactionHref(tx))}
            />
          ) : (
            <Empty>
              <EmptyHeader>
                {account.authenticated ? <Cloud className="size-5 text-sky-200" /> : <Clock className="size-5 text-muted-foreground" />}
                <EmptyTitle>{account.authenticated ? "No transactions yet" : "Sign in to load transactions"}</EmptyTitle>
                <EmptyDescription>{account.authenticated ? "Create a transaction from a wallet to start collecting signatures." : "Sign in from the account menu to access your transactions on this device."}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </AppWindow>
    </div>
  );
}
