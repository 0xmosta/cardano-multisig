import { Bell, BellOff, BookUser, Laptop, Loader2, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  createId,
  nowIso,
  type AccountPreferences,
  type AddressBookContact,
  type MultisigWallet,
  type Network,
} from "../lib/multisig";
import { userFacingError } from "../lib/utils";
import { ActionError } from "./action-error";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type SessionSummary = { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent?: string };

function deviceName(userAgent?: string) {
  if (!userAgent) return "Unknown browser";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const device = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Macintosh/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "device";
  return `${browser} on ${device}`;
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function AccountToolsDialog({
  open,
  onOpenChange,
  initialTab = "preferences",
  network,
  wallets,
  contacts,
  preferences,
  csrfToken,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "contacts" | "preferences" | "sessions";
  network: Network;
  wallets: MultisigWallet[];
  contacts: AddressBookContact[];
  preferences: AccountPreferences;
  csrfToken?: string;
  onSave: (changes: { contacts?: AddressBookContact[]; preferences?: AccountPreferences }) => Promise<void>;
}) {
  const [tab, setTab] = useState(initialTab);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [handle, setHandle] = useState("");
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);

  async function save(changes: { contacts?: AddressBookContact[]; preferences?: AccountPreferences }, success: string) {
    setSaving(true);
    try {
      await onSave(changes);
      toast.success(success);
      return true;
    } catch (error) {
      toast.error("Could not save", { description: userFacingError(error) });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addContact() {
    const nextAddress = address.trim();
    const prefix = network === "mainnet" ? "addr1" : "addr_test1";
    if (!label.trim() || !nextAddress.toLowerCase().startsWith(prefix)) {
      toast.error("Check the contact", { description: `Add a name and a valid ${network} payment address.` });
      return;
    }
    const timestamp = nowIso();
    const saved = await save({
      contacts: [...contacts, {
        id: createId("contact"),
        label: label.trim(),
        address: nextAddress,
        ...(handle.trim() ? { handle: handle.trim().replace(/^\$/, "") } : {}),
        network,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    }, "Contact saved");
    if (saved) {
      setLabel(""); setAddress(""); setHandle("");
    }
  }

  async function loadSessions() {
    if (!csrfToken) return;
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const response = await fetch("/api/account/sessions");
      const body = await response.json() as { ok?: boolean; error?: string; currentSessionId?: string; sessions?: SessionSummary[] };
      if (!response.ok || !body.ok) throw new Error(body.error || "Could not load devices.");
      setSessions(body.sessions || []);
      setCurrentSessionId(body.currentSessionId || "");
    } catch (error) {
      setSessionsError(userFacingError(error, "Could not load signed-in devices."));
    } finally {
      setSessionsLoading(false);
    }
  }

  useEffect(() => {
    if (open && tab === "sessions") void loadSessions();
  }, [open, tab]);

  async function revokeSession(id: string) {
    if (!csrfToken) return;
    setSaving(true);
    try {
      const response = await fetch("/api/account/sessions", { method: "POST", headers: { "content-type": "application/json", "x-cardano-multisig-csrf": csrfToken }, body: JSON.stringify({ intent: "revoke", sessionId: id }) });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error || "Could not revoke this session.");
      setSessions((current) => current.filter((session) => session.id !== id));
      toast.success("Device signed out");
    } catch (error) {
      toast.error("Could not sign out device", { description: userFacingError(error) });
    } finally {
      setSaving(false);
    }
  }

  async function toggleNotifications() {
    if (preferences.notificationsEnabled) {
      await save({ preferences: { ...preferences, notificationsEnabled: false } }, "Notifications disabled");
      return;
    }
    if (!("Notification" in window)) {
      toast.error("Notifications are not supported in this browser.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast.error("Notifications were not allowed", { description: "You can enable them later from the browser site settings." });
      return;
    }
    await save({ preferences: { ...preferences, notificationsEnabled: true } }, "Progress notifications enabled");
  }

  const preferredWalletValue = preferences.preferredWalletId && wallets.some((wallet) => wallet.id === preferences.preferredWalletId) ? preferences.preferredWalletId : "none";
  const sortedContacts = useMemo(() => [...contacts].sort((left, right) => left.label.localeCompare(right.label)), [contacts]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Account</DialogTitle><DialogDescription>Synced tools and preferences for this wallet account. No signing keys are stored.</DialogDescription></DialogHeader>
        <DialogBody>
          <Tabs value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
            <TabsList className="grid h-auto w-full grid-cols-3">
              <TabsTrigger value="contacts"><BookUser className="size-4" /> Contacts</TabsTrigger>
              <TabsTrigger value="preferences"><Settings2 className="size-4" /> Preferences</TabsTrigger>
              <TabsTrigger value="sessions"><Laptop className="size-4" /> Devices</TabsTrigger>
            </TabsList>
            <TabsContent value="contacts" className="mt-5 space-y-5">
              <div className="grid gap-3 rounded-xl border border-border bg-black/20 p-4 sm:grid-cols-2">
                <div className="space-y-2"><Label>Name</Label><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Treasury supplier" /></div>
                <div className="space-y-2"><Label>ADA Handle (optional)</Label><Input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="$handle" /></div>
                <div className="space-y-2 sm:col-span-2"><Label>Payment address</Label><Input value={address} onChange={(event) => setAddress(event.target.value)} placeholder={network === "mainnet" ? "addr1…" : "addr_test1…"} className="font-mono text-xs" /></div>
                <Button type="button" disabled={saving} onClick={() => void addContact()} className="sm:col-span-2"><Plus className="size-4" /> Add contact</Button>
              </div>
              <div className="grid gap-2">
                {sortedContacts.length ? sortedContacts.map((contact) => (
                  <div key={contact.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-black/20 p-3">
                    <BookUser className="size-4 shrink-0 text-sky-200" /><div className="min-w-0 flex-1"><div className="font-medium">{contact.label}</div><div className="truncate font-mono text-xs text-muted-foreground">{contact.handle ? `$${contact.handle.replace(/^\$/, "")} · ` : ""}{contact.address}</div></div>
                    <Button type="button" variant="ghost" size="icon" disabled={saving} aria-label={`Delete ${contact.label}`} onClick={() => void save({ contacts: contacts.filter((item) => item.id !== contact.id) }, "Contact removed")}><Trash2 className="size-4" /></Button>
                  </div>
                )) : <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">No saved contacts yet. Addresses are stored in your server-backed account, never in browser-only storage.</p>}
              </div>
            </TabsContent>
            <TabsContent value="preferences" className="mt-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-black/20 p-4">
                <div className="min-w-0"><div className="flex items-center gap-2 font-semibold">{preferences.notificationsEnabled ? <Bell className="size-4 text-emerald-300" /> : <BellOff className="size-4" />} Progress notifications</div><p className="mt-1 text-sm text-muted-foreground">Get a browser notification for new signatures, threshold reached, and submission while the app is open.</p></div>
                <Button type="button" variant={preferences.notificationsEnabled ? "secondary" : "default"} disabled={saving} onClick={() => void toggleNotifications()}>{preferences.notificationsEnabled ? "Disable" : "Enable"}</Button>
              </div>
              <div className="grid gap-4 rounded-xl border border-border bg-black/20 p-4 sm:grid-cols-2">
                <div className="space-y-2"><Label>Default transaction view</Label><Select value={preferences.defaultTransactionFilter} onValueChange={(value) => void save({ preferences: { ...preferences, defaultTransactionFilter: value as AccountPreferences["defaultTransactionFilter"] } }, "Default view updated")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="action">Action needed</SelectItem><SelectItem value="all">All transactions</SelectItem><SelectItem value="needs-you">Needs your signature</SelectItem><SelectItem value="waiting">Waiting</SelectItem><SelectItem value="ready">Ready to submit</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="archived">Archived</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label>Preferred wallet</Label><Select value={preferredWalletValue} onValueChange={(value) => void save({ preferences: { ...preferences, ...(value === "none" ? { preferredWalletId: undefined } : { preferredWalletId: value }) } }, "Preferred wallet updated")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No preference</SelectItem>{wallets.map((wallet) => <SelectItem key={wallet.id} value={wallet.id}>{wallet.handle ? `$${wallet.handle.replace(/^\$/, "")}` : wallet.name}</SelectItem>)}</SelectContent></Select></div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.06] p-4 text-sm text-emerald-100/80"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><p>Only public wallet policies, coordination state, contacts, and preferences are synced. Seed phrases and private signing keys are rejected by the server.</p></div>
            </TabsContent>
            <TabsContent value="sessions" className="mt-5 space-y-3">
              {sessionsLoading ? <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading signed-in devices…</div> : null}
              {sessionsError ? <ActionError message={sessionsError} onRetry={loadSessions} /> : null}
              {!sessionsLoading && !sessionsError ? sessions.map((session) => (
                <div key={session.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-black/20 p-4">
                  <Laptop className="size-5 shrink-0 text-sky-200" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2 font-medium">{deviceName(session.userAgent)} {session.id === currentSessionId ? <Badge variant="secondary">This device</Badge> : null}</div><div className="mt-1 text-xs text-muted-foreground">Last active {relativeTime(session.lastSeenAt)} · signed in {new Date(session.createdAt).toLocaleDateString()}</div></div>
                  {session.id !== currentSessionId ? <Button type="button" variant="secondary" size="sm" disabled={saving} onClick={() => void revokeSession(session.id)}>Sign out device</Button> : null}
                </div>
              )) : null}
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
