export type BrowserWalletApi = {
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getNetworkId(): Promise<number>;
  signTx(txCbor: string, partialSign?: boolean): Promise<string>;
  submitTx?(txCbor: string): Promise<string>;
};

export type BrowserWalletProvider<TApi extends BrowserWalletApi = BrowserWalletApi> = {
  id: string;
  name: string;
  icon?: string;
  enable(): Promise<TApi>;
};

type CardanoWindowWallet<TApi extends BrowserWalletApi = BrowserWalletApi> = {
  name?: string;
  icon?: string;
  enable?: () => Promise<TApi>;
  apiVersion?: string;
};

const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  eternl: "Eternl",
  lace: "Lace",
  nami: "Nami",
  flint: "Flint",
  gerowallet: "GeroWallet",
  typhoncip30: "Typhon",
  typhon: "Typhon",
  yoroi: "Yoroi",
  vespr: "VESPR",
  begin: "Begin",
  lacewallet: "Lace",
};

function prettyProviderName<TApi extends BrowserWalletApi>(id: string, wallet: CardanoWindowWallet<TApi>) {
  const explicit = wallet.name?.trim();
  if (explicit) {
    if (id.toLowerCase() === "lace" && explicit.toLowerCase() === "lace") return "Lace";
    if (id.toLowerCase() === "vespr") return "VESPR";
    return explicit;
  }
  return KNOWN_PROVIDER_NAMES[id.toLowerCase()] || id.charAt(0).toUpperCase() + id.slice(1);
}

export function installedBrowserWallets<TApi extends BrowserWalletApi = BrowserWalletApi>(): BrowserWalletProvider<TApi>[] {
  if (typeof window === "undefined") return [];
  const cardano = (window as Window & {
    cardano?: Record<string, CardanoWindowWallet<TApi>>;
  }).cardano;
  if (!cardano) return [];

  const ids = Reflect.ownKeys(cardano).filter((key): key is string => typeof key === "string");

  const seenWallets = new WeakSet<object>();
  const providers = ids
    .map((id) => {
      try {
        return [id, cardano[id]] as const;
      } catch {
        return [id, undefined] as const;
      }
    })
    .filter((entry): entry is readonly [string, CardanoWindowWallet<TApi>] => typeof entry[1]?.enable === "function")
    .filter(([, wallet]) => {
      if (typeof wallet !== "object" || wallet === null) return true;
      if (seenWallets.has(wallet)) return false;
      seenWallets.add(wallet);
      return true;
    })
    .map(([id, wallet]) => ({
      id,
      name: prettyProviderName(id, wallet),
      icon: wallet.icon,
      enable: wallet.enable!.bind(wallet),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const seen = new Set<string>();
  return providers.filter((provider) => {
    const key = `${provider.id.toLowerCase()}|${provider.name.toLowerCase()}|${provider.icon || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function watchInstalledBrowserWallets<TApi extends BrowserWalletApi = BrowserWalletApi>(
  callback: (providers: BrowserWalletProvider<TApi>[]) => void,
) {
  if (typeof window === "undefined") return () => {};

  const refresh = () => callback(installedBrowserWallets<TApi>());
  const timers = [0, 100, 300, 700, 1500, 3000, 6000].map((delay) => window.setTimeout(refresh, delay));
  const interval = window.setInterval(refresh, 2500);
  const stopInterval = window.setTimeout(() => window.clearInterval(interval), 15000);

  window.addEventListener("focus", refresh);
  window.addEventListener("visibilitychange", refresh);
  window.addEventListener("cardano#initialized", refresh);
  window.addEventListener("wallet#initialized", refresh);

  return () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    window.clearTimeout(stopInterval);
    window.clearInterval(interval);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("cardano#initialized", refresh);
    window.removeEventListener("wallet#initialized", refresh);
  };
}
