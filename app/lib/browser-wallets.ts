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
};

function prettyProviderName(id: string, wallet: CardanoWindowWallet) {
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

  return Object.entries(cardano)
    .filter(([, wallet]) => typeof wallet?.enable === "function")
    .map(([id, wallet]) => ({
      id,
      name: prettyProviderName(id, wallet),
      icon: wallet.icon,
      enable: wallet.enable!.bind(wallet),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
