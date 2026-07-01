import { ArrowRight, CheckCircle2, Clock, Plus, RefreshCw, Search, ShieldCheck, Users } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/transactions";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DataTable } from "../components/ui/data-table";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import {
  type TxDraft,
  TX_STORAGE_KEY,
  mergeTransactionDrafts,
  pendingSignatureCount,
  signatureCount,
} from "../lib/multisig";
import { applyRelayRoomToDraft, type RelayRoomSessionResponse } from "../lib/relay-room";
import { cn } from "../lib/utils";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Transactions · Cardano Multisig" }];
}

function readTransactions() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TX_STORAGE_KEY) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as TxDraft[]) : [];
  } catch {
    return [];
  }
}

function writeTransactions(transactions: TxDraft[]) {
  window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(transactions, null, 2));
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
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}` : "/";
}

function newTransactionHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}/transactions/new` : "/";
}

export default function TransactionsRoute() {
  const [transactions, setTransactions] = useState<TxDraft[]>([]);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);

  async function refreshRelayRooms(source = readTransactions()) {
    const relayTransactions = source.filter((tx) => tx.relayRoom?.roomId);
    if (!relayTransactions.length) return;
    setSyncing(true);
    try {
      const updates = await Promise.all(
        relayTransactions.map(async (tx) => {
          const response = await fetch("/api/cardano/relay-room", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ intent: "view", roomId: tx.relayRoom!.roomId }),
          });
          const body = (await response.json()) as RelayRoomSessionResponse | { ok: false; error?: string };
          if (!response.ok || !body.ok) return null;
          return { txId: tx.id, room: body.room };
        }),
      );
      const byId = new Map(updates.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => [item.txId, item.room]));
      if (!byId.size) return;
      setTransactions((current) => {
        const next = mergeTransactionDrafts(
          current,
          source.map((tx) => {
            const room = byId.get(tx.id);
            return room ? applyRelayRoomToDraft(tx, room) : tx;
          }),
        );
        writeTransactions(next);
        return next;
      });
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    const stored = readTransactions();
    setTransactions(stored);
    void refreshRelayRooms(stored).catch(() => undefined);
    const refreshFromStorage = () => {
      const stored = readTransactions();
      setTransactions((current) => mergeTransactionDrafts(current, stored));
      void refreshRelayRooms(stored).catch(() => undefined);
    };
    window.addEventListener("storage", refreshFromStorage);
    window.addEventListener("focus", refreshFromStorage);
    return () => {
      window.removeEventListener("storage", refreshFromStorage);
      window.removeEventListener("focus", refreshFromStorage);
    };
  }, []);

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
        <div>
          <h1 className="text-3xl font-semibold text-zinc-50">Transactions</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Track pending signature rooms, open wallet coordinators, and continue transaction work.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            {transactions.length} room{transactions.length === 1 ? "" : "s"}
          </Badge>
          {readyCount ? <Badge className="bg-emerald-300 text-emerald-950">{readyCount} ready</Badge> : null}
          {submittedCount ? <Badge variant="secondary">{submittedCount} submitted</Badge> : null}
          <Button type="button" size="sm" variant="secondary" onClick={() => void refreshRelayRooms(transactions)} disabled={syncing}>
            <RefreshCw className={cn("size-4", syncing ? "animate-spin" : "")} /> Sync
          </Button>
        </div>
      </div>

      <AppWindow title="Transaction rooms" contentClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/8 p-5">
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
        <div className="p-5">
          <DataTable columns={columns} data={visibleTransactions} emptyLabel={transactions.length ? "No transaction matches." : "No transaction rooms yet."} />
        </div>
      </AppWindow>
    </div>
  );
}
