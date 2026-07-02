import { Cloud, Database, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useAppShell, notifyAppStorageChanged } from "./app-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, TX_STORAGE_KEY, mergeTransactionDrafts, type MultisigWallet, type TxDraft } from "../lib/multisig";

function readArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function readLocalWallets() {
  const current = readArray<MultisigWallet>(STORAGE_KEY);
  return current.length ? current : readArray<MultisigWallet>(LEGACY_STORAGE_KEY);
}

function readLocalTransactions() {
  return readArray<TxDraft>(TX_STORAGE_KEY);
}

function mergeWallets(server: MultisigWallet[], local: MultisigWallet[]) {
  const byId = new Map(server.map((wallet) => [wallet.id, wallet]));
  for (const wallet of local) byId.set(wallet.id, wallet);
  return [...byId.values()].sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
}

export function AccountSyncPanel({ compact = false }: { compact?: boolean }) {
  const { account, accountState, saveServerState } = useAppShell();
  const [importing, setImporting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const localWallets = useMemo(readLocalWallets, [accountState]);
  const localTransactions = useMemo(readLocalTransactions, [accountState]);
  const localCount = localWallets.length + localTransactions.length;
  const serverWalletIds = new Set((accountState?.wallets || []).map((wallet) => wallet.id));
  const serverTransactionIds = new Set((accountState?.transactions || []).map((transaction) => transaction.id));
  const unsyncedWallets = localWallets.filter((wallet) => !serverWalletIds.has(wallet.id));
  const unsyncedTransactions = localTransactions.filter((transaction) => !serverTransactionIds.has(transaction.id));
  const unsyncedCount = unsyncedWallets.length + unsyncedTransactions.length;

  if (!account.authenticated) {
    return (
      <Card className="border-amber-400/20 bg-amber-400/5">
        <CardContent className={compact ? "p-4" : "p-5"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-100">
                <Database className="size-4" /> Local browser state
              </div>
              <p className="mt-1 text-sm text-amber-100/70">Sign in from the account menu to review local wallets/transactions and import them to server sync.</p>
            </div>
            {localCount ? <Badge variant="outline">{localCount} local item{localCount === 1 ? "" : "s"}</Badge> : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  async function importLocal() {
    if (!accountState) return;
    setImporting(true);
    try {
      const next = await saveServerState({
        wallets: mergeWallets(accountState.wallets, unsyncedWallets),
        transactions: mergeTransactionDrafts(accountState.transactions, unsyncedTransactions),
      });
      if (!next) return;
      toast.success("Local data imported", { description: "The server copy is now the source for this signed-in account." });
    } finally {
      setImporting(false);
    }
  }

  function clearLocal() {
    setClearing(true);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      window.localStorage.removeItem(TX_STORAGE_KEY);
      notifyAppStorageChanged();
      toast.success("Local browser copy cleared", { description: "Signed-in pages will continue using server-synced state." });
    } finally {
      setClearing(false);
    }
  }

  if (!accountState || !unsyncedCount) return null;

  return (
    <Card className="border-sky-400/20 bg-sky-400/5">
      <CardContent className={compact ? "p-4" : "p-5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-sky-100">
              <Cloud className="size-4" /> Server-synced account
              <Badge variant="outline" className="border-sky-400/30 text-sky-100">{accountState?.wallets.length ?? 0} wallets · {accountState?.transactions.length ?? 0} transactions</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-sky-100/70">
              This browser has local-only wallets or transaction rooms that are not in the signed-in server account yet.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => void importLocal()} disabled={importing}>
              {importing ? "Importing..." : `Import ${unsyncedCount} local`}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clearLocal} disabled={clearing}>
              <Trash2 className="size-4" /> Clear local
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
