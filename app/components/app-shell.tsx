import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useOutletContext } from "react-router";
import { Home, ListChecks, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { AppHeader, type AppHeaderAccountSession, type AppHeaderProviderStatus } from "./app-header";
import { Badge } from "./ui/badge";
import { Sidebar, SidebarContent, SidebarMenu, SidebarMenuBadge, SidebarMenuButton } from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { watchInstalledBrowserWallets, type BrowserWalletApi, type BrowserWalletProvider } from "../lib/browser-wallets";
import { STORAGE_KEY, TX_STORAGE_KEY, networkLabel, type MultisigWallet, type TxDraft } from "../lib/multisig";
import { cn } from "../lib/utils";

type WalletProvider = BrowserWalletProvider<BrowserWalletApi>;

type AccountIdentity = {
  kind: "payment" | "stake";
  keyHash: string;
  addressHex: string;
};

type AccountSession = {
  subject: string;
  csrfToken: string;
  identity: AccountIdentity;
  walletCount: number;
  transactionCount: number;
};

type AccountSessionResponse = {
  authenticated: boolean;
  network: string;
  session: AccountSession | null;
};

type AccountStateResponse = AccountSessionResponse & {
  ok: boolean;
  snapshot?: {
    wallets: MultisigWallet[];
    transactions: TxDraft[];
    updatedAt?: string;
  };
  error?: string;
};

export type ShellConnectedWallet = {
  id: string;
  name: string;
  api: BrowserWalletApi;
  networkId: number;
  addressHex: string;
  rewardAddressHex: string | null;
  keyHash: string | null;
};

export type AppShellContext = {
  providers: WalletProvider[];
  connected: ShellConnectedWallet | null;
  connectingId: string | null;
  providerStatus: AppHeaderProviderStatus;
  walletCount: number;
  roomCount: number;
  account: AccountSessionResponse;
  accountState: { wallets: MultisigWallet[]; transactions: TxDraft[]; updatedAt?: string } | null;
  accountSyncState: "idle" | "authenticating" | "hydrating" | "syncing" | "synced" | "error";
  migrationCounts: { wallets: number; transactions: number; available: boolean };
  connectWallet: (provider: WalletProvider) => Promise<ShellConnectedWallet | null>;
  disconnectWallet: () => void;
  refreshConnectedWallet: () => Promise<ShellConnectedWallet>;
  refreshCounts: () => void;
  refreshServerState: () => Promise<{ wallets: MultisigWallet[]; transactions: TxDraft[]; updatedAt?: string } | null>;
  saveServerState: (state: { wallets: MultisigWallet[]; transactions: TxDraft[] }) => Promise<{ wallets: MultisigWallet[]; transactions: TxDraft[]; updatedAt?: string } | null>;
  signInConnectedWallet: () => Promise<void>;
  signOutAccount: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  importLocalState: () => Promise<void>;
};

const STORAGE_EVENT = "cardano-multisig:storage";

export function notifyAppStorageChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_EVENT));
}

function readStoredArray<T>(key: string) {
  if (typeof window === "undefined") return [] as T[];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [] as T[];
  }
}

function readStoredCount(key: string) {
  return readStoredArray(key).length;
}

function readLocalSnapshot() {
  return {
    wallets: readStoredArray<MultisigWallet>(STORAGE_KEY),
    transactions: readStoredArray<TxDraft>(TX_STORAGE_KEY),
  };
}

function writeLocalSnapshot(snapshot: { wallets: MultisigWallet[]; transactions: TxDraft[] }) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot.wallets || [], null, 2));
  window.localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(snapshot.transactions || [], null, 2));
  notifyAppStorageChanged();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

async function keyHashFromAddress(addressHex: string): Promise<string | null> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser");
    const address = CSL.Address.from_bytes(hexToBytes(addressHex));
    const base = CSL.BaseAddress.from_address(address);
    const enterprise = CSL.EnterpriseAddress.from_address(address);
    const reward = CSL.RewardAddress.from_address(address);
    const credential = base?.payment_cred() ?? enterprise?.payment_cred() ?? reward?.payment_cred();
    const keyHash = credential?.to_keyhash();
    return keyHash ? keyHash.to_hex() : null;
  } catch {
    return null;
  }
}

async function inspectWallet(provider: WalletProvider, api: BrowserWalletApi): Promise<ShellConnectedWallet> {
  let networkId = -1;
  let addressHex = "";
  let rewardAddressHex: string | null = null;
  let keyHash: string | null = null;

  try {
    networkId = await withTimeout(api.getNetworkId(), 5000, "Network lookup timed out.");
  } catch {
    networkId = -1;
  }

  try {
    const used = await withTimeout(api.getUsedAddresses(), 5000, "Address lookup timed out.");
    const unused = used.length ? [] : await withTimeout(api.getUnusedAddresses(), 5000, "Unused address lookup timed out.");
    addressHex = used[0] || unused[0] || (await withTimeout(api.getChangeAddress(), 5000, "Change address lookup timed out."));
    keyHash = addressHex ? await keyHashFromAddress(addressHex) : null;
  } catch {
    addressHex = "";
    keyHash = null;
  }

  try {
    if (api.getRewardAddresses) {
      const rewards = await withTimeout(api.getRewardAddresses(), 5000, "Reward address lookup timed out.");
      rewardAddressHex = rewards[0] || null;
    }
  } catch {
    rewardAddressHex = null;
  }

  return { id: provider.id, name: provider.name, api, networkId, addressHex, rewardAddressHex, keyHash };
}

function networkForWallet(connected: ShellConnectedWallet | null, providerStatus: AppHeaderProviderStatus) {
  if (providerStatus?.network) return providerStatus.network;
  if (connected?.networkId === 1) return "mainnet";
  return "preprod";
}

export function useAppShell() {
  return useOutletContext<AppShellContext>();
}

function AppSidebar({ walletCount, roomCount }: { walletCount: number; roomCount: number }) {
  const location = useLocation();
  const items = [
    { label: "Home", href: "/", icon: Home, active: location.pathname === "/" },
    { label: "Wallets", href: "/wallets", icon: WalletCards, active: location.pathname === "/wallets" || location.pathname.startsWith("/wallets/"), count: walletCount },
    { label: "Transactions", href: "/transactions", icon: ListChecks, active: location.pathname === "/transactions", count: roomCount },
  ];

  return (
    <TooltipProvider>
      <Sidebar aria-label="Primary" className="fixed bottom-4 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 md:bottom-auto md:left-4 md:top-1/2 md:w-16 md:max-w-none md:-translate-x-0 md:-translate-y-1/2 md:p-2 xl:left-6">
        <SidebarContent>
          <SidebarMenu className="grid-cols-3 md:flex md:flex-col">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      asChild
                      aria-current={item.active ? "page" : undefined}
                      className={cn(
                        "md:w-12 md:px-0",
                        item.active ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm hover:bg-sidebar-primary hover:text-sidebar-primary-foreground" : "",
                      )}
                    >
                      <Link to={item.href}>
                        <Icon className="size-5 shrink-0" />
                        <span className="truncate md:sr-only">{item.label}</span>
                        {typeof item.count === "number" ? (
                          <SidebarMenuBadge>
                            <Badge
                              variant={item.active ? "secondary" : "outline"}
                              className={cn(
                                "h-5 min-w-5 px-1 text-[10px]",
                                item.active ? "bg-secondary text-secondary-foreground" : "bg-sidebar text-sidebar-foreground",
                              )}
                            >
                              {item.count}
                            </Badge>
                          </SidebarMenuBadge>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="hidden md:block">{item.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
    </TooltipProvider>
  );
}

export function AppShell() {
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [connected, setConnected] = useState<ShellConnectedWallet | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<AppHeaderProviderStatus>(null);
  const [walletCount, setWalletCount] = useState(0);
  const [roomCount, setRoomCount] = useState(0);
  const [account, setAccount] = useState<AccountSessionResponse>({ authenticated: false, network: "preprod", session: null });
  const [accountState, setAccountState] = useState<NonNullable<AccountStateResponse["snapshot"]> | null>(null);
  const [accountSyncState, setAccountSyncState] = useState<AppShellContext["accountSyncState"]>("idle");
  const [migrationCounts, setMigrationCounts] = useState({ wallets: 0, transactions: 0, available: false });
  const skipNextSyncRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);

  function refreshCounts() {
    if (account.authenticated && accountState) {
      setWalletCount(accountState.wallets.length);
      setRoomCount(accountState.transactions.length);
    } else {
      setWalletCount(readStoredCount(STORAGE_KEY));
      setRoomCount(readStoredCount(TX_STORAGE_KEY));
    }
    const local = readLocalSnapshot();
    setMigrationCounts({
      wallets: local.wallets.length,
      transactions: local.transactions.length,
      available: local.wallets.length > 0 || local.transactions.length > 0,
    });
  }

  async function hydrateFromServer(options: { preserveLocalIfServerEmpty?: boolean } = {}) {
    if (!account.authenticated) return;
    setAccountSyncState("hydrating");
    const response = await fetch("/api/account/state");
    const body = (await response.json()) as AccountStateResponse;
    if (!response.ok || !body.ok || !body.snapshot) {
      setAccountSyncState("error");
      throw new Error(body.error || "Could not load authenticated account state.");
    }
    setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
    setAccountState(body.snapshot || null);
    const serverHasState = (body.snapshot.wallets.length || body.snapshot.transactions.length) > 0;
    const local = readLocalSnapshot();
    const preserveLocal = options.preserveLocalIfServerEmpty && !serverHasState && (local.wallets.length || local.transactions.length);
    if (!preserveLocal) {
      skipNextSyncRef.current = true;
      writeLocalSnapshot(body.snapshot);
    }
    refreshCounts();
    setAccountSyncState("synced");
  }

  async function refreshAccount() {
    const response = await fetch("/api/account/session");
    const body = (await response.json()) as AccountSessionResponse & { ok?: boolean; error?: string };
    setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
    if (body.authenticated) {
      await hydrateFromServer({ preserveLocalIfServerEmpty: true });
    } else {
      setAccountState(null);
      setAccountSyncState("idle");
    }
  }

  async function refreshServerState() {
    if (!account.authenticated) return null;
    setAccountSyncState("hydrating");
    const response = await fetch("/api/account/state");
    const body = (await response.json()) as AccountStateResponse;
    if (!response.ok || !body.ok || !body.snapshot) {
      setAccountSyncState("error");
      throw new Error(body.error || "Could not load authenticated account state.");
    }
    setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
    setAccountState(body.snapshot);
    refreshCounts();
    setAccountSyncState("synced");
    return body.snapshot;
  }

  async function saveServerState(state: { wallets: MultisigWallet[]; transactions: TxDraft[] }) {
    if (!account.authenticated || !account.session) return null;
    setAccountSyncState("syncing");
    const response = await fetch("/api/account/state", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cardano-multisig-csrf": account.session.csrfToken,
      },
      body: JSON.stringify({ intent: "replace", ...state }),
    });
    const body = (await response.json()) as AccountStateResponse;
    if (!response.ok || !body.ok || !body.snapshot) {
      setAccountSyncState("error");
      throw new Error(body.error || "Could not save authenticated account state.");
    }
    setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
    setAccountState(body.snapshot);
    skipNextSyncRef.current = true;
    writeLocalSnapshot(body.snapshot);
    refreshCounts();
    setAccountSyncState("synced");
    return body.snapshot;
  }

  function scheduleServerSync(source: "storage" | "manual" = "storage") {
    if (!account.authenticated || !account.session) return;
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    const local = readLocalSnapshot();
    if (!local.wallets.length && !local.transactions.length && ((account.session.walletCount || 0) > 0 || (account.session.transactionCount || 0) > 0)) {
      void hydrateFromServer().catch(() => undefined);
      return;
    }
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(async () => {
      try {
        setAccountSyncState("syncing");
        const response = await fetch("/api/account/state", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cardano-multisig-csrf": account.session?.csrfToken || "",
          },
          body: JSON.stringify({ intent: "replace", ...local }),
        });
        const body = (await response.json()) as AccountStateResponse;
        if (!response.ok || !body.ok) {
          throw new Error(body.error || `Could not sync authenticated account state from ${source}.`);
        }
        setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
        setAccountState(body.snapshot || null);
        refreshCounts();
        setAccountSyncState("synced");
      } catch (error) {
        setAccountSyncState("error");
        toast.error("Could not sync account state", { description: errorMessage(error, "The server copy was not updated.") });
      }
    }, 300);
  }

  useEffect(() => {
    refreshCounts();
    const stopWatchingWallets = watchInstalledBrowserWallets(setProviders);
    fetch("/api/cardano/provider")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setProviderStatus(payload))
      .catch(() => setProviderStatus(null));
    void refreshAccount().catch(() => undefined);

    const onStorageChange = () => {
      refreshCounts();
      scheduleServerSync("storage");
    };

    window.addEventListener("storage", onStorageChange);
    window.addEventListener(STORAGE_EVENT, onStorageChange);
    window.addEventListener("focus", onStorageChange);

    return () => {
      stopWatchingWallets();
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
      window.removeEventListener("storage", onStorageChange);
      window.removeEventListener(STORAGE_EVENT, onStorageChange);
      window.removeEventListener("focus", onStorageChange);
    };
  }, [account.authenticated, account.session?.csrfToken, account.session?.walletCount, account.session?.transactionCount]);

  async function connectWallet(provider: WalletProvider) {
    if (connectingId) return null;
    setConnectingId(provider.id);
    try {
      const api = await withTimeout(
        provider.enable(),
        12000,
        `${provider.name} did not answer. Unlock the wallet popup, then try again.`,
      );
      const next = await inspectWallet(provider, api);
      setConnected(next);
      toast.success("Wallet connected", {
        description: `${next.name} · ${networkLabel(next.networkId)}`,
      });
      return next;
    } catch (error) {
      toast.error("Could not connect wallet", {
        description: errorMessage(error, "Unlock the wallet popup, then try again."),
      });
      return null;
    } finally {
      setConnectingId(null);
    }
  }

  async function refreshConnectedWallet() {
    if (!connected) throw new Error("Connect Lace, Eternl, or VESPR first.");
    const provider = providers.find((item) => item.id === connected.id) ?? {
      id: connected.id,
      name: connected.name,
      enable: () => Promise.resolve(connected.api),
    };
    const next = await inspectWallet(provider, connected.api);
    setConnected(next);
    return next;
  }

  async function signInConnectedWallet() {
    if (!connected) throw new Error("Connect a wallet first.");
    if (!connected.api.signData) throw new Error(`${connected.name} does not expose CIP-30 signData in this browser session.`);
    setAccountSyncState("authenticating");
    try {
      const refreshed = await refreshConnectedWallet();
      const signData = refreshed.api.signData;
      if (!signData) throw new Error(`${refreshed.name} does not expose CIP-30 signData in this browser session.`);
      const addressHex = refreshed.rewardAddressHex || refreshed.addressHex;
      if (!addressHex) throw new Error("Could not derive a wallet address for signData auth.");
      const challengeResponse = await fetch("/api/account/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: "challenge",
          network: networkForWallet(refreshed, providerStatus),
          addressHex: refreshed.addressHex,
          rewardAddressHex: refreshed.rewardAddressHex || undefined,
        }),
      });
      const challengeBody = (await challengeResponse.json()) as { ok: boolean; error?: string; challengeId?: string; challengeHex?: string };
      if (!challengeResponse.ok || !challengeBody.ok || !challengeBody.challengeId || !challengeBody.challengeHex) {
        throw new Error(challengeBody.error || "Could not start wallet auth.");
      }
      const signature = await signData(addressHex, challengeBody.challengeHex);
      const verifyResponse = await fetch("/api/account/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: "verify",
          challengeId: challengeBody.challengeId,
          network: networkForWallet(refreshed, providerStatus),
          addressHex: refreshed.addressHex,
          rewardAddressHex: refreshed.rewardAddressHex || undefined,
          signature: signature.signature,
          key: signature.key,
        }),
      });
      const verifyBody = (await verifyResponse.json()) as AccountSessionResponse & { ok?: boolean; error?: string };
      if (!verifyResponse.ok || verifyBody.authenticated !== true || !verifyBody.session) {
        throw new Error(verifyBody.error || "Wallet auth verification failed.");
      }
      setAccount({ authenticated: true, network: verifyBody.network, session: verifyBody.session });
      await hydrateFromServer({ preserveLocalIfServerEmpty: true });
      toast.success("Authenticated account ready", {
        description: `${refreshed.name} signed a ${verifyBody.session.identity.kind} challenge for ${verifyBody.network}.`,
      });
    } catch (error) {
      setAccountSyncState("error");
      toast.error("Could not sign in", {
        description: errorMessage(error, "Wallet authentication failed."),
      });
      throw error;
    }
  }

  async function signOutAccount() {
    await fetch("/api/account/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "logout" }),
    }).catch(() => undefined);
    setAccount({ authenticated: false, network: account.network, session: null });
    setAccountState(null);
    setAccountSyncState("idle");
    toast("Authenticated account signed out");
  }

  function disconnectWallet() {
    setConnected(null);
    toast("Wallet disconnected");
  }

  async function importLocalState() {
    if (!account.authenticated || !account.session) throw new Error("Sign in with a wallet first.");
    try {
      setAccountSyncState("syncing");
      const local = readLocalSnapshot();
      const response = await fetch("/api/account/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cardano-multisig-csrf": account.session.csrfToken,
        },
        body: JSON.stringify({ intent: "import", ...local }),
      });
      const body = (await response.json()) as AccountStateResponse;
      if (!response.ok || !body.ok || !body.snapshot) {
        throw new Error(body.error || "Could not import local wallets and transactions.");
      }
      setAccount({ authenticated: body.authenticated, network: body.network, session: body.session });
      setAccountState(body.snapshot);
      skipNextSyncRef.current = true;
      writeLocalSnapshot(body.snapshot);
      refreshCounts();
      setAccountSyncState("synced");
      toast.success("Local data imported", {
        description: `${body.snapshot.wallets.length} wallets and ${body.snapshot.transactions.length} transactions are now backed by the server.`,
      });
    } catch (error) {
      setAccountSyncState("error");
      toast.error("Could not import local data", {
        description: errorMessage(error, "The authenticated account was not updated."),
      });
      throw error;
    }
  }

  const headerAccount = useMemo<AppHeaderAccountSession>(() => {
    if (!account.authenticated || !account.session) return null;
    return {
      subject: account.session.subject,
      identityKind: account.session.identity.kind,
      keyHash: account.session.identity.keyHash,
      network: account.network,
    };
  }, [account]);

  const context: AppShellContext = {
    providers,
    connected,
    connectingId,
    providerStatus,
    walletCount,
    roomCount,
    account,
    accountState,
    accountSyncState,
    migrationCounts,
    connectWallet,
    disconnectWallet,
    refreshConnectedWallet,
    refreshCounts,
    refreshServerState,
    saveServerState,
    signInConnectedWallet,
    signOutAccount,
    refreshAccount,
    importLocalState,
  };

  return (
    <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 overflow-x-hidden px-4 pb-24 pt-6 text-foreground sm:px-6 md:pb-6 md:pl-24 lg:px-8 xl:pl-28">
      <AppSidebar walletCount={walletCount} roomCount={roomCount} />
      <AppHeader
        providers={providers}
        connected={connected ? { id: connected.id, name: connected.name, networkLabel: networkLabel(connected.networkId), keyHash: connected.keyHash } : null}
        account={headerAccount}
        accountSyncState={accountSyncState}
        connectingId={connectingId}
        providerStatus={providerStatus}
        walletCount={walletCount}
        roomCount={roomCount}
        onConnect={(provider) => void connectWallet(provider)}
        onDisconnect={disconnectWallet}
        onSignIn={() => void signInConnectedWallet()}
        onSignOut={() => void signOutAccount()}
      />
      <Outlet context={context} />
    </main>
  );
}
