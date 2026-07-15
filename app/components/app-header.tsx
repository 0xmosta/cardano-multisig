import { BookUser, Check, CircleUserRound, Laptop, LogIn, Search, Settings2, ShieldCheck, WalletCards } from "lucide-react";
import { Link } from "react-router";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  onOpenSearch,
  onOpenContacts,
  onOpenSettings,
  onOpenSessions,
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
  onOpenSearch?: () => void;
  onOpenContacts?: () => void;
  onOpenSettings?: () => void;
  onOpenSessions?: () => void;
}) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between gap-3 border-b border-border bg-[#111113]/95 px-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/wallets" className="mr-1 flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Cardano multisig wallets">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-zinc-100">
              <ShieldCheck className="size-4" />
            </span>
            <h1 className="truncate text-lg font-semibold leading-tight text-zinc-50 sm:text-xl">Cardano multisig</h1>
          </Link>
          {accountSyncState !== "idle" && accountSyncState !== "synced" ? (
            <Badge variant={accountSyncState === "error" ? "outline" : "secondary"} className={`hidden sm:inline-flex ${accountSyncState === "error" ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : ""}`}>
              {syncLabel(accountSyncState)}
            </Badge>
          ) : null}
          {providerStatus && !providerStatus.ready ? <Badge variant="outline" className="hidden border-amber-400/30 text-amber-200 sm:inline-flex">Network unavailable</Badge> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="size-10" onClick={onOpenSearch} aria-label="Search wallets and transactions" title="Search (Ctrl K)">
          <Search className="size-5" />
        </Button>
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="relative size-10 shrink-0 rounded-full"
            aria-label={connected ? `Connected wallet: ${connected.name}. Choose wallet` : "Choose wallet"}
            title={connected ? `${connected.name} connected` : "Choose wallet"}
          >
            <CircleUserRound className="size-5 text-zinc-200" />
            <span
              aria-hidden="true"
              className={`absolute bottom-0.5 right-0.5 size-2.5 rounded-full border-2 border-[#242426] ${connected ? "bg-emerald-400" : account ? "bg-sky-400" : "bg-zinc-500"}`}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="wallet-popover p-3">
          <DropdownMenuLabel className="px-0 pb-2 pt-0 text-sm font-semibold text-zinc-100">Choose signer wallet</DropdownMenuLabel>
          <div className="grid gap-2">
            {providers.length ? (
              providers.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  variant={connected?.id === provider.id ? "default" : "secondary"}
                  disabled={Boolean(connectingId)}
                  onClick={() => onConnect(provider)}
                  className="h-11 justify-start"
                >
                  {provider.icon ? <img alt="" className="size-5" src={provider.icon} /> : <WalletCards className="size-5" />}
                  <span className="min-w-0 flex-1 truncate text-left">{connectingId === provider.id ? `Connecting ${provider.name}…` : provider.name}</span>
                  {connected?.id === provider.id ? <><Check className="size-4" /><span className="sr-only">Connected</span></> : null}
                </Button>
              ))
            ) : (
              <div className="rounded-lg border border-border bg-black/20 p-3 text-sm text-zinc-400">No browser wallet detected.</div>
            )}
          </div>

          <DropdownMenuSeparator className="my-3" />
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
          <div className="mt-3 grid gap-2">
            {account ? (
              <div className="grid gap-1 rounded-lg border border-border bg-black/20 p-1">
                <DropdownMenuItem onSelect={onOpenContacts}><BookUser className="size-4" /> Address book</DropdownMenuItem>
                <DropdownMenuItem onSelect={onOpenSettings}><Settings2 className="size-4" /> Preferences & notifications</DropdownMenuItem>
                <DropdownMenuItem onSelect={onOpenSessions}><Laptop className="size-4" /> Signed-in devices</DropdownMenuItem>
              </div>
            ) : null}
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
      </div>
    </header>
  );
}
