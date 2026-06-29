import { CircleUserRound, WalletCards } from "lucide-react";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import type { BrowserWalletApi, BrowserWalletProvider } from "../lib/browser-wallets";
import { DEFAULT_NETWORK } from "../lib/multisig";

export type AppHeaderProviderStatus = {
  mode: "server";
  network: string;
  ready: boolean;
  services: { blockfrost: boolean; kupo: boolean; ogmios: boolean; submit: boolean };
} | null;

export type AppHeaderConnectedWallet = {
  id: string;
  name: string;
  networkLabel: string;
  keyHash?: string | null;
} | null;

function providerReadyLabel(serverProvider: AppHeaderProviderStatus) {
  if (!serverProvider) return "Provider status unavailable";
  if (serverProvider.ready) {
    return `${serverProvider.network} provider ready${serverProvider.services.submit ? " · submit enabled" : " · submit disabled"}`;
  }
  return `${serverProvider.network} provider needs attention`;
}

export function AppHeader<TProvider extends BrowserWalletProvider<BrowserWalletApi>>({
  providers,
  connected,
  connectingId,
  providerStatus,
  walletCount,
  roomCount,
  onConnect,
  onDisconnect,
}: {
  providers: TProvider[];
  connected: AppHeaderConnectedWallet;
  connectingId: string | null;
  providerStatus: AppHeaderProviderStatus;
  walletCount?: number;
  roomCount?: number;
  onConnect: (provider: TProvider) => void;
  onDisconnect?: () => void;
}) {
  return (
    <header className="glass-panel flex flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold leading-tight text-zinc-50 sm:text-2xl">Cardano multisig</h1>
          <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-200">
            {DEFAULT_NETWORK}
          </Badge>
          <Badge variant="secondary">{providerReadyLabel(providerStatus)}</Badge>
        </div>
        {typeof walletCount === "number" || typeof roomCount === "number" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {typeof walletCount === "number" ? <span>{walletCount} wallet{walletCount === 1 ? "" : "s"}</span> : null}
            {typeof walletCount === "number" && typeof roomCount === "number" ? <span>·</span> : null}
            {typeof roomCount === "number" ? <span>{roomCount} room{roomCount === 1 ? "" : "s"}</span> : null}
          </div>
        ) : null}
      </div>

      <details className="group relative shrink-0">
        <summary className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-md border border-border bg-secondary px-2.5 text-sm text-zinc-100 transition hover:bg-secondary/80 [&::-webkit-details-marker]:hidden">
          <CircleUserRound className="size-5 text-zinc-300" />
          <span className="hidden max-w-28 truncate sm:inline">{connected ? connected.name : "Signer"}</span>
          <Badge variant={connected ? "default" : "secondary"}>{connected ? connected.networkLabel : "off"}</Badge>
        </summary>
        <div className="absolute right-0 top-12 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-[#18181b] p-3 shadow-2xl shadow-black/50">
          <div className="flex items-start gap-3 border-b border-border pb-3">
            <Avatar label={connected?.name || "Signer"} tone={connected ? "success" : "muted"} />
            <div className="min-w-0">
              <div className="font-semibold text-zinc-50">Signer wallet</div>
              <div className="mt-1 text-xs text-zinc-400">
                {connected ? `${connected.name} · ${connected.networkLabel}` : "Connect Lace, Eternl, or VESPR"}
              </div>
              {connected?.keyHash ? <div className="mt-2 break-all font-mono text-[11px] text-zinc-500">{connected.keyHash}</div> : null}
            </div>
          </div>
          <div className="mt-3 grid gap-2">
            {providers.length ? (
              providers.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
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
              <div className="rounded-lg border border-border bg-black/20 p-3 text-sm text-zinc-400">No browser wallet detected.</div>
            )}
            {connected && onDisconnect ? (
              <Button type="button" variant="ghost" onClick={onDisconnect}>
                Disconnect local session
              </Button>
            ) : null}
          </div>
        </div>
      </details>
    </header>
  );
}
