import { ArrowRight, Clock, Plus, Search, ShieldCheck, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/transactions";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Progress } from "../components/ui/progress";
import {
  type TxDraft,
  TX_STORAGE_KEY,
  pendingSignatureCount,
  signatureCount,
} from "../lib/multisig";
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
          <div className="flex min-w-full flex-1 items-center gap-2 rounded-md border border-input bg-black/20 px-3 sm:min-w-0">
            <Search className="size-4 shrink-0 text-zinc-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transaction, wallet, recipient, signer..."
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>
          <Badge variant="secondary" className="max-sm:w-full max-sm:justify-center">{visibleTransactions.length} shown</Badge>
        </div>

        {visibleTransactions.length ? (
          <div className="grid gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
            {visibleTransactions.map((tx) => {
              const signed = signatureCount(tx);
              const missing = pendingSignatureCount(tx);
              return (
                <article
                  key={tx.id}
                  className={cn(
                    "min-w-0 overflow-hidden rounded-lg border p-4 transition hover:border-white/18",
                    missing ? "border-border bg-black/20" : "border-emerald-400/40 bg-emerald-400/10",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar label={tx.walletName} tone={missing ? "primary" : "success"} />
                      <div className="min-w-0">
                        <h2 className="break-words font-semibold text-zinc-50">{tx.title}</h2>
                        <div className="mt-1 text-xs text-zinc-500">{tx.walletName} · {tx.network}</div>
                      </div>
                    </div>
                    <Badge variant={missing ? "secondary" : "default"}>
                      <Users className="size-3" /> {signed}/{tx.requiredSignatures}
                    </Badge>
                  </div>

                  <div className="mt-4 space-y-2">
                    <Progress value={signed} max={tx.requiredSignatures} />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                      <span className="inline-flex items-center gap-1">
                        {missing ? <Clock className="size-3" /> : <ShieldCheck className="size-3" />}
                        {missing ? `${missing} more signature${missing === 1 ? "" : "s"}` : "ready"}
                      </span>
                      <span>{tx.status || "pending"}</span>
                    </div>
                  </div>

                  <div className="mt-4 line-clamp-2 break-all text-sm text-zinc-400">{tx.recipient || "No recipient saved"}</div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Link to={walletHref(tx)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                      Open wallet <ArrowRight className="size-4" />
                    </Link>
                    <Link to={newTransactionHref(tx)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-secondary px-3 text-sm font-medium text-secondary-foreground hover:bg-secondary/80">
                      <Plus className="size-4" /> New
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="m-5 rounded-lg border border-dashed border-white/10 bg-black/20 p-8 text-center text-zinc-400">
            {transactions.length ? "No transaction matches the current search." : "No transaction rooms saved yet. Open a wallet and create a transaction."}
          </div>
        )}
      </AppWindow>
    </div>
  );
}
