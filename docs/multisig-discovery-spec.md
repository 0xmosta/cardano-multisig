# Multisig import / discovery spec

Network scope: preprod by default. This spec intentionally avoids mainnet-only flows except where called out explicitly for ADA Handles.

## Why this spec exists

Today the app can only create a wallet from local script material:
- `app/routes/home.tsx:493-511` imports a wallet only from pasted payment/stake script CBOR/JSON.
- `app/routes/wallet-detail.tsx:224-257` and `app/routes/transaction-new.tsx:191-233` derive Kupo patterns and stake addresses from already-known scripts.
- `app/routes/api.cardano.assets.ts:203-242` can load assets from an exact address or Kupo pattern, but it does not discover a multisig registration.
- `app/routes/api.cardano.build-tx.ts:94-115` can synthesize the source script address from known scripts, but it cannot build from “address only”.

The missing product question is what the app can honestly infer from:
1. a multisig script address,
2. a normal signer wallet/address,
3. on-chain CIP-146 registration metadata.

## Ground truth from Cardano standards / APIs

### CIP-146
Source: CIP-0146.

Key rules:
- registration uses tx auxiliary data with a non-empty `native_script` array and metadata label `1854`.
- metadata `types` must map 1:1 to the `native_script` array.
- participant key hashes in those scripts must be derived from CIP-1854 (`1854'/1815'/0'/x/y`).
- discovery is defined as scanning label `1854` metadata and matching participant key credentials.
- metadata updates are valid only when a later tx both carries label `1854` metadata and spends at least one input from the multisig payment script.

Important consequence: CIP-146 discovery is only reliable for publicly registered multisigs whose participant keys follow CIP-1854. It is not a generic “find every multisig for any ordinary wallet address” mechanism.

### CIP-1854
Source: CIP-1854.

Key rules:
- multisig keys live under `m/1854'/1815'/account'/role/index`.
- `role=0` payment, `role=2` stake.
- multisig wallets discover addresses by matching script templates instantiated from those keys.

Important consequence: ordinary CIP-30 wallet payment addresses usually come from CIP-1852, not CIP-1854. A normal receive/change address key hash is therefore not enough to discover CIP-146 registrations unless the wallet explicitly exposes multisig/CIP-1854 participation.

### CIP-30
Source: CIP-0030.

Relevant wallet API calls:
- `getUsedAddresses()`
- `getUnusedAddresses()`
- `getChangeAddress()`
- `getRewardAddresses()`

Important consequence: the current app only types the first three in `app/routes/home.tsx:66-73`. For discovery work it should also type and use `getRewardAddresses()`.

### Blockfrost constraints
Source: Blockfrost OpenAPI.

Useful endpoints:
- `/addresses/{address}/utxos`
- `/addresses/{address}/transactions`
- `/accounts/{stake_address}/addresses`
- `/accounts/{stake_address}/addresses/assets`
- `/accounts/{stake_address}/addresses/total`
- `/metadata/txs/labels/{label}`
- `/txs/{hash}/metadata`
- `/txs/{hash}/cbor`
- `/txs/{hash}/utxos`

Constraints that matter:
- pagination is capped at 100 items/page.
- metadata label queries are not filterable by participant key hash or script hash; the app must paginate and filter itself.
- metadata endpoints alone are not enough for CIP-146 because the app also needs the tx CBOR (to recover native scripts) and tx inputs (to validate metadata updates).
- preprod uses the same API shape, but handle.me resolution in this repo is intentionally mainnet-only (`app/routes/api.cardano.assets.ts:79-101`, `app/routes/api.cardano.build-tx.ts:58-78`).

Important repo-specific consequence:
- on preprod, realistic registration discovery needs Blockfrost.
- Kupo is good for script-UTxO matching, but not for chain-wide metadata-label discovery.
- Ogmios alone is not a historical metadata index.

## What can be discovered from a multisig script address

### Safe to claim
From an exact script address the app can safely discover:
- network validity (`addr_test...` vs `addr...`).
- whether the address is enterprise-script or base-script, and whether it contains a script stake credential.
- payment script hash from the address credential.
- stake script hash if the address is a base script address.
- current UTxOs / assets at that exact address via Blockfrost `/addresses/{address}/utxos`.
- tx history touching that exact address via Blockfrost `/addresses/{address}/transactions`.

### Not safe to claim from address alone
From address alone the app cannot safely infer:
- the native script preimage.
- threshold / M-of-N.
- participant key hashes.
- signer labels.
- whether the address belongs to a CIP-146 registration.
- whether a matching registration exists but was never updated after initial publish.

### Best-effort upgrade path from address to registered multisig
If the app has an exact script address, it can try to upgrade from “address only” to “registered multisig” by:
1. decoding payment/stake script hashes from the address,
2. scanning Blockfrost label `1854` pages,
3. fetching each candidate tx’s CBOR and parsing auxiliary native scripts,
4. locating a candidate whose payment script hash matches the address payment hash and whose optional stake script also matches when present,
5. applying CIP-146 update rules: if later label-1854 metadata exists, only accept it when `/txs/{hash}/utxos` shows at least one input from the multisig payment script.

This is realistic, but it is not cheap. It should be implemented as a server-side discovery endpoint with caching, not in the browser.

## What can be discovered from a normal signer wallet/address

### Safe to claim
From a connected CIP-30 wallet the app can safely discover:
- connected network id.
- one or more ordinary wallet addresses (`getUsedAddresses`, `getUnusedAddresses`, `getChangeAddress`).
- one or more reward addresses (`getRewardAddresses`) if the wallet supports the CIP-30 base method.
- payment key hash of the chosen payment address.
- stake account context from reward addresses.

### Not safe to claim
The app must not claim that a normal signer wallet proves ownership of a multisig unless it has stronger evidence.

Specifically, a normal signer wallet/address does not reliably tell us:
- that the wallet participates in any multisig at all,
- that its ordinary payment key hash corresponds to a CIP-1854 participant key,
- which multisig template/script it belongs to,
- that it can reconstruct the full native script,
- that it can spend from a multisig without an invite/script export.

### Realistic discovery from signer wallet
The only honest best-effort path is:
1. collect reward addresses via `getRewardAddresses()` and payment key hashes from used/change addresses,
2. use Blockfrost account endpoints for reward-address context if needed,
3. scan label `1854` registrations and match participant key hashes only against keys that are explicitly present in the registration,
4. only show a wallet as “registered multisig found” if the registration is fully reconstructable and validated.

Even then, most ordinary wallets will produce no results because the registration expects CIP-1854-derived participant keys, not arbitrary CIP-1852 receive/change keys.

Product consequence: when no verified registration is found, the UI should say “No registered multisig found for this signer wallet. Ask the coordinator for a script export or invite.”

## Honest UI states the app should support

### 1. Local wallet
Definition:
- full payment script is known locally (pasted/imported/exported), regardless of on-chain registration.

Allowed actions:
- save wallet,
- derive signers from script,
- fetch assets,
- build tx,
- create invites,
- collect witnesses.

Suggested label:
- `Local script loaded`

### 2. Registered multisig found
Definition:
- the app found and validated a CIP-146 registration and reconstructed the payment script (and stake script if present).

Allowed actions:
- import as wallet,
- save registration tx hash / latest metadata update tx hash,
- fetch assets,
- build tx,
- create invites.

Suggested label:
- `Registered on-chain (CIP-146 verified)`

### 3. Script address only
Definition:
- the app knows an exact script address, but not a verified native script preimage.

Allowed actions:
- show address,
- show current assets and tx history,
- attempt registration discovery,
- export/share the address.

Blocked actions:
- do not build tx,
- do not create signer invites,
- do not claim threshold/signers.

Suggested label:
- `Address only — script not yet known`

### 4. Need script export
Definition:
- signer wallet connected, but no verified CIP-146 registration was found and no local script exists.

Allowed actions:
- show connected key hash / reward address context,
- search again,
- instruct the user to import a script export or invite.

Suggested label:
- `Need script export or invite`

## Recommended data model changes

Add an explicit discovery object to wallet records instead of overloading `imported` / `handle`:

```ts
interface WalletDiscoveryState {
  kind: "local" | "cip146" | "scriptAddressOnly" | "signerOnly";
  sourceNetwork: "mainnet" | "preprod" | "preview";
  scriptAddress?: string;
  paymentScriptHash?: string;
  stakeScriptHash?: string | null;
  registrationTxHash?: string;
  metadataUpdateTxHash?: string;
  discoveredFrom?: "scriptAddress" | "signerWallet" | "manualScript";
  confidence: "verified" | "address-only" | "best-effort";
}
```

Do not treat `handle` as identity truth. On preprod there is usually no handle resolution, and even on mainnet it is only an address hint.

## Concrete route recommendations

### `app/routes/api.cardano.provider.ts`
Current role: coarse service readiness.

Recommendation:
- keep current readiness fields,
- add discovery capability flags so `home.tsx` can render honest options before the user starts:

```ts
{
  network,
  services,
  discovery: {
    exactAddressAssets: services.blockfrost || services.kupo,
    cip146RegistrationScan: services.blockfrost,
    txCborLookup: services.blockfrost,
    rewardAccountLookup: services.blockfrost,
    handleResolution: network === "mainnet",
  }
}
```

Reason:
- `home.tsx` currently only knows “provider ready” vs “needs attention”. That is not enough to explain why “address-only import” may work while “registered multisig discovery” may not.

### `app/routes/api.cardano.assets.ts`
Current role:
- resolve exact address assets when address/handle exists,
- otherwise fall back to Kupo patterns derived from scripts.

Recommendation:
- keep asset lookup separate from wallet identity discovery,
- add explicit response fields such as:
  - `lookupKind: "exact-address" | "stake-account" | "kupo-pattern"`
  - `multisigIdentity: "verified" | "unverified" | "none"`
- accept exact `address` as a first-class import path for “script address only”.
- never imply that an exact-address asset lookup reconstructed the multisig policy.

Reason:
- today the route returns `address`, `handle`, `source`, `patterns`, but not whether the identity is verified. The UI can easily overstate what was discovered.

### New route: `app/routes/api.cardano.discovery.ts`
Recommended new endpoint.

Responsibilities:
- accept one of:
  - `scriptAddress`,
  - `paymentKeyHashes[]`,
  - `rewardAddresses[]`.
- for `scriptAddress`:
  - decode payment/stake script hashes,
  - scan label `1854` metadata,
  - fetch tx CBOR + tx inputs,
  - reconstruct and validate CIP-146 registration / update chain.
- for signer discovery:
  - derive participant-hash matches from label `1854` registrations,
  - return only fully reconstructable wallets.
- cache results by network + query key, because Blockfrost scans are expensive.

Suggested response shape:

```ts
{
  network: "preprod",
  queryKind: "scriptAddress" | "signerWallet",
  matches: Array<{
    status: "verified" | "best-effort";
    paymentScript: NativeScript;
    stakeScript?: NativeScript | null;
    signers: Array<{ keyHash: string; source: "payment" | "stake" | "metadata" }>;
    threshold: number;
    registrationTxHash: string;
    metadataUpdateTxHash?: string;
    scriptAddress: string;
    name?: string;
    participants?: Record<string, { name?: string; description?: string; icon?: string }>;
  }>;
  warnings: string[];
}
```

### `app/routes/api.cardano.build-tx.ts`
Current role:
- build unsigned tx only when full scripts are already known.

Recommendation:
- keep that requirement.
- make the contract explicit: this route requires a verified local or CIP-146-derived script, not address-only discovery.
- reject any future “address only” wallet objects before attempting tx build.
- optionally accept a previously verified `sourceAddress` to avoid recomputing it, but still require full script(s) for witness construction.

Reason:
- building from address only is unsafe and impossible for native-script witnesses.

## Concrete `home.tsx` recommendations

### 1. Split import into explicit modes
Replace the current single “Import wallet” path with four tabs/cards:
- `Paste script`
- `Import script address`
- `Find from signer wallet`
- `Create policy`

Reason:
- the current form (`home.tsx:853-885`) assumes every import already has script CBOR/JSON.

### 2. Extend CIP-30 typing and collection
Update `CardanoWalletApi` in `home.tsx` to include:
- `getRewardAddresses(): Promise<string[]>`

When connecting a wallet, collect:
- used/change address hex,
- payment key hash,
- reward addresses.

Do not promise discovery just because a wallet connected.

### 3. Show discovery status cards, not a single success string
Instead of only `setStatus("Wallet imported...")`, maintain a structured discovery result with badges:
- `Local script loaded`
- `CIP-146 verified`
- `Address only`
- `Need script export`

### 4. Allow address-only save, but as read-only treasury tracking
If the user pastes a script address and discovery does not find a registration:
- allow save as read-only,
- let wallet detail show assets / tx history,
- disable tx build and signer invite buttons,
- show a persistent warning: `Script preimage missing; import script export to spend from this wallet.`

### 5. Make signer-wallet discovery honest
If “Find from signer wallet” returns no verified registrations:
- do not create a wallet automatically,
- show the connected payment key hash / reward address as diagnostic context,
- tell the user that ordinary wallets do not usually expose CIP-1854 shared-wallet registrations.

### 6. Use provider capabilities in the top banner
Replace the current binary provider badge with capability-aware copy, for example:
- `preprod provider ready · exact-address assets + CIP-146 scan available`
- `preprod provider ready · exact-address assets only`
- `preprod provider needs Blockfrost for CIP-146 discovery`

## Recommended implementation order

1. Add provider discovery capability flags.
2. Add `api.cardano.discovery.ts` with script-address lookup first.
3. Add home-screen `Import script address` flow.
4. Add address-only wallet state and UI restrictions.
5. Extend CIP-30 typing with `getRewardAddresses()`.
6. Add signer-wallet discovery as best-effort only.
7. Optionally surface verified CIP-146 metadata (wallet name / participant labels) in wallet detail.

## Non-goals / guardrails

- Do not infer threshold or signer hashes from address-only state.
- Do not call handle resolution on preprod as a primary discovery path.
- Do not treat a normal connected wallet as proof of multisig ownership.
- Do not let `build-tx` run without full script material.
- Do not silently fall back to mainnet providers.

## Bottom line

The safest product model is:
- script address => exact-address tracking only,
- CIP-146 match => verified importable multisig,
- normal signer wallet => best-effort discovery only,
- no verified script => require script export or invite before spending/signing flows.
