import { ArrowRight, Clock, Plus, Search, ShieldCheck, Users } from "lucide-react";
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
  pendingSignatureCount,
  signatureCount,
} from "../lib/multisig";

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

function walletHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}` : "/";
}

function newTransactionHref(tx: TxDraft) {
  return tx.walletId ? `/wallets/${encodeURIComponent(tx.walletId)}/transactions/new` : "/";
}

export default function TransactionsRoute() {
  const [transactions, setTransactions] = useState<TxDraft[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setTransactions(readTransactions());
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
        tx.status || "pending",
        tx.txHash,
        ...(tx.signerKeyHashes || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(value),
    );
  }, [query, transactions]);

  const readyCount = transactions.filter((tx) => pendingSignatureCount(tx) <= 0).length;
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
          return (
            <div className="min-w-36 space-y-2">
              <Badge variant={missing ? "secondary" : "default"}>
                <Users className="size-3" /> {signed}/{tx.requiredSignatures}
              </Badge>
              <Progress value={signed} max={tx.requiredSignatures} />
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {missing ? <Clock className="size-3" /> : <ShieldCheck className="size-3" />}
                {missing ? `${missing} more` : "ready"}
              </div>
            </div>
          );
        },
      },
      {
        header: "Status",
        cell: ({ row }) => <Badge variant={pendingSignatureCount(row.original) ? "secondary" : "default"}>{row.original.status || "pending"}</Badge>,
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
