import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useOutletContext } from "react-router";
import { ListChecks, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { AppHeader, type AppHeaderAccountSession, type AppHeaderProviderStatus } from "./app-header";
import { Badge } from "./ui/badge";
import { Sidebar, SidebarContent, SidebarMenu, SidebarMenuBadge, SidebarMenuButton } from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { watchInstalledBrowserWallets, type BrowserWalletApi, type BrowserWalletProvider } from "../lib/browser-wallets";
import { LEGACY_STORAGE_KEY, STORAGE_KEY, TX_STORAGE_KEY, networkLabel, normalizeKeyHash, type MultisigWallet, type TxDraft } from "../lib/multisig";
import { persistableRelayDraft } from "../lib/relay-room";
import { cn, userFacingError } from "../lib/utils";

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
  connectWallet: (provider: WalletProvider) => Promise<ShellConnectedWallet | null>;
  disconnectWallet: () => void;
  refreshConnectedWallet: () => Promise<ShellConnectedWallet>;
  refreshServerState: () => Promise<{ wallets: MultisigWallet[]; transactions: TxDraft[]; updatedAt?: string } | null>;
  saveServerState: (state: { wallets: MultisigWallet[]; transactions: TxDraft[] }) => Promise<{ wallets: MultisigWallet[]; transactions: TxDraft[]; updatedAt?: string } | null>;
  signInConnectedWallet: () => Promise<void>;
  signOutAccount: () => Promise<void>;
  refreshAccount: () => Promise<void>;
};

function clearLocalSnapshot() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  window.localStorage.removeItem(TX_STORAGE_KEY);
}

function errorMessage(error: unknown, fallback: string) {
  return userFacingError(error, fallback);
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

function wait(milliseconds: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, attempts = 3) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === attempts - 1) return response;
      const retryAfterSeconds = Number(response.headers.get("retry-after") || "0");
      await wait(retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
      await wait(500 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Connection unavailable.");
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
    { label: "Wallets", href: "/wallets", icon: WalletCards, active: location.pathname === "/wallets" || location.pathname.startsWith("/wallets/"), count: walletCount },
    { label: "Transactions", href: "/transactions", icon: ListChecks, active: location.pathname === "/transactions" || location.pathname.startsWith("/transactions/"), count: roomCount },
  ];

  return (
    <TooltipProvider>
      <Sidebar aria-label="Primary" className="fixed bottom-4 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 md:bottom-auto md:left-4 md:top-1/2 md:w-16 md:max-w-none md:-translate-x-0 md:-translate-y-1/2 md:p-2 xl:left-6">
        <SidebarContent>
          <SidebarMenu className="grid-cols-2 md:flex md:flex-col">
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
  const accountRef = useRef(account);
  const accountStateRef = useRef(accountState);
  const saveQueueRef = useRef<Promise<NonNullable<AccountStateResponse["snapshot"]> | null>>(Promise.resolve(null));

  function applyServerSnapshot(body: AccountStateResponse) {
    if (!body.snapshot) return;
    const nextAccount = { authenticated: body.authenticated, network: body.network, session: body.session };
    accountRef.current = nextAccount;
    accountStateRef.current = body.snapshot;
    setAccount(nextAccount);
    setAccountState(body.snapshot);
    setWalletCount(body.snapshot.wallets.length);
    setRoomCount(body.snapshot.transactions.length);
    clearLocalSnapshot();
  }

  async function hydrateFromServer() {
    setAccountSyncState("hydrating");
    const response = await fetchWithRetry("/api/account/state");
    const body = (await response.json()) as AccountStateResponse;
    if (!response.ok || !body.ok || !body.snapshot) {
      setAccountSyncState("error");
      throw new Error(body.error || "We could not load your account. Please try again.");
    }
    applyServerSnapshot(body);
    setAccountSyncState("synced");
  }

  async function refreshAccount() {
    const response = await fetchWithRetry("/api/account/session");
    const body = (await response.json()) as AccountSessionResponse & { ok?: boolean; error?: string };
    const nextAccount = { authenticated: body.authenticated, network: body.network, session: body.session };
    accountRef.current = nextAccount;
    setAccount(nextAccount);
    if (body.authenticated) {
      accountStateRef.current = null;
      setAccountState(null);
      setAccountSyncState("hydrating");
      const stateResponse = await fetchWithRetry("/api/account/state");
      const stateBody = (await stateResponse.json()) as AccountStateResponse;
      if (!stateResponse.ok || !stateBody.ok || !stateBody.snapshot) {
        setAccountSyncState("error");
        throw new Error(stateBody.error || "We could not load your account. Please try again.");
      }
      applyServerSnapshot(stateBody);
      setAccountSyncState("synced");
    } else {
      accountStateRef.current = null;
      setAccountState(null);
      setAccountSyncState("idle");
      clearLocalSnapshot();
      setWalletCount(0);
      setRoomCount(0);
    }
  }

  async function refreshServerState() {
    if (!accountRef.current.authenticated) return null;
    setAccountSyncState("hydrating");
    const response = await fetchWithRetry("/api/account/state");
    const body = (await response.json()) as AccountStateResponse;
    if (!response.ok || !body.ok || !body.snapshot) {
      setAccountSyncState("error");
      throw new Error(body.error || "We could not refresh your account. Please try again.");
    }
    applyServerSnapshot(body);
    setAccountSyncState("synced");
    return body.snapshot;
  }

  async function saveServerState(state: { wallets: MultisigWallet[]; transactions: TxDraft[] }) {
    const run = async () => {
      const currentAccount = accountRef.current;
      const currentState = accountStateRef.current;
      if (!currentAccount.authenticated || !currentAccount.session || !currentState?.updatedAt) {
        throw new Error("Sign in and refresh your account before saving.");
      }
      setAccountSyncState("syncing");
      const persistableState = {
        wallets: state.wallets,
        transactions: state.transactions.map(persistableRelayDraft),
      };
      const response = await fetch("/api/account/state", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cardano-multisig-csrf": currentAccount.session.csrfToken,
        },
        body: JSON.stringify({ intent: "replace", baseUpdatedAt: currentState.updatedAt, ...persistableState }),
      });
      const body = (await response.json()) as AccountStateResponse;
      if (!response.ok || !body.ok || !body.snapshot) {
        const message = response.status === 429
          ? "Saving is temporarily paused. Wait a moment, then try again."
          : body.error || "We could not save your latest changes.";
        const conflict = response.status === 409 || message.includes("changed in another tab");
        if (conflict) {
          await refreshServerState().catch(() => undefined);
        } else {
          setAccountSyncState("error");
        }
        throw new Error(message);
      }
      applyServerSnapshot(body);
      setAccountSyncState("synced");
      return body.snapshot;
    };
    const queued = saveQueueRef.current.then(run, run);
    saveQueueRef.current = queued.catch(() => null);
    return queued;
  }

  useEffect(() => {
    const stopWatchingWallets = watchInstalledBrowserWallets(setProviders);
    fetchWithRetry("/api/cardano/provider", undefined, 2)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setProviderStatus(payload))
      .catch(() => setProviderStatus(null));
    void refreshAccount().catch(() => undefined);

    return () => {
      stopWatchingWallets();
    };
  }, []);

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
      const authenticatedAccount = { authenticated: true, network: verifyBody.network, session: verifyBody.session };
      accountRef.current = authenticatedAccount;
      setAccount(authenticatedAccount);
      await hydrateFromServer();
      toast.success("Signed in", {
        description: `Your wallets and transactions are ready on ${verifyBody.network}.`,
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
    const signedOutAccount = { authenticated: false, network: accountRef.current.network, session: null };
    accountRef.current = signedOutAccount;
    accountStateRef.current = null;
    setAccount(signedOutAccount);
    setAccountState(null);
    setAccountSyncState("idle");
    clearLocalSnapshot();
    setWalletCount(0);
    setRoomCount(0);
    toast("Signed out");
  }

  function disconnectWallet() {
    setConnected(null);
    toast("Wallet disconnected");
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

  const signerWalletCount = useMemo(() => {
    const connectedKeyHash = normalizeKeyHash(connected?.keyHash || "");
    if (!connectedKeyHash || !accountState) return 0;
    return accountState.wallets.filter((wallet) =>
      wallet.signers.some((signer) => normalizeKeyHash(signer.keyHash) === connectedKeyHash),
    ).length;
  }, [accountState, connected?.keyHash]);

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
    connectWallet,
    disconnectWallet,
    refreshConnectedWallet,
    refreshServerState,
    saveServerState,
    signInConnectedWallet,
    signOutAccount,
    refreshAccount,
  };

  return (
    <>
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
        signerWalletCount={signerWalletCount}
        onConnect={(provider) => void connectWallet(provider)}
        onDisconnect={disconnectWallet}
        onSignIn={() => void signInConnectedWallet()}
        onSignOut={() => void signOutAccount()}
      />
      <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 overflow-x-hidden px-3 pb-24 pt-20 text-foreground sm:gap-6 sm:px-6 md:pb-6 md:pl-24 lg:px-8 xl:pl-28">
        <Outlet context={context} />
      </main>
    </>
  );
}
