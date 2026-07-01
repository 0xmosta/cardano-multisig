import { useEffect, useState } from "react";
import { Link, Outlet, useLocation, useOutletContext } from "react-router";
import { Home, ListChecks, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { AppHeader, type AppHeaderProviderStatus } from "./app-header";
import { Badge } from "./ui/badge";
import { watchInstalledBrowserWallets, type BrowserWalletApi, type BrowserWalletProvider } from "../lib/browser-wallets";
import { STORAGE_KEY, TX_STORAGE_KEY, networkLabel } from "../lib/multisig";
import { cn } from "../lib/utils";

type WalletProvider = BrowserWalletProvider<BrowserWalletApi>;

export type ShellConnectedWallet = {
  id: string;
  name: string;
  api: BrowserWalletApi;
  networkId: number;
  addressHex: string;
  keyHash: string | null;
};

export type AppShellContext = {
  providers: WalletProvider[];
  connected: ShellConnectedWallet | null;
  connectingId: string | null;
  providerStatus: AppHeaderProviderStatus;
  walletCount: number;
  roomCount: number;
  connectWallet: (provider: WalletProvider) => Promise<ShellConnectedWallet | null>;
  disconnectWallet: () => void;
  refreshConnectedWallet: () => Promise<ShellConnectedWallet>;
  refreshCounts: () => void;
};

const STORAGE_EVENT = "cardano-multisig:storage";

export function notifyAppStorageChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STORAGE_EVENT));
}

function readStoredCount(key: string) {
  if (typeof window === "undefined") return 0;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
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

  return { id: provider.id, name: provider.name, api, networkId, addressHex, keyHash };
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
    <nav aria-label="Primary" className="fixed bottom-4 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-white/10 bg-[#18181b]/95 p-1 shadow-2xl shadow-black/50 backdrop-blur md:bottom-auto md:left-4 md:top-1/2 md:w-16 md:max-w-none md:-translate-x-0 md:-translate-y-1/2 md:p-2 xl:left-6">
      <div className="grid grid-cols-3 gap-1 md:flex md:flex-col">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              to={item.href}
              title={item.label}
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "group relative flex h-12 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-zinc-400 transition hover:bg-white/8 hover:text-zinc-50 md:w-12 md:px-0",
                item.active ? "bg-zinc-50 text-zinc-950 shadow-sm hover:bg-zinc-50 hover:text-zinc-950" : "",
              )}
            >
              <Icon className="size-5 shrink-0" />
              <span className="truncate md:sr-only">{item.label}</span>
              {typeof item.count === "number" ? (
                <Badge
                  variant={item.active ? "secondary" : "outline"}
                  className={cn(
                    "h-5 min-w-5 px-1 text-[10px] md:absolute md:-right-1 md:-top-1",
                    item.active ? "bg-zinc-900 text-zinc-50" : "border-white/10 bg-[#202124] text-zinc-300",
                  )}
                >
                  {item.count}
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell() {
  const [providers, setProviders] = useState<WalletProvider[]>([]);
  const [connected, setConnected] = useState<ShellConnectedWallet | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [providerStatus, setProviderStatus] = useState<AppHeaderProviderStatus>(null);
  const [walletCount, setWalletCount] = useState(0);
  const [roomCount, setRoomCount] = useState(0);

  function refreshCounts() {
    setWalletCount(readStoredCount(STORAGE_KEY));
    setRoomCount(readStoredCount(TX_STORAGE_KEY));
  }

  useEffect(() => {
    refreshCounts();
    const stopWatchingWallets = watchInstalledBrowserWallets(setProviders);
    fetch("/api/cardano/provider")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => setProviderStatus(payload))
      .catch(() => setProviderStatus(null));

    window.addEventListener("storage", refreshCounts);
    window.addEventListener(STORAGE_EVENT, refreshCounts);
    window.addEventListener("focus", refreshCounts);

    return () => {
      stopWatchingWallets();
      window.removeEventListener("storage", refreshCounts);
      window.removeEventListener(STORAGE_EVENT, refreshCounts);
      window.removeEventListener("focus", refreshCounts);
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

  function disconnectWallet() {
    setConnected(null);
    toast("Wallet disconnected");
  }

  const context: AppShellContext = {
    providers,
    connected,
    connectingId,
    providerStatus,
    walletCount,
    roomCount,
    connectWallet,
    disconnectWallet,
    refreshConnectedWallet,
    refreshCounts,
  };

  return (
    <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 overflow-x-hidden px-4 pb-24 pt-6 text-zinc-100 sm:px-6 md:pb-6 md:pl-24 lg:px-8 xl:pl-28">
      <AppSidebar walletCount={walletCount} roomCount={roomCount} />
      <AppHeader
        providers={providers}
        connected={connected ? { id: connected.id, name: connected.name, networkLabel: networkLabel(connected.networkId), keyHash: connected.keyHash } : null}
        connectingId={connectingId}
        providerStatus={providerStatus}
        walletCount={walletCount}
        roomCount={roomCount}
        onConnect={(provider) => void connectWallet(provider)}
        onDisconnect={disconnectWallet}
      />
      <Outlet context={context} />
    </main>
  );
}
