import { Loader2, LogIn } from "lucide-react";
import { useAppShell } from "./app-shell";
import { Card, CardContent } from "./ui/card";
import { ActionError } from "./action-error";

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
      <ActionError
        title="Account sync paused"
        message="Your current screen is unchanged. Check the connection, then retry; no wallet data was discarded."
        details="The latest server account request did not complete."
        onRetry={() => refreshAccount().catch(() => undefined)}
        className={compact ? "p-4" : undefined}
      />
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
