import { Cloud, Database } from "lucide-react";
import { useAppShell } from "./app-shell";
import { Badge } from "./ui/badge";
import { Card, CardContent } from "./ui/card";

export function AccountSyncPanel({ compact = false }: { compact?: boolean }) {
  const { account, accountState } = useAppShell();

  if (!account.authenticated) {
    return (
      <Card className="border-amber-400/20 bg-amber-400/5">
        <CardContent className={compact ? "p-4" : "p-4 sm:p-5"}>
          <div className="flex items-center gap-3">
            <Database className="size-4 shrink-0 text-amber-100" />
            <div>
              <div className="text-sm font-semibold text-amber-100">Server account required</div>
              <p className="mt-1 text-sm text-amber-100/70">Sign in from the account menu to load wallets and transactions from PostgreSQL.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!accountState) return null;

  return (
    <Card className="border-sky-400/20 bg-sky-400/5">
      <CardContent className={compact ? "p-4" : "p-4 sm:p-5"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-sky-100">
              <Cloud className="size-4" /> Server-backed account
              <Badge variant="outline" className="border-sky-400/30 text-sky-100">
                {accountState.wallets.length} wallets · {accountState.transactions.length} transactions
              </Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-sky-100/70">
              PostgreSQL is the source of truth. Browser wallet and transaction storage is cleared and cannot be imported into the account.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
