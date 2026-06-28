import type { ReactNode } from "react";
import { WalletCards } from "lucide-react";
import { cn } from "../../lib/utils";
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
        "glass-panel flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3",
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

      <div className="flex min-w-0 flex-wrap justify-end gap-2">
        {providers.map((provider) => (
          <Button
            key={provider.id}
            size="sm"
            variant={connected?.id === provider.id ? "default" : "secondary"}
            disabled={Boolean(connectingId)}
            onClick={() => onConnect(provider)}
          >
            {provider.icon ? <img alt="" className="size-4" src={provider.icon} /> : null}
            {connectingId === provider.id ? "Waiting..." : provider.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
