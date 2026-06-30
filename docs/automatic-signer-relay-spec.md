# Automatic signer relay rooms spec

Network scope: preprod first. Mainnet deploy/submit remains off unless explicitly authorized.

## Current repo baseline

- Signer invites are local fragment payloads today: `#invite=${encodeInvite(draft)}` in `app/routes/home.tsx:751-755` and `app/routes/wallet-detail.tsx:278-280`.
- Signers currently sign locally, then must copy a witness package back manually in `app/routes/home.tsx:757-789` and `app/routes/wallet-detail.tsx:328-385`.
- Coordinator progress is local-only and manual import today in `app/routes/wallet-detail.tsx:451-478`.
- Threshold math already exists and must stay authoritative: `signatureCount`, `pendingSignatureCount`, `requiredPendingSignerKeyHashes`, `optionalSignerKeyHashes`, `removeUnmatchedSignatures` in `app/lib/multisig.ts:192-313`.

## Goal

Make relay rooms the default happy path:
1. coordinator builds tx locally,
2. coordinator creates a server-side room for that tx,
3. coordinator copies a signer-specific invite link,
4. signer opens link, fetches tx details from server, signs, witness auto-POSTs,
5. coordinator polls room state and merges matched witnesses automatically,
6. manual witness import/export stays available as fallback only.

## Data model

Add a server-side room store under a configurable data dir, e.g. `CARDANO_MULTISIG_DATA_DIR=/var/lib/cardano-multisig` or `./data/cardano-multisig` for local dev.

Suggested file layout:
- `rooms/<roomId>.json`
- atomic write via temp file + `rename`
- strict JSON schema validation on every read/write

Room shape:

```ts
type RelayRoom = {
  id: string;                     // high-entropy public room id, e.g. base64url(16 bytes)
  network: "preprod" | "preview" | "mainnet";
  status: "open" | "submitted" | "cancelled" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;              // default 7 days; extend on new witness activity

  tx: {
    draftId: string;              // local tx id for compatibility only
    walletId?: string;
    walletName: string;
    title: string;
    note: string;
    recipient: string;
    lovelace: string;
    assets: AssetLine[];
    unsignedTxCbor: string;
    requiredSignatures: number;
    signerKeyHashes: string[];    // normalized lower-case, unique, policy order preserved
  };

  coordinator: {
    tokenHash: string;            // sha256(raw token); never persist raw token
    lastSeenAt?: string;
  };

  signers: Array<{
    keyHash: string;              // invite scoped to one policy signer key hash
    label?: string;               // optional UI hint copied from local wallet signer label
    tokenHash: string;            // sha256(raw signer token)
    createdAt: string;
    lastSeenAt?: string;
    deliveredAt?: string;         // first successful matching witness
  }>;

  witnesses: Array<{
    id: string;
    source: "relay" | "manual";
    signerKeyHashClaim?: string;  // client claim / invite scope
    matchedSignerKeyHash?: string;
    witnessCbor: string;
    walletName?: string;
    signerName?: string;
    signedAt: string;
    receivedAt: string;
    matchStatus: "matched" | "unmatched";
  }>;

  submission?: {
    txHash: string;
    submittedAt: string;
  };
};
```

Add local tx linkage in `TxDraft`:

```ts
type RelayRoomRef = {
  roomId: string;
  coordinatorToken: string;       // localStorage only; never put in query params
  createdAt: string;
  lastSyncAt?: string;
  signerInvites: Array<{ keyHash: string; label?: string; inviteUrl: string }>;
};
```

Store `relayRoom?: RelayRoomRef` on `TxDraft`.

## Token model

Use capability tokens with raw secret only in the URL fragment.

- room id: public, random, non-secret identifier
- coordinator token: can fetch full room state and poll witnesses for one tx
- signer token: scoped to exactly one room + one signer key hash; can fetch signing payload and POST one replacement witness for that signer
- token generation: `crypto.randomBytes(32).toString("base64url")`
- persistence: store only `sha256(token)` server-side
- URLs:
  - signer: `/#relay=<signerToken>`
  - coordinator never receives authority from URL query; the local app stores its token after room creation and POSTs it intentionally

Do not embed unsigned tx CBOR or coordinator authority in the link itself for the relay path.

## API surface

React Router route names can stay simple:
- `app/routes/api.cardano.relay-room.ts`
- `app/lib/server/relay-room-store.ts`
- `app/lib/relay-room.ts`

### POST `/api/cardano/relay-room`
Create room.

Request:
```json
{
  "draft": {
    "id": "tx_...",
    "walletId": "wallet_...",
    "walletName": "Treasury",
    "title": "Payroll July",
    "note": "...",
    "recipient": "addr_test...",
    "lovelace": "25000000",
    "assets": [],
    "unsignedTxCbor": "...",
    "requiredSignatures": 2,
    "signerKeyHashes": ["..."]
  },
  "signers": [
    { "keyHash": "...", "label": "Mosta" }
  ],
  "network": "preprod"
}
```

Rules:
- reject if network is `mainnet` unless a future explicit feature flag enables it
- reject empty/invalid unsigned tx CBOR
- normalize signer key hashes to lower-case unique order
- require `requiredSignatures >= 1` and `<= signerKeyHashes.length`

Response:
```json
{
  "ok": true,
  "roomId": "...",
  "coordinatorToken": "...",
  "signerInvites": [
    { "keyHash": "...", "label": "Mosta", "inviteUrl": "https://cardano-preprod.0xm.sh/#relay=..." }
  ],
  "expiresAt": "..."
}
```

### POST `/api/cardano/relay-room/session`
Fetch room/session state by token.

Request:
```json
{ "token": "raw capability token" }
```

Response for coordinator:
```json
{
  "ok": true,
  "role": "coordinator",
  "room": {
    "roomId": "...",
    "status": "open",
    "network": "preprod",
    "tx": { "...": "..." },
    "witnesses": [ ... ],
    "submission": null,
    "progress": {
      "matchedCount": 1,
      "requiredSignatures": 2,
      "pendingRequiredKeyHashes": ["..."],
      "optionalUnsignedKeyHashes": ["..."]
    }
  }
}
```

Response for signer:
```json
{
  "ok": true,
  "role": "signer",
  "room": {
    "roomId": "...",
    "status": "open",
    "network": "preprod",
    "tx": { "...": "..." },
    "signer": {
      "keyHash": "...",
      "label": "Mosta",
      "alreadyDelivered": false,
      "thresholdReached": false
    }
  }
}
```

Signer response should include unsigned tx CBOR because the signer page must call `wallet.signTx(..., true)` without local draft import.

### POST `/api/cardano/relay-room/sign`
Submit or replace one signer witness.

Request:
```json
{
  "token": "raw signer token",
  "witnessCbor": "...",
  "walletName": "Lace",
  "signerName": "...optional client display name...",
  "signedAt": "2026-06-29T12:34:56.000Z"
}
```

Rules:
- token must resolve to signer scope for an open room
- room network must match configured provider network
- syntactically validate witness set CBOR with CSL
- determine whether witness contains a vkey/bootstrap witness matching the signer token's scoped `keyHash`
- if matched, replace any prior matched witness for that same signer key hash; do not append duplicates forever
- if not matched, keep it as `matchStatus="unmatched"` so coordinator can inspect/remove, but it does not count toward threshold
- reject writes after `submitted|cancelled|expired`

Response:
```json
{
  "ok": true,
  "delivered": true,
  "matchStatus": "matched",
  "matchedSignerKeyHash": "...",
  "thresholdReached": false
}
```

### POST `/api/cardano/relay-room/submit`
Optional but useful after coordinator submits on-chain.

Request:
```json
{ "token": "raw coordinator token", "txHash": "..." }
```

Rule: mark room `submitted` and stop new witness uploads.

## Cardano-specific merge semantics

This part must stay stricter than the current local-only merge in `app/lib/multisig.ts:301-313`.

1. Normalize all policy signer key hashes lower-case.
2. Count progress by unique matched policy signer key hashes only.
3. A witness only counts if the decoded witness set includes a vkey/bootstrap witness whose payment key hash equals a policy signer key hash.
4. For signer-token uploads, only the scoped signer key hash may become `matchedSignerKeyHash`.
5. Latest valid witness replaces the prior witness for the same matched signer key hash.
6. Unmatched witnesses remain visible/removable, but never increase `matchedCount`.
7. Threshold is `min(unique matched policy signers, requiredSignatures)`.
8. Once threshold is reached, remaining unsigned policy members are optional, not blockers.
9. Wallet detail must keep showing optional unsigned signers distinctly, matching current UX expectations in `app/routes/wallet-detail.tsx:651-656` and `app/routes/home.tsx:414-419`.
10. The final assembled signed tx still merges all stored witness sets plus native scripts exactly as today in `app/routes/wallet-detail.tsx:249-276`.

## Exact happy-path UX

### Coordinator
1. Build tx as today in `transaction-new.tsx`.
2. Wallet detail sees `tx.relayRoom` missing and offers primary CTA `Create signer relay room` or creates automatically on first `Copy signer invite`.
3. After room creation, tx card stores `relayRoom` locally and primary CTA becomes `Copy signer invite`.
4. Copy action should target one missing required signer first; optional signers only after threshold is reached or via dropdown.
5. Wallet detail polls `/api/cardano/relay-room/session` every 5-10s while the tx card is visible and room status is `open`.
6. Poll response auto-merges remote witnesses into local `tx.signatures`, marks `updatedAt`, and updates progress without manual paste.
7. If threshold reached, coordinator sees `Ready to submit`; optional remaining signers are labeled optional.
8. Manual witness textarea moves behind an `Advanced fallback` disclosure, not the primary card.

### Signer
1. Open `/#relay=<token>`.
2. `home.tsx` checks `relay` fragment before legacy `invite`.
3. Client POSTs token to `/api/cardano/relay-room/session`.
4. UI shows tx title, wallet name, recipient, assets, note, required signatures, and network warning.
5. Signer connects Lace/Eternl/VESPR.
6. Client checks connected network matches room network.
7. Client calls `wallet.signTx(unsignedTxCbor, true)`.
8. Client POSTs returned witness CBOR to `/api/cardano/relay-room/sign` with the signer token.
9. Success state says: `Signature delivered to the coordinator. You can close this page.`
10. If threshold was already met before this signer arrived, show `Threshold already reached — your signature was delivered as optional.`

## Legacy compatibility

- Keep current `#invite=` decoding path unchanged for old links.
- Keep `createSignaturePackage()` / `parseSignaturePackage()` manual import/export unchanged as fallback.
- New relay links use `#relay=` only; do not overload the old payload format.
- If relay fetch fails (expired/not found), show a clear error plus manual fallback instructions.
- If coordinator cannot create room (server data dir unavailable, validation error, network mismatch), fall back to existing manual invite copy instead of blocking signing entirely.

## Validation / guardrails

- Preprod only by default: room creation must reject `mainnet` unless a separate allow-mainnet env is later introduced.
- Never log raw tokens or witness CBOR in server logs.
- Avoid URL query secrets; all capabilities stay in fragments and explicit POST bodies.
- Room files must be private to the app user and written atomically.
- Add TTL cleanup for expired rooms; expiry should not delete submitted room records immediately.
- Do not trust client-claimed signer key hash alone; derive counting status from decoded witness set plus signer-token scope.

## Implementation notes for fullstackjs

1. Add `relayRoom` types to `app/lib/multisig.ts`.
2. Add server store utilities in `app/lib/server/relay-room-store.ts` using Node `fs/promises`, atomic temp-write + rename, and SHA-256 token hashing.
3. Add route `api.cardano.relay-room.ts` with `intent` field (`create`, `session`, `sign`, `submit`) or split endpoints if cleaner.
4. Update `home.tsx` fragment loader to prefer `relay`, then fall back to legacy `invite`.
5. Update `wallet-detail.tsx` tx cards so relay is primary and manual witness import/export is advanced fallback.
6. Reuse existing threshold helpers from `app/lib/multisig.ts`; do not duplicate counting logic in UI.
7. After implementation, verify with `npm run typecheck`, `npm run build`, then preprod CDP QA harness for at least one real relay round-trip.
