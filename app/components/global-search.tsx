import { ArrowRight, BookUser, Copy, Search, Users, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { AccountPreferences, AddressBookContact, MultisigWallet, TxDraft } from "../lib/multisig";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

type Snapshot = { wallets: MultisigWallet[]; transactions: TxDraft[]; contacts: AddressBookContact[]; preferences: AccountPreferences };

export function GlobalSearchDialog({ open, onOpenChange, snapshot }: { open: boolean; onOpenChange: (open: boolean) => void; snapshot: Snapshot | null }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const results = useMemo(() => {
    const needle = query.trim().replace(/^\$/, "").toLowerCase();
    if (!needle || !snapshot) return [];
    const wallets = snapshot.wallets
      .filter((wallet) => [wallet.name, wallet.handle, wallet.id, ...wallet.signers.flatMap((signer) => [signer.label, signer.keyHash])].filter(Boolean).join(" ").toLowerCase().includes(needle))
      .map((wallet) => ({ type: "wallet" as const, id: wallet.id, title: wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name, detail: `${wallet.threshold}-of-${wallet.signers.length} · ${wallet.network}`, href: `/wallets/${encodeURIComponent(wallet.id)}` }));
    const transactions = snapshot.transactions
      .filter((tx) => [tx.title, tx.walletName, tx.recipient, tx.txHash, tx.note, ...tx.signerKeyHashes].filter(Boolean).join(" ").toLowerCase().includes(needle))
      .map((tx) => ({ type: "transaction" as const, id: tx.id, title: tx.title, detail: `${tx.walletName} · ${tx.txHash ? "submitted" : "in progress"}`, href: `/transactions/${encodeURIComponent(tx.id)}` }));
    const contacts = snapshot.contacts
      .filter((contact) => [contact.label, contact.handle, contact.address].filter(Boolean).join(" ").toLowerCase().includes(needle))
      .map((contact) => ({ type: "contact" as const, id: contact.id, title: contact.label, detail: contact.handle ? `$${contact.handle.replace(/^\$/, "")}` : contact.address, address: contact.address }));
    return [...wallets, ...transactions, ...contacts].slice(0, 24);
  }, [query, snapshot]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Find wallets, transactions, signers, hashes, recipients, and saved contacts.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search everything…" className="h-12 pl-10" />
          </div>
          {!query.trim() ? <p className="rounded-lg border border-border bg-black/20 p-4 text-sm text-muted-foreground">Type a wallet name, ADA Handle, signer, transaction, address, or hash. Shortcut: ⌘K / Ctrl K.</p> : null}
          {query.trim() && !results.length ? <p className="rounded-lg border border-border bg-black/20 p-4 text-sm text-muted-foreground">No matching server records.</p> : null}
          <div className="grid max-h-[55dvh] gap-2 overflow-y-auto">
            {results.map((result) => {
              const Icon = result.type === "wallet" ? WalletCards : result.type === "transaction" ? Users : BookUser;
              if (result.type === "contact") {
                return (
                  <button key={`${result.type}-${result.id}`} type="button" className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-black/20 p-3 text-left transition hover:bg-white/[0.05]" onClick={() => {
                    void navigator.clipboard.writeText(result.address);
                    toast.success("Address copied", { description: result.title });
                    onOpenChange(false);
                  }}>
                    <Icon className="size-5 shrink-0 text-sky-200" /><span className="min-w-0 flex-1"><span className="block font-medium">{result.title}</span><span className="block truncate text-xs text-muted-foreground">{result.detail}</span></span><Copy className="size-4" />
                  </button>
                );
              }
              return (
                <Button key={`${result.type}-${result.id}`} asChild variant="ghost" className="h-auto justify-start gap-3 border border-border bg-black/20 p-3 text-left hover:bg-white/[0.05]">
                  <Link to={result.href} onClick={() => onOpenChange(false)}><Icon className="size-5 shrink-0 text-sky-200" /><span className="min-w-0 flex-1"><span className="block font-medium">{result.title}</span><span className="block truncate text-xs font-normal text-muted-foreground">{result.detail}</span></span><ArrowRight className="size-4" /></Link>
                </Button>
              );
            })}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
