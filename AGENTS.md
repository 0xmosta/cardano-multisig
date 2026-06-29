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
- Do not claim ADA Handle/address discovery can reconstruct a multisig native script. Chain discovery can resolve an address and visible assets only; save it as watch-only until a wallet export or native script is imported.
- Before changing UX around signing/submission, inspect the full flow: import wallet, create transaction, invite signer, connect signer wallet, sign, export/import witnesses, submit/confirm.
- In M-of-N coordinator UI, distinguish signatures still required for threshold from optional unsigned policy members. Once threshold is met, never present remaining optional signers as blockers.
- If an imported witness does not match the policy signer hashes, surface it as non-counting and provide a clear remove/discard action before submit.

## UI Rules

- Treat screenshots and design references as component and interaction specifications for real app flows. Do not paste them into the home page as static showcase/demo cards.
- Avoid hardcoded fake treasury names, balances, signer handles, addresses, or transaction history in product UI. If a screen needs examples, they must be isolated to tests, story fixtures, or screenshots generated outside the shipped app.
- Reuse the shadcn dark visual vocabulary on real surfaces: saved wallets, transaction creation, signer invites, approval status, witness import/export, and coordinator transaction tracking.
- For signer-friendly flows, make the current action obvious: connect wallet, verify network, sign, copy witness, import witness, or submit. Keep signer rows tied to actual policy key hashes and matched signatures.

## QA Wallets And Test Funds

- QA wallet seed phrases/private keys live only in `/home/ultra/.secrets/cardano-multisig-preprod-wallets/` with `0600` files. Never copy them into the repo, Kanban comments, logs, screenshots, browser localStorage exports, or final summaries.
- Public QA address reports may live under `/home/ultra/cardano-multisig-qa/`; those files must contain only public addresses, public key hashes, tx hashes, balances, and test notes.
- Treat preprod tADA sent by Mosta as custodial QA funds. Use them only for the agreed multisig tests, keep a balance/tx-hash trail, and return all practical residual funds to Mosta's provided preprod refund address at the end.
- Do not start refund work without an explicit `addr_test...` return address from Mosta. Never refund to mainnet or to an inferred address.
- Distribution, test funding, multisig spends, and final refunds must each record tx hash, source, destination role, amount, and remaining known balance in Kanban or `/home/ultra/cardano-multisig-qa/`.

## E2E Testing Rules

- A headless shim or script-signed transaction is useful only as a technical smoke test. Mark it clearly as `shim` or `scripted`; do not call it a real CIP-30 wallet test.
- A real signer UX pass requires an actual browser wallet extension or equivalent CIP-30 wallet session on preprod, with the user-facing invite/sign/return-witness flow exercised end to end.
- Automated QA can use the local CDP CIP-30 harness:
  - signer vault: `/home/ultra/.secrets/cardano-multisig-preprod-wallets/`
  - helper scripts: `/home/ultra/.local/share/cardano-multisig-qa-tools/cip30-cdp-harness.mjs` and `cip30-shim-server.mjs`
  - Node-side Cardano serialization helpers are installed under `/home/ultra/.local/share/cardano-multisig-qa-tools/node_modules/`; do not expect `@emurgo/cardano-serialization-lib-nodejs` inside the React app repo.
  - user service: `cardano-multisig-cip30-shim.service`
  - Chrome/Xvfb must inject providers before page load; expect `window.cardano.hermesQaSigner01` through `hermesQaSigner12`.
  - Handoff must label these runs as `CDP QA harness`, not third-party wallet extension tests.
- For scripted QA that needs chain access, prefer the live app APIs (`/api/cardano/build-tx`, `/api/cardano/submit`) so server-side preprod Blockfrost env is used. Only call Blockfrost directly from scripts when the preprod env has been explicitly injected from the running preprod service, and never print the token.
- Run E2E thresholds in order: `2-of-3`, then `4-of-7`, then `6-of-12`. Do not scale up until the smaller case has produced a tx hash or a concrete blocker.
- Any local helper server, Playwright session, shim, or long-running process started for QA must be stopped or explicitly documented in the handoff.

## Verification

- Run `npm run typecheck` after TypeScript changes.
- Run `npm run build` after route, Vite, or deployment changes.
- For UX changes, verify desktop and mobile layout. Signing flows need a manual wallet smoke test on preprod before production use.
- For multisig threshold UX, include at least one test state where threshold is met but optional policy signers remain unsigned, plus one unmatched-witness state with cleanup.
- Kanban workers must not leave `npm run dev`, Playwright, browser, shim, or other long-running QA processes in the foreground as their final action. Start them only when needed for verification, record the URL/screenshot evidence, then stop them before completing or blocking the task.
- Verifiers must validate the current worktree before blocking on a stale error. If another agent/Codex has patched the files after an earlier failure, rerun `npm run typecheck` and inspect the latest diff before reporting the blocker.
- Do not rely on `codex exec` or other external second-opinion CLIs inside Kanban verification unless authentication is already known to work. If auth fails, continue with direct code review, repo commands, and screenshot/browser evidence instead of stalling.

## Kanban Handoff

Completion summaries must include:
- branch and commit SHA if committed,
- touched files,
- commands run and results,
- whether the test was real CIP-30 or shim/scripted,
- any tx hashes, fund movements, and refund status,
- remaining risks,
- whether any secret/env/DNS/deploy step remains manual.
