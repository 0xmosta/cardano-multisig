# Cardano Multisig

Minimal dark React Router 8 platform for planning and importing Cardano native-script multisig wallets.

## Current MVP

- Import an existing Cardano wallet by pasting payment script JSON and optional stake script JSON.
- Parse native scripts, preview payment/stake policy summaries, and extract unique signer key hashes.
- Create a new M-of-N payment native script from signer key hashes.
- Save wallet workspaces locally in the browser.
- Export either script JSON or the whole wallet workspace JSON.
- Full dark UI built with local shadcn-style components.

> Safety: this MVP intentionally keeps everything client-side. Verify imported/exported scripts with independent tooling and complete a dust transaction before funding or migrating real assets.

## Development

```bash
npm install
npm run dev
```

## Verification

```bash
npm run typecheck
npm run build
```

## Deployment

The repository includes a Dockerfile for Dokploy/Traefik deployment. The current public route is `https://cardano.0xm.sh/`.
