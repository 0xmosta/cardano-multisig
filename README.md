# Cardano Multisig

Dark React Router 8 platform for importing Cardano native-script multisig wallets and coordinating transaction signatures.

## Current MVP

- Import an existing Cardano wallet by pasting payment/stake native-script CBOR hex or JSON.
- Parse native-script CBOR/JSON, preview payment/stake policy summaries, and extract unique signer key hashes.
- Create a new M-of-N payment native script from signer key hashes.
- Connect browser wallets through a compact header control with timeout/error handling.
- Derive the connected wallet payment key hash when possible.
- Create transaction signing rooms with recipient/amount/note and unsigned transaction CBOR.
- Generate private invite links for signers.
- Let signers sign unsigned tx CBOR with `wallet.signTx(..., true)` and export/import signature packages.
- Track signer status: signed vs pending and collected vs required signatures.
- Use server-managed Ogmios/Kupo/Cardano submit configuration automatically; no browser-side provider setup is shown.
- Save wallet workspaces locally in the browser and export wallet JSON.
- Full dark UI built with local shadcn-style components.

> Safety: this MVP intentionally keeps coordination client-side. Invite links and signature packages should be shared privately. Verify scripts, addresses, and transaction CBOR independently and complete a dust transaction before moving real value.

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
