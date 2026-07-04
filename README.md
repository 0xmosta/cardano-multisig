# Cardano Multisig

Cardano Multisig is a self-hosted coordinator for Cardano native-script multisig wallets. It helps a coordinator import or create a multisig policy, build a transaction, share signing links, collect CIP-30 wallet witnesses, and submit the completed transaction.

The project is built with React Router, React, TypeScript, Tailwind CSS, PostgreSQL, and Cardano browser wallet APIs.

## What it does

- Import Cardano native-script multisig wallets from CBOR, JSON, wallet exports, addresses, or ADA Handles where supported.
- Create M-of-N payment native scripts from signer payment key hashes.
- Connect CIP-30 browser wallets such as Lace, Eternl, VESPR, and compatible wallets exposed through `window.cardano`.
- Build unsigned transactions with server-managed Cardano provider configuration.
- Create relay rooms with private capability-token invite links for signers.
- Let signers review and sign unsigned transaction CBOR with `wallet.signTx(..., true)`.
- Verify witness packages against the unsigned transaction and policy signer key hashes.
- Track required signatures, optional unsigned signers, pending signers, and submitted transaction hashes.
- Store account state and relay rooms in PostgreSQL for deployed environments, with a file-backed development fallback.

## Safety model

This app coordinates signatures; it does not replace independent transaction review.

- Invite links contain capability tokens. Share them only with intended signers.
- Unsigned transaction CBOR, addresses, assets, and signer key hashes should be verified before signing.
- Start on `preprod` or `preview` and complete a small test transaction before using mainnet value.
- Mainnet relay rooms are disabled unless `CARDANO_MULTISIG_ENABLE_MAINNET_RELAY=1` is set.
- Server-side secrets such as `BLOCKFROST_PROJECT_ID`, `DATABASE_URL`, and `CARDANO_MULTISIG_SESSION_SECRET` must never be exposed to browser code.

## Requirements

- Node.js 22 or newer
- npm
- A CIP-30 compatible Cardano browser wallet for manual signing flows
- PostgreSQL for production-like deployments
- One Cardano provider setup:
  - Blockfrost via `BLOCKFROST_PROJECT_ID`
  - or self-hosted Kupo/Ogmios/Cardano submit endpoints

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open the local URL printed by React Router, usually `http://localhost:5173`.

For a local-only development run, PostgreSQL is optional. If `DATABASE_URL` is unset, the app uses file-backed storage under `CARDANO_MULTISIG_DATA_DIR` when not running in production and not configured for mainnet.

## Environment

Minimal preprod-style configuration:

```bash
CARDANO_NETWORK=preprod
VITE_CARDANO_NETWORK=preprod
BLOCKFROST_PROJECT_ID=your_blockfrost_project_id
CARDANO_MULTISIG_SESSION_SECRET=replace_with_a_long_random_secret
```

Production-like deployments should also set:

```bash
DATABASE_URL=postgres://user:password@host:5432/cardano_multisig
CARDANO_MULTISIG_PUBLIC_ORIGIN=https://your-domain.example
```

Session cookies are marked `Secure` automatically in production or when `CARDANO_MULTISIG_PUBLIC_ORIGIN` uses HTTPS. For local HTTP-only testing, leave `NODE_ENV` unset or set `CARDANO_MULTISIG_COOKIE_SECURE=0`.

Optional provider overrides:

```bash
BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api/v0
CARDANO_KUPO_URL=
CARDANO_OGMIOS_URL=
CARDANO_SUBMIT_URL=
```

## Cardano provider modes

The app can run with either Blockfrost or a self-hosted Cardano stack.

Blockfrost mode:

```bash
BLOCKFROST_PROJECT_ID=your_blockfrost_project_id
BLOCKFROST_URL=https://cardano-preprod.blockfrost.io/api/v0
```

Self-hosted mode:

```bash
CARDANO_KUPO_URL=http://kupo:1442
CARDANO_OGMIOS_URL=ws://ogmios:1337
CARDANO_SUBMIT_URL=http://cardano-submit-api:8090/api/submit/tx
```

`CARDANO_KUPO_URL` is used for UTxO and asset lookup, `CARDANO_OGMIOS_URL` is used for protocol parameters and can submit signed transactions, and `CARDANO_SUBMIT_URL` can point at a compatible Cardano submit API. A raw `cardano-node` socket by itself is not enough; expose the node through Kupo/Ogmios and, optionally, cardano-submit-api.

See [.env.example](.env.example) for the full list.

## Database setup

Apply PostgreSQL migrations:

```bash
npm run db:migrate
```

Run the PostgreSQL store smoke test:

```bash
npm run smoke:postgres
```

Existing file-backed state can be imported with:

```bash
npm run db:import-file-store
```

See [docs/postgresql-server-state-migration.md](docs/postgresql-server-state-migration.md) for migration details and network guardrails.

## Verification

```bash
npm run typecheck
npm run build
```

Smoke-check a running app:

```bash
BASE_URL=http://localhost:5173 npm run smoke:app
```

The smoke script checks the main routes, favicon, and provider endpoint. Signing still needs a real wallet extension or a documented test harness because CIP-30 wallet behavior is browser-extension specific.

## Docker

Build an image:

```bash
docker build \
  --build-arg CARDANO_NETWORK=preprod \
  --build-arg VITE_CARDANO_NETWORK=preprod \
  -t cardano-multisig:preprod .
```

Run the container with runtime environment variables for the selected network, provider, PostgreSQL database, and session secret.

## Project structure

- `app/routes/` - React Router page routes and API routes.
- `app/lib/multisig.ts` - wallet, script, threshold, and transaction helpers shared by UI flows.
- `app/lib/relay-room.ts` - client-visible relay room types and URL helpers.
- `app/lib/server/` - server persistence, Cardano provider, submit, and witness verification helpers.
- `db/migrations/` - PostgreSQL schema.
- `docs/` - implementation notes and QA guardrails.
- `scripts/` - migration, import, smoke, and crypto helper scripts.

## Current limits

- The app targets native-script multisig policies, not Plutus scripts.
- ADA Handle lookup is mainnet-oriented; on testnets, import wallet exports, native scripts, or addresses directly.
- Browser wallet support depends on the wallet exposing a compatible CIP-30 API.
- The relay room model stores coordination state server-side, but invite tokens still grant room access to anyone who has the link.

## License

Released under the [MIT License](LICENSE).
