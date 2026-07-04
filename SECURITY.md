# Security Policy

Cardano Multisig coordinates native-script multisig transactions and handles sensitive coordination data such as invite links, unsigned transaction CBOR, witness packages, and server-side provider configuration.

## Supported versions

Security fixes are handled on the `main` branch. If you run a fork or deployment from an older commit, update to the latest `main` before reporting an issue that may already be fixed.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities that could expose funds, invite tokens, secrets, account sessions, transaction witnesses, or provider credentials.

Report security issues privately to the maintainers of the repository. Include:

- a concise description of the issue,
- affected commit or version,
- steps to reproduce,
- expected impact,
- whether the issue requires mainnet funds, testnet funds, or only local state.

Do not include real seed phrases, private keys, production API keys, database credentials, or unreleased transaction data in reports.

## Scope

Security-sensitive areas include:

- CIP-30 wallet authentication and signing flows,
- witness verification and multisig threshold counting,
- relay room invite token handling,
- server-side account/session persistence,
- PostgreSQL storage and migrations,
- transaction building and submit backends,
- Cardano provider configuration for Blockfrost, Kupo, Ogmios, and submit APIs.

## Operational guidance

- Use `preprod` or `preview` for testing before moving value on mainnet.
- Keep `CARDANO_MULTISIG_SESSION_SECRET`, `DATABASE_URL`, `BLOCKFROST_PROJECT_ID`, and provider credentials server-side only.
- Share relay room invite links only with intended signers.
- Verify unsigned transaction CBOR, recipient addresses, assets, and signer key hashes before signing.
- Run PostgreSQL-backed deployments for production-like environments.
