import { ArrowRight, Cloud, Loader2, Plus, Search, WalletCards } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/wallets";
import { AccountSyncPanel } from "../components/account-sync-panel";
import { useAppShell } from "../components/app-shell";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DataTable } from "../components/ui/data-table";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import {
  type MultisigWallet,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  summarizeScript,
} from "../lib/multisig";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Wallets · Cardano Multisig" }];
}

function readWallets() {
  if (typeof window === "undefined") return [];
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
      if (Array.isArray(parsed) && parsed.length) return parsed as MultisigWallet[];
    } catch {
      // Keep trying the next storage key.
    }
  }
  return [];
}

function walletTitle(wallet: MultisigWallet) {
  return wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name || wallet.id;
}

function walletHref(wallet: MultisigWallet) {
  return `/wallets/${encodeURIComponent(wallet.id)}`;
}

export default function WalletsRoute() {
  const { account, accountState, refreshServerState } = useAppShell();
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!account.authenticated) {
      setWallets(readWallets());
      return;
    }
    if (accountState) {
      setWallets(accountState.wallets);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    refreshServerState()
      .then((state) => {
        if (!cancelled && state) setWallets(state.wallets);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not load server wallets.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.authenticated, accountState]);

  const visibleWallets = useMemo(() => {
    const value = query.trim().replace(/^\$/, "").toLowerCase();
    if (!value) return wallets;
    return wallets.filter((wallet) =>
      [
        walletTitle(wallet),
        wallet.name,
        wallet.handle,
        wallet.id,
        wallet.network,
        wallet.imported ? "imported" : "created",
        wallet.paymentScript ? "spendable" : "watch-only",
        ...(wallet.signers || []).map((signer) => `${signer.label} ${signer.keyHash}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(value),
    );
  }, [query, wallets]);

  const columns = useMemo<ColumnDef<MultisigWallet>[]>(
    () => [
      {
        header: "Wallet",
        cell: ({ row }) => {
          const wallet = row.original;
          const title = walletTitle(wallet);
          return (
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <WalletCards className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={walletHref(wallet)} className="break-words font-semibold text-foreground underline-offset-4 hover:underline">
                    {title}
                  </Link>
                  <Badge variant="outline">{wallet.network}</Badge>
                </div>
                <div className="mt-1 max-w-md truncate text-xs text-muted-foreground">
                  {!wallet.paymentScript ? wallet.discovery?.address : wallet.handle ? wallet.name : wallet.id}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        header: "Policy",
        cell: ({ row }) => {
          const wallet = row.original;
          const watchOnly = !wallet.paymentScript;
          return (
            <div className="text-sm">
              {watchOnly ? "Native script needed to spend" : `payment ${summarizeScript(wallet.paymentScript)}`}
              <div className="mt-1 text-xs text-muted-foreground">
                {watchOnly ? "watch-only" : `${wallet.threshold || 0}-of-${wallet.signers?.length || 0} required`}
              </div>
            </div>
          );
        },
      },
      {
        header: "Signers",
        cell: ({ row }) => {
          const wallet = row.original;
          if (!wallet.signers?.length) return <span className="text-muted-foreground">watch address</span>;
          return (
            <div className="flex min-w-0 items-center gap-3">
              <div className="-space-x-2 whitespace-nowrap">
                {wallet.signers.slice(0, 6).map((signer, index) => (
                  <Avatar key={signer.id || signer.keyHash} label={signer.label || `Signer ${index + 1}`} className="size-8 border border-background" />
                ))}
              </div>
              {wallet.signers.length > 6 ? <span className="text-xs text-muted-foreground">+{wallet.signers.length - 6}</span> : null}
            </div>
          );
        },
      },
      {
        header: "Status",
        cell: ({ row }) => {
          const wallet = row.original;
          const watchOnly = !wallet.paymentScript;
          return <Badge variant={watchOnly ? "outline" : wallet.imported ? "default" : "secondary"}>{watchOnly ? "watch-only" : wallet.imported ? "imported" : "created"}</Badge>;
        },
      },
      {
        id: "actions",
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild size="sm">
              <Link to={walletHref(row.original)}>
                Open <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-zinc-50">Wallets</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Open saved multisig policies, review signer rules, and continue treasury work from {account ? "your signed-in server account" : "this browser"}.</p>
        </div>
        <Button asChild>
          <Link to="/">
            <Plus className="size-4" /> Import or create
          </Link>
        </Button>
      </div>

      <AccountSyncPanel />

      <AppWindow title="Wallets" contentClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/8 p-5">
          <div className="relative min-w-full flex-1 sm:min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search wallet, handle, signer, status..."
              className="pl-9"
            />
          </div>
          <Badge variant="secondary" className="max-sm:w-full max-sm:justify-center">
            <span>{visibleWallets.length}</span>
            <span>shown</span>
          </Badge>
        </div>
        <div className="p-5">
          {loading ? (
            <Empty>
              <EmptyHeader>
                <Loader2 className="size-5 animate-spin text-sky-200" />
                <EmptyTitle>Loading server wallets</EmptyTitle>
                <EmptyDescription>Fetching the wallet list for your authenticated account.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : loadError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Could not load wallets</EmptyTitle>
                <EmptyDescription>{loadError}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" variant="secondary" onClick={() => void refreshServerState()}>
                  Retry
                </Button>
              </EmptyContent>
            </Empty>
          ) : wallets.length ? (
            <DataTable columns={columns} data={visibleWallets} emptyLabel="No wallet matches." />
          ) : (
            <Empty>
              <EmptyHeader>
                {account ? <Cloud className="size-5 text-sky-200" /> : <WalletCards className="size-5 text-muted-foreground" />}
                <EmptyTitle>{account ? "No server wallets yet" : "No local wallets saved yet"}</EmptyTitle>
                <EmptyDescription>{account ? "Import a local browser copy above or create/import a policy to save it for this account." : "Create or import a multisig wallet from Home, then sign in to sync it across browsers."}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild>
                  <Link to="/">
                    <Plus className="size-4" /> Import or create
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </div>
      </AppWindow>
    </div>
  );
}
