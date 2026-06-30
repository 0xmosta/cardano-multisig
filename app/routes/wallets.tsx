import { ArrowRight, Plus, Search, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/wallets";
import { AppWindow } from "../components/ui/app-window";
import { Avatar } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
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
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setWallets(readWallets());
  }, []);

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-zinc-50">Wallets</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">Open saved multisig policies, review signer rules, and continue treasury work.</p>
        </div>
        <Link to="/" className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
          <Plus className="size-4" /> Import or create
        </Link>
      </div>

      <AppWindow title="Wallets" contentClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-white/8 p-5">
          <div className="flex min-w-full flex-1 items-center gap-2 rounded-md border border-input bg-black/20 px-3 sm:min-w-0">
            <Search className="size-4 shrink-0 text-zinc-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search wallet, handle, signer, status..."
              className="border-0 bg-transparent px-0 shadow-none"
            />
          </div>
          <Badge variant="secondary" className="max-sm:w-full max-sm:justify-center">
            {visibleWallets.length} shown
          </Badge>
        </div>

        {visibleWallets.length ? (
          <div className="grid gap-3 p-5">
            {visibleWallets.map((wallet) => {
              const title = walletTitle(wallet);
              const watchOnly = !wallet.paymentScript;
              return (
                <article key={wallet.id} className="grid gap-4 rounded-lg border border-border bg-black/20 p-4 md:grid-cols-[minmax(0,1fr)_220px] md:items-center">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-white/5 text-zinc-300 ring-1 ring-white/10">
                      <WalletCards className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={walletHref(wallet)} className="break-words font-semibold text-zinc-50 underline-offset-4 hover:underline">
                          {title}
                        </Link>
                        <Badge variant="outline" className="border-white/10 text-zinc-400">{wallet.network}</Badge>
                        <Badge variant={watchOnly ? "outline" : wallet.imported ? "default" : "secondary"}>{watchOnly ? "watch-only" : wallet.imported ? "imported" : "created"}</Badge>
                      </div>
                      <div className="mt-2 text-sm text-zinc-400">
                        {watchOnly ? "Native script needed to spend" : `payment ${summarizeScript(wallet.paymentScript)}`}
                      </div>
                      <div className="mt-3 flex min-w-0 items-center gap-3">
                        <div className="-space-x-2 whitespace-nowrap">
                          {(wallet.signers || []).slice(0, 6).map((signer, index) => (
                            <Avatar key={signer.id || signer.keyHash} label={signer.label || `Signer ${index + 1}`} className="size-8 border border-[#121214]" />
                          ))}
                        </div>
                        <div className="text-xs text-zinc-500">{wallet.threshold || 0}-of-{wallet.signers?.length || 0} required</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-start gap-2 md:justify-end">
                    <Link to={walletHref(wallet)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
                      Open <ArrowRight className="size-4" />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="m-5 rounded-lg border border-dashed border-white/10 bg-black/20 p-8 text-center text-zinc-400">
            {wallets.length ? "No wallet matches the current search." : "No wallets saved yet. Import or create one from Home."}
          </div>
        )}
      </AppWindow>
    </div>
  );
}
