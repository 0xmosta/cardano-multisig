import assert from "node:assert/strict";
import process from "node:process";
import { createIdentity, createSession, loadAccountSnapshot, loadSession, replaceAccountSnapshot } from "../app/lib/server/account-store.ts";
import { createRelayRoom, readRelayRoom, resolveRelayTokenSession, writeRelayRoom } from "../app/lib/server/relay-room-store.ts";

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const identity = createIdentity({
    kind: "payment",
    keyHash: "11".repeat(28),
    addressHex: "01".repeat(57),
  });

  const { session, cookie } = await createSession(identity, process.env.CARDANO_NETWORK || "preprod");
  const loadedSession = await loadSession(new Request("http://localhost/api/account/state", { headers: { cookie } }));
  assert(loadedSession, "expected session to load back from signed cookie");
  assert.equal(loadedSession.subject, session.subject);

  const walletId = `wallet-${Date.now()}`;
  const txId = `draft-${Date.now()}`;
  const accountSnapshot = await replaceAccountSnapshot(loadedSession, {
    wallets: [
      {
        id: walletId,
        name: "QA wallet",
        network: "preprod",
        threshold: 1,
        signers: [{ id: `signer-${identity.keyHash}`, keyHash: identity.keyHash, label: "QA signer", source: "manual" }],
        script: { type: "sig", keyHash: identity.keyHash },
        createdAt: nowIso(),
        imported: true,
      },
    ],
    transactions: [
      {
        id: txId,
        walletId,
        title: "Postgres smoke tx",
        walletName: "QA wallet",
        network: "preprod",
        recipient: "addr_test1vr9dummy000000000000000000000000000000000000000000000",
        lovelace: "1000000",
        note: "postgres smoke",
        unsignedTxCbor: "84a40081825820deadbeef",
        requiredSignatures: 1,
        signerKeyHashes: [identity.keyHash],
        signatures: [],
        createdAt: nowIso(),
        status: "pending",
      },
    ],
  });
  assert.equal(accountSnapshot.wallets.length, 1);
  assert.equal(accountSnapshot.transactions.length, 1);

  const reloadedSnapshot = await loadAccountSnapshot(loadedSession);
  assert.equal(reloadedSnapshot.wallets.length, 1);
  assert.equal(reloadedSnapshot.transactions.length, 1);

  const relayRoom = await createRelayRoom({
    network: "preprod",
    tx: {
      draftId: txId,
      walletId,
      walletName: "QA wallet",
      title: "Postgres smoke tx",
      note: "postgres smoke",
      recipient: "addr_test1vr9dummy000000000000000000000000000000000000000000000",
      lovelace: "1000000",
      assets: [],
      unsignedTxCbor: "84a40081825820deadbeef",
      requiredSignatures: 1,
      signerKeyHashes: [identity.keyHash],
    },
    signers: [{ keyHash: identity.keyHash, label: "QA signer" }],
  });

  const coordinatorSession = await resolveRelayTokenSession(relayRoom.coordinatorToken);
  assert(coordinatorSession && coordinatorSession.role === "coordinator", "expected coordinator session");

  const persistedRoom = await readRelayRoom(relayRoom.room.id);
  persistedRoom.submission = { txHash: "b4".repeat(32), submittedAt: nowIso() };
  persistedRoom.updatedAt = nowIso();
  await writeRelayRoom(persistedRoom);

  const reloadedRoom = await readRelayRoom(relayRoom.room.id);
  assert.equal(reloadedRoom.submission?.txHash, "b4".repeat(32));

  console.log(
    JSON.stringify(
      {
        ok: true,
        subject: session.subject,
        walletCount: reloadedSnapshot.wallets.length,
        transactionCount: reloadedSnapshot.transactions.length,
        relayRoomId: relayRoom.room.id,
        submissionTxHash: reloadedRoom.submission?.txHash,
      },
      null,
      2,
    ),
  );
}

await main();
