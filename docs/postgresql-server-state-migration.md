# PostgreSQL server-state migration

This repo now supports PostgreSQL-backed persistence for:
- authenticated account identities, sessions, and wallet-auth challenges
- server account wallet snapshots and transaction drafts
- relay rooms, signer progress, witness records, and submission tx hashes
- account audit events

Development fallback
- If `DATABASE_URL` is unset, the app keeps using `CARDANO_MULTISIG_DATA_DIR` JSON files only when `NODE_ENV != production` and the configured network is not `mainnet`.
- Set `CARDANO_MULTISIG_ALLOW_FILE_STORE=1` only for intentional local fallback or one-off recovery work.
- Preprod/mainnet runtime should set `DATABASE_URL` and `CARDANO_MULTISIG_SESSION_SECRET`.

Apply schema
```bash
npm run db:migrate
```

Import existing file-backed state
```bash
CARDANO_MULTISIG_DATA_DIR=./data/cardano-multisig \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/cardano_multisig \
npm run db:import-file-store
```

Smoke test against PostgreSQL
```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/cardano_multisig \
CARDANO_MULTISIG_SESSION_SECRET=local-dev-secret \
CARDANO_NETWORK=preprod \
VITE_CARDANO_NETWORK=preprod \
npm run smoke:postgres
```

Suggested rollout
1. Back up the existing `CARDANO_MULTISIG_DATA_DIR` directory.
2. Provision PostgreSQL and set `DATABASE_URL` / `CARDANO_MULTISIG_SESSION_SECRET`.
3. Run `npm run db:migrate`.
4. If migrating existing state, run `npm run db:import-file-store` once.
5. Run `npm run smoke:postgres`, then `npm run typecheck` and `npm run build`.
6. Deploy application code. Keep the file-store backup until preprod verification confirms account/session and relay-room continuity.

Notes
- The app keeps network-scoped state; do not mix preprod/mainnet rows in one deploy without matching `CARDANO_NETWORK`.
- `MIGRATION_DATABASE_URL` can target an admin connection for schema apply while runtime keeps a narrower `DATABASE_URL`.
- The smoke script exercises session creation, account snapshot persistence, relay-room creation, and submission hash round-trip directly against the store layer.
