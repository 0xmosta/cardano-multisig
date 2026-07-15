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

function syncLabel(state: "idle" | "authenticating" | "hydrating" | "syncing" | "synced" | "error") {
  if (state === "authenticating") return "Signing in…";
  if (state === "hydrating") return "Loading…";
  if (state === "syncing") return "Saving…";
  if (state === "error") return "Needs attention";
  return "";
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
  signerWalletCount,
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
  signerWalletCount?: number;
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
            {providerStatus?.network || account?.network || connected?.networkLabel || "Cardano"}
          </Badge>
          {accountSyncState !== "idle" && accountSyncState !== "synced" ? (
            <Badge variant={accountSyncState === "error" ? "outline" : "secondary"} className={accountSyncState === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : ""}>
              {syncLabel(accountSyncState)}
            </Badge>
          ) : null}
          {providerStatus && !providerStatus.ready ? <Badge variant="outline" className="border-amber-400/30 text-amber-200">Network unavailable</Badge> : null}
        </div>
        {typeof walletCount === "number" || typeof roomCount === "number" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {typeof walletCount === "number" ? <span>{walletCount} wallet{walletCount === 1 ? "" : "s"}</span> : null}
            {typeof walletCount === "number" && typeof roomCount === "number" ? <span>·</span> : null}
            {typeof roomCount === "number" ? <span>{roomCount} room{roomCount === 1 ? "" : "s"}</span> : null}
            {account ? (
              <>
                <span>·</span>
                <span>saved across devices</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" className="h-10 shrink-0 self-start px-2.5 sm:self-auto">
            <CircleUserRound className="size-5 text-zinc-300" />
            <span className="hidden max-w-28 truncate sm:inline">{connected ? connected.name : account ? "Signed in" : "Sign in"}</span>
            <Badge variant={account ? "default" : connected ? "secondary" : "outline"}>{account ? account.network : connected ? connected.networkLabel : "off"}</Badge>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="wallet-popover p-3">
          <DropdownMenuLabel className="sr-only">Signer wallet</DropdownMenuLabel>
          <div className="flex items-start gap-3 border-b border-border pb-3">
            <Avatar label={connected?.name || account?.subject || "Signer"} tone={account ? "success" : connected ? "primary" : "muted"} />
            <div className="min-w-0">
              <div className="font-semibold text-zinc-50">{connected ? connected.name : "Wallet account"}</div>
              <div className="mt-1 text-xs text-zinc-400">
                {connected ? `${connected.networkLabel} · connected for signing` : "Connect Lace, Eternl, or VESPR"}
              </div>
              {connected?.keyHash ? <div className="mt-2 font-mono text-[11px] text-zinc-500">{connected.keyHash.slice(0, 10)}…{connected.keyHash.slice(-8)}</div> : null}
            </div>
          </div>
          <div className="mt-3 rounded-lg border border-border bg-black/20 p-3 text-xs text-zinc-400">
            <div className="flex items-center gap-2 font-medium text-zinc-200">
              <ShieldCheck className="size-4" />
              {account ? "Signed in across devices" : "Not signed in yet"}
            </div>
            <div className="mt-1">
              {account
                ? `${walletCount || 0} wallet${walletCount === 1 ? "" : "s"} and ${roomCount || 0} transaction${roomCount === 1 ? "" : "s"} available.`
                : "Connect a wallet and sign in once to access your saved work on this device."}
            </div>
            {connected?.keyHash ? <div className="mt-2 text-zinc-300">You can sign {signerWalletCount || 0} saved wallet{signerWalletCount === 1 ? "" : "s"}.</div> : null}
          </div>
          <div className="mt-3 rounded-lg border border-border bg-black/20 p-3 text-[11px] text-zinc-500">
            <div>Account: {account ? `${account.identityKind} · ${account.keyHash.slice(0, 10)}…${account.keyHash.slice(-8)}` : "not signed in"}</div>
            <div className="mt-1">Service: {providerStatus?.ready ? "online" : "unavailable"} · Save status: {accountSyncState === "synced" ? "saved" : syncLabel(accountSyncState) || "idle"}</div>
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
                <LogIn className="size-4" /> Sign in with {connected.name}
              </Button>
            ) : null}
            {account && onSignOut ? (
              <Button type="button" variant="ghost" onClick={onSignOut}>
                Sign out
              </Button>
            ) : null}
            {connected && onDisconnect ? (
              <Button type="button" variant="ghost" onClick={onDisconnect}>
                Disconnect {connected.name}
              </Button>
            ) : null}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
