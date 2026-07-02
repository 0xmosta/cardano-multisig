import { CircleUserRound, LogIn, ShieldCheck, WalletCards } from "lucide-react";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { BrowserWalletApi, BrowserWalletProvider } from "../lib/browser-wallets";

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

export type AppHeaderAccountSession = {
  subject: string;
  identityKind: "payment" | "stake";
  keyHash: string;
  network: string;
} | null;

function providerReadyLabel(serverProvider: AppHeaderProviderStatus) {
  if (!serverProvider) return "Provider status unavailable";
  if (serverProvider.ready) {
    return `${serverProvider.network} provider ready${serverProvider.services.submit ? " · submit enabled" : " · submit disabled"}`;
  }
  return `${serverProvider.network} provider needs attention`;
}

function syncLabel(state: "idle" | "authenticating" | "hydrating" | "syncing" | "synced" | "error") {
  if (state === "authenticating") return "signing in";
  if (state === "hydrating") return "loading server state";
  if (state === "syncing") return "syncing";
  if (state === "synced") return "server-backed";
  if (state === "error") return "sync error";
  return "local only";
}

export function AppHeader<TProvider extends BrowserWalletProvider<BrowserWalletApi>>({
  providers,
  connected,
  account,
  accountSyncState,
  connectingId,
  providerStatus,
  walletCount,
  roomCount,
  onConnect,
  onDisconnect,
  onSignIn,
  onSignOut,
}: {
  providers: TProvider[];
  connected: AppHeaderConnectedWallet;
  account: AppHeaderAccountSession;
  accountSyncState: "idle" | "authenticating" | "hydrating" | "syncing" | "synced" | "error";
  connectingId: string | null;
  providerStatus: AppHeaderProviderStatus;
  walletCount?: number;
  roomCount?: number;
  onConnect: (provider: TProvider) => void;
  onDisconnect?: () => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
  return (
    <header className="glass-panel flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-xl font-semibold leading-tight text-zinc-50 sm:text-2xl">Cardano multisig</h1>
          <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-200">
            {providerStatus?.network || "provider"}
          </Badge>
          <Badge variant="secondary" className="max-w-full truncate">{providerReadyLabel(providerStatus)}</Badge>
          <Badge variant={account ? "default" : "secondary"}>{syncLabel(accountSyncState)}</Badge>
        </div>
        {typeof walletCount === "number" || typeof roomCount === "number" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {typeof walletCount === "number" ? <span>{walletCount} wallet{walletCount === 1 ? "" : "s"}</span> : null}
            {typeof walletCount === "number" && typeof roomCount === "number" ? <span>·</span> : null}
            {typeof roomCount === "number" ? <span>{roomCount} room{roomCount === 1 ? "" : "s"}</span> : null}
            {account ? (
              <>
                <span>·</span>
                <span>{account.identityKind} account</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" className="h-10 shrink-0 self-start px-2.5 sm:self-auto">
            <CircleUserRound className="size-5 text-zinc-300" />
            <span className="hidden max-w-28 truncate sm:inline">{connected ? connected.name : account ? "Account" : "Signer"}</span>
            <Badge variant={account ? "default" : connected ? "secondary" : "outline"}>{account ? account.network : connected ? connected.networkLabel : "off"}</Badge>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="wallet-popover p-3">
          <DropdownMenuLabel className="sr-only">Signer wallet</DropdownMenuLabel>
          <div className="flex items-start gap-3 border-b border-border pb-3">
            <Avatar label={connected?.name || account?.subject || "Signer"} tone={account ? "success" : connected ? "primary" : "muted"} />
            <div className="min-w-0">
              <div className="font-semibold text-zinc-50">Signer wallet</div>
              <div className="mt-1 text-xs text-zinc-400">
                {connected ? `${connected.name} · ${connected.networkLabel}` : "Connect Lace, Eternl, or VESPR"}
              </div>
              {connected?.keyHash ? <div className="mt-2 break-all font-mono text-[11px] text-zinc-500">{connected.keyHash}</div> : null}
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-black/20 p-3 text-xs text-zinc-400">
            <div className="flex items-center gap-2 font-medium text-zinc-200">
              <ShieldCheck className="size-4" />
              {account ? "Authenticated account" : "Authenticated account not connected"}
            </div>
            <div className="mt-1 break-all">
              {account ? `${account.identityKind} · ${account.keyHash}` : "Connect a wallet, then sign the server challenge to make wallets and transactions durable across devices."}
            </div>
          </div>
          <DropdownMenuSeparator className="hidden" />
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
            {connected && !account && onSignIn ? (
              <Button type="button" onClick={onSignIn} className="justify-start">
                <LogIn className="size-4" /> Sign challenge for server sync
              </Button>
            ) : null}
            {account && onSignOut ? (
              <Button type="button" variant="ghost" onClick={onSignOut}>
                Sign out authenticated account
              </Button>
            ) : null}
            {connected && onDisconnect ? (
              <Button type="button" variant="ghost" onClick={onDisconnect}>
                Disconnect local wallet session
              </Button>
            ) : null}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
