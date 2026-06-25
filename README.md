# Cardano Multisig

Minimal React Router 8 platform for planning Cardano native-script multisig wallets.

## Current MVP

- Create an M-of-N multisig workspace.
- Collect signer labels and 56-character payment key hashes.
- Generate a Cardano native-script JSON preview.
- Save workspaces locally in the browser.
- Export either the native script or the whole wallet workspace JSON.

> Safety: this MVP intentionally keeps everything client-side. Verify the exported script with independent tooling and complete a dust transaction before funding a multisig address with real assets.

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

The repository includes the default React Router Dockerfile. Dokploy can build it with Docker and run `npm run start`.
