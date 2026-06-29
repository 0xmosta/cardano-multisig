import type { ReactNode } from "react";
import { CircleUserRound, WalletCards } from "lucide-react";
import { cn } from "../../lib/utils";
import { Avatar } from "./avatar";
import { Badge } from "./badge";
import { Button } from "./button";

export type WalletConnectorProvider = {
  id: string;
  name: string;
  icon?: string;
};

export type WalletConnectorState = {
  id: string;
  name: string;
  networkLabel: string;
  keyHash?: string | null;
} | null;

export function WalletConnectorBar<TProvider extends WalletConnectorProvider>({
  providers,
  connected,
  connectingId,
  onConnect,
  emptyLabel,
  className,
  children,
}: {
  providers: TProvider[];
  connected: WalletConnectorState;
  connectingId: string | null;
  onConnect: (provider: TProvider) => void;
  emptyLabel: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "glass-panel flex min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-zinc-300 ring-1 ring-white/8">
          <WalletCards className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">Signer wallet</span>
            <Badge variant={connected ? "default" : "secondary"}>{connected ? "connected" : "off"}</Badge>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            <span>{connected ? `${connected.name} · ${connected.networkLabel}` : emptyLabel}</span>
            {connected?.keyHash ? (
              <span className="max-w-[22rem] truncate rounded border border-white/8 bg-black/20 px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {connected.keyHash}
              </span>
            ) : null}
            {children}
          </div>
        </div>
      </div>

      <details className="group relative shrink-0">
        <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-secondary px-2.5 text-sm text-zinc-100 transition hover:bg-secondary/80 [&::-webkit-details-marker]:hidden">
          <CircleUserRound className="size-5 text-zinc-300" />
          <span className="hidden max-w-24 truncate sm:inline">{connected ? connected.name : "Manage"}</span>
        </summary>
        <div className="absolute right-0 top-11 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-[#18181b] p-3 shadow-2xl shadow-black/50">
          <div className="flex items-start gap-3 border-b border-border pb-3">
            <Avatar label={connected?.name || "Signer"} tone={connected ? "success" : "muted"} />
            <div className="min-w-0">
              <div className="font-semibold text-zinc-50">Signer wallet</div>
              <div className="mt-1 text-xs text-zinc-400">
                {connected ? `${connected.name} · ${connected.networkLabel}` : emptyLabel}
              </div>
              {connected?.keyHash ? <div className="mt-2 break-all font-mono text-[11px] text-zinc-500">{connected.keyHash}</div> : null}
            </div>
          </div>
          <div className="mt-3 grid gap-2">
            {providers.length ? (
              providers.map((provider) => (
                <Button
                  key={provider.id}
                  size="sm"
                  variant={connected?.id === provider.id ? "default" : "secondary"}
                  disabled={Boolean(connectingId)}
                  onClick={() => onConnect(provider)}
                  className="justify-start"
                >
                  {provider.icon ? <img alt="" className="size-4" src={provider.icon} /> : <WalletCards className="size-4" />}
                  {connectingId === provider.id ? "Waiting..." : provider.name}
                </Button>
              ))
            ) : (
              <div className="rounded-lg border border-border bg-black/20 p-3 text-sm text-zinc-400">{emptyLabel}</div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
