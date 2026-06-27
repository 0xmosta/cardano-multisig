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

## QA Wallets And Test Funds

- QA wallet seed phrases/private keys live only in `/home/ultra/.secrets/cardano-multisig-preprod-wallets/` with `0600` files. Never copy them into the repo, Kanban comments, logs, screenshots, browser localStorage exports, or final summaries.
- Public QA address reports may live under `/home/ultra/cardano-multisig-qa/`; those files must contain only public addresses, public key hashes, tx hashes, balances, and test notes.
- Treat preprod tADA sent by Mosta as custodial QA funds. Use them only for the agreed multisig tests, keep a balance/tx-hash trail, and return all practical residual funds to Mosta's provided preprod refund address at the end.
- Do not start refund work without an explicit `addr_test...` return address from Mosta. Never refund to mainnet or to an inferred address.
- Distribution, test funding, multisig spends, and final refunds must each record tx hash, source, destination role, amount, and remaining known balance in Kanban or `/home/ultra/cardano-multisig-qa/`.

## E2E Testing Rules

- A headless shim or script-signed transaction is useful only as a technical smoke test. Mark it clearly as `shim` or `scripted`; do not call it a real CIP-30 wallet test.
- A real signer UX pass requires an actual browser wallet extension or equivalent CIP-30 wallet session on preprod, with the user-facing invite/sign/return-witness flow exercised end to end.
- Run E2E thresholds in order: `2-of-3`, then `4-of-7`, then `6-of-12`. Do not scale up until the smaller case has produced a tx hash or a concrete blocker.
- Any local helper server, Playwright session, shim, or long-running process started for QA must be stopped or explicitly documented in the handoff.

## Verification

- Run `npm run typecheck` after TypeScript changes.
- Run `npm run build` after route, Vite, or deployment changes.
- For UX changes, verify desktop and mobile layout. Signing flows need a manual wallet smoke test on preprod before production use.

## Kanban Handoff

Completion summaries must include:
- branch and commit SHA if committed,
- touched files,
- commands run and results,
- whether the test was real CIP-30 or shim/scripted,
- any tx hashes, fund movements, and refund status,
- remaining risks,
- whether any secret/env/DNS/deploy step remains manual.
