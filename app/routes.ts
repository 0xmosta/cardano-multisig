import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/cardano/provider", "routes/api.cardano.provider.ts"),
  route("wallets/:walletId", "routes/wallet-detail.tsx"),
  route("wallets/:walletId/transactions/new", "routes/transaction-new.tsx"),
] satisfies RouteConfig;
