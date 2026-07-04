# Contributor Notes

These notes are for maintainers and coding agents working on this repository.

## Project context

- Stack: React Router framework mode, React, TypeScript, Tailwind CSS, PostgreSQL, and Docker.
- Server routes live in `app/routes/api.*.ts`.
- Browser wallet integration is CIP-30 style and must remain client-side.
- Cardano provider credentials and database connection strings are server-side secrets.
- Default local development network is `preprod`.

## Safety rules

- Do not hardcode addresses, seed phrases, private keys, API keys, or provider tokens.
- Do not silently fall back to mainnet providers. Network configuration must be explicit.
- Keep mainnet relay and submit flows gated by environment flags.
- Treat invite links and witness packages as sensitive coordination data.
- Verify signer key hashes and witness matches before counting a signature toward threshold.
- Distinguish required missing signatures from optional unsigned policy members once threshold is met.

## Implementation guidance

- Follow existing React Router route module patterns in `app/routes.ts`.
- Keep server-only code under `app/lib/server/` or API route modules.
- Use shared helpers from `app/lib/multisig.ts` and `app/lib/relay-room.ts` instead of duplicating threshold, key-hash, or URL logic.
- Prefer PostgreSQL-backed persistence for deployed environments. File storage is for local development and one-off recovery work.
- Keep UI copy factual and concise. Avoid fake balances, fake transaction history, or hardcoded organization-specific labels in shipped screens.

## Verification

Run these checks after TypeScript or route changes:

```bash
npm run typecheck
npm run build
```

For persistence changes:

```bash
npm run db:migrate
npm run smoke:postgres
```

For deployed or locally served routes:

```bash
BASE_URL=http://localhost:5173 npm run smoke:app
```

Signing flows require a real CIP-30 wallet extension or a clearly documented wallet test harness.
