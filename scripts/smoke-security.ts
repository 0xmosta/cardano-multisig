import assert from "node:assert/strict";
import { mergeSignatures, sortTransactionDraftsNewestFirst, type SignatureRecord, type TxDraft } from "../app/lib/multisig.ts";
import { persistableRelayDraft } from "../app/lib/relay-room.ts";
import { stableJsonStringify } from "../app/lib/utils.ts";
import { sanitizeAccountSnapshotInput } from "../app/lib/server/account-state-validation.ts";
import { decryptSensitiveJson, encryptSensitiveJson } from "../app/lib/server/sensitive-data.ts";
import { enforceRateLimit, RateLimitError } from "../app/lib/server/rate-limit.ts";

process.env.CARDANO_MULTISIG_SESSION_SECRET ||= "security-smoke-session-secret-at-least-32-bytes";

const keyHash = "11".repeat(28);
const token = "a".repeat(43);
const normal = sanitizeAccountSnapshotInput(
  {
    wallets: [
      {
        id: "wallet-security",
        name: "Security test",
        network: "preprod",
        threshold: 1,
        signers: [{ id: "signer-1", label: "Signer", keyHash, source: "payment", ignored: "removed" }],
        paymentScript: { type: "sig", keyHash, ignored: "removed" },
        createdAt: new Date().toISOString(),
        imported: true,
        ignored: "removed",
      },
    ],
    transactions: [
      {
        id: "tx-security",
        walletId: "wallet-security",
        title: "Security test",
        walletName: "Security test",
        network: "preprod",
        recipient: "addr_test1security",
        lovelace: "1000000",
        note: "",
        unsignedTxCbor: "84a0",
        requiredSignatures: 1,
        signerKeyHashes: [keyHash],
        signatures: [],
        createdAt: new Date().toISOString(),
        relayRoom: {
          roomId: "room-security",
          coordinatorToken: token,
          sharedInviteUrl: `https://cardano.example/sign#r=${token}`,
          signerInvites: [{ keyHash, label: "Signer", inviteUrl: `https://cardano.example/sign#r=${token}` }],
          createdAt: new Date().toISOString(),
          status: "open",
        },
        ignored: "removed",
      },
    ],
  },
  "preprod",
);

assert.equal((normal.wallets[0] as unknown as Record<string, unknown>).ignored, undefined);
assert.equal((normal.wallets[0].paymentScript as Record<string, unknown>).ignored, undefined);
assert.equal((normal.transactions[0] as unknown as Record<string, unknown>).ignored, undefined);
assert.equal(normal.transactions[0].relayRoom?.coordinatorToken, token);

assert.throws(
  () => sanitizeAccountSnapshotInput({ wallets: [{ rootKey: "xprv_private" }], transactions: [] }, "preprod"),
  /custodial key material|private extended key/i,
);
assert.throws(
  () => sanitizeAccountSnapshotInput({ wallets: [], transactions: [{ mnemonic: "one two three" }] }, "preprod"),
  /custodial key material/i,
);

const encrypted = encryptSensitiveJson({ coordinatorToken: token }, "account-relay-capabilities");
assert.match(encrypted, /^sec1:/);
assert.deepEqual(decryptSensitiveJson(encrypted, "account-relay-capabilities"), { coordinatorToken: token });
assert.throws(() => decryptSensitiveJson(`${encrypted.slice(0, -2)}aa`, "account-relay-capabilities"));

const witnessSignature: SignatureRecord = {
  signerKeyHash: keyHash,
  matchedSignerKeyHash: keyHash,
  signerName: "Signer",
  walletName: "Security test",
  witnessCbor: "84a0",
  signedAt: new Date().toISOString(),
  source: "relay",
  matchStatus: "matched",
  relayWitnessId: "witness-security",
};
const progressSignature: SignatureRecord = {
  ...witnessSignature,
  witnessCbor: "",
  relayWitnessId: `relay-progress:room-security:${keyHash}`,
};
const mergedSignatures = mergeSignatures([witnessSignature], [progressSignature]);
assert.equal(mergedSignatures.length, 1);
assert.equal(mergedSignatures[0].witnessCbor, witnessSignature.witnessCbor);
const progressDraft = { ...normal.transactions[0], signatures: [progressSignature] } as TxDraft;
assert.deepEqual(persistableRelayDraft(progressDraft).signatures, []);
assert.equal(stableJsonStringify({ beta: 2, alpha: { delta: 4, charlie: 3 } }), stableJsonStringify({ alpha: { charlie: 3, delta: 4 }, beta: 2 }));
const olderDraft = { ...normal.transactions[0], id: "tx-older", createdAt: "2026-07-15T09:00:00.000Z" } as TxDraft;
const newerDraft = { ...normal.transactions[0], id: "tx-newer", createdAt: "2026-07-15T10:00:00.000Z" } as TxDraft;
assert.deepEqual(sortTransactionDraftsNewestFirst([olderDraft, newerDraft]).map((draft) => draft.id), ["tx-newer", "tx-older"]);

const request = new Request("http://localhost/security", { headers: { "x-forwarded-for": "192.0.2.1" } });
await enforceRateLimit(request, { scope: "security-smoke", limit: 2, windowMs: 60_000 });
await enforceRateLimit(request, { scope: "security-smoke", limit: 2, windowMs: 60_000 });
await assert.rejects(
  enforceRateLimit(request, { scope: "security-smoke", limit: 2, windowMs: 60_000 }),
  RateLimitError,
);

console.log(JSON.stringify({ ok: true, strictSnapshotValidation: true, sensitiveEnvelopeRoundTrip: true, relayProgressPersistenceSafe: true, rateLimitEnforced: true }));
