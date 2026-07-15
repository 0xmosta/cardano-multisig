import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("api/account/session", "routes/api.account.session.ts"),
  route("api/account/sessions", "routes/api.account.sessions.ts"),
  route("api/account/state", "routes/api.account.state.ts"),
  route("api/cardano/provider", "routes/api.cardano.provider.ts"),
  route("api/cardano/assets", "routes/api.cardano.assets.ts"),
  route("api/cardano/signer-handles", "routes/api.cardano.signer-handles.ts"),
  route("api/cardano/build-tx", "routes/api.cardano.build-tx.ts"),
  route("api/cardano/relay-room", "routes/api.cardano.relay-room.ts"),
  route("api/cardano/submit", "routes/api.cardano.submit.ts"),
  route("wallets", "routes/wallets.tsx"),
  route("transactions", "routes/transactions.tsx"),
  route("transactions/:transactionId", "routes/transaction-detail.tsx"),
  route("sign", "routes/home.tsx"),
  route("wallets/import", "routes/wallet-import.tsx"),
  route("wallets/:walletId", "routes/wallet-detail.tsx"),
  route("wallets/:walletId/transactions/new", "routes/transaction-new.tsx"),
] satisfies RouteConfig;
