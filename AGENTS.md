# Cardano Multisig Agent Notes

## Operating Mode

- Default branch for active work is `preprod`.
- Default public target is `https://cardano-preprod.0xm.sh`.
- Treat `https://cardano.0xm.sh` and branch `main` as mainnet/production. Do not modify, deploy, or point new tests at mainnet unless the task explicitly says so.
- Default Cardano network is `preprod`; use `CARDANO_NETWORK=preprod` and `VITE_CARDANO_NETWORK=preprod`.
- Use the existing Disco preprod Blockfrost secret only through environment configuration. Never paste API keys into source, Kanban comments, logs, screenshots, or summaries.

## Repo Context

- Stack: React Router app, React 19, TypeScript, Tailwind CSS v4, Dockerfile deploy.
- Server routes live in `app/routes/api.cardano.*.ts`.
- Browser wallet integration is CIP-30 style and must stay client-side.
- Wallet and transaction data are currently browser-local. Invite links and witness packages are sensitive and should be shared privately.

## Safety Rules

- Mainnet guardrail: any task touching `main`, `cardano.0xm.sh`, mainnet Blockfrost/Koios, real treasury addresses, submission endpoints, or DNS must stop for review unless explicitly authorized.
- For non-mainnet transaction building, Blockfrost/Kupo/Ogmios config must be explicit. Do not silently fall back to mainnet providers.
- Validate network assumptions in code and UI. Preprod addresses use `addr_test...`; mainnet uses `addr...`.
- Do not invent policy IDs, script hashes, addresses, transaction CBOR, protocol parameters, or CIP behavior.
- Before changing UX around signing/submission, inspect the full flow: import wallet, create transaction, invite signer, connect signer wallet, sign, export/import witnesses, submit/confirm.

## Verification

- Run `npm run typecheck` after TypeScript changes.
- Run `npm run build` after route, Vite, or deployment changes.
- For UX changes, verify desktop and mobile layout. Signing flows need a manual wallet smoke test on preprod before production use.

## Kanban Handoff

Completion summaries must include:
- branch and commit SHA if committed,
- touched files,
- commands run and results,
- remaining risks,
- whether any secret/env/DNS/deploy step remains manual.
