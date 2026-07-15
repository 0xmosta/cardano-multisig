import { AlertTriangle, Loader2, LogIn, RefreshCw } from "lucide-react";
import { useAppShell } from "./app-shell";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

export function AccountSyncPanel({ compact = false }: { compact?: boolean }) {
  const { account, accountState, accountSyncState, refreshAccount } = useAppShell();

  if (!account.authenticated) {
    return (
      <Card className="border-amber-400/20 bg-amber-400/5">
        <CardContent className={compact ? "p-4" : "p-4 sm:p-5"}>
          <div className="flex items-center gap-3">
            <LogIn className="size-4 shrink-0 text-amber-100" />
            <div>
              <div className="text-sm font-semibold text-amber-100">Sign in to continue</div>
              <p className="mt-1 text-sm text-amber-100/70">Use the account menu to access your wallets and transactions from this device.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (accountSyncState === "error") {
    return (
      <Card className="border-rose-400/25 bg-rose-400/5">
        <CardContent className={compact ? "p-4" : "p-4 sm:p-5"}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-200" />
              <div>
                <div className="text-sm font-semibold text-rose-100">We could not refresh your account</div>
                <p className="mt-1 text-sm text-rose-100/70">Your current screen is unchanged. Check the connection and try again.</p>
              </div>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => void refreshAccount().catch(() => undefined)}>
              <RefreshCw className="size-4" /> Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (accountState) return null;

  return (
    <Card className="border-sky-400/20 bg-sky-400/5">
      <CardContent className={compact ? "p-4" : "p-4 sm:p-5"}>
        <div className="flex items-center gap-3 text-sm text-sky-100">
          <Loader2 className="size-4 animate-spin" /> Loading your account…
        </div>
      </CardContent>
    </Card>
  );
}
