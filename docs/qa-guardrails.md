# Cardano Multisig QA Guardrails

Use this before shipping changes that touch navigation, signing, relay rooms, or submit.

## Automated Smoke

Run against a local build:

```bash
npm run build
npm run start
BASE_URL=http://localhost:<port> npm run smoke:app
```

Run against production or preprod:

```bash
BASE_URL=https://cardano.0xm.sh npm run smoke:app
BASE_URL=https://cardano-preprod.0xm.sh npm run smoke:app
```

The smoke check confirms the home, wallet list, transaction list, favicon, and provider endpoint respond correctly.

## Manual Release Checklist

- Home does not duplicate wallet or transaction management surfaces.
- `/wallets` opens and the wallet table/list is usable at desktop width and 390px mobile width.
- `/transactions` opens and transaction rows can navigate back to the wallet coordinator.
- Shared signer link with `#r=` opens directly into the signing screen.
- Shared signer link shows live sync state, already-delivered state, and a clear sign action.
- On mobile, the flow remains visible: open shared link, connect wallet, sign, see delivered status.
- Coordinator wallet detail shows signer labels, connected signer as `You`, matched signatures, relay last-sync state, and manual refresh.
- A ready transaction makes `Submit signed transaction` the obvious next step.
- A submitted transaction shows tx hash and explorer/copy actions.
- Manual witness package import remains available as fallback.
- Favicon/static assets are not React Router defaults.

## Test Evidence Notes

Record whether the signer test used:

- Real CIP-30 wallet extension
- CDP QA harness
- Scripted/shim smoke

Only a real CIP-30 or documented CDP harness pass should be treated as signer UX approval.
