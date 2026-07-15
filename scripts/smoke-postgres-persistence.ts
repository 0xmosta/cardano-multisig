import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { createIdentity, createSession, listAccountSessions, loadAccountSnapshot, loadSession, replaceAccountSnapshot, revokeAccountSession } from "../app/lib/server/account-store.ts";
import { query } from "../app/lib/server/postgres.ts";
import { createRelayRoom, readRelayRoom, resolveRelayTokenSession, writeRelayRoom } from "../app/lib/server/relay-room-store.ts";
import { action as accountStateAction } from "../app/routes/api.account.state.ts";

const execFile = promisify(execFileCallback);

function nowIso() {
  return new Date().toISOString();
}

async function writeImportFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cardano-multisig-import-"));
  const network = process.env.CARDANO_NETWORK || "preprod";
  const subject = `import-subject-${Date.now()}`;
  const txId = `import-draft-${Date.now()}`;
  const witnessCbor = "84a20081825820feedface";
  const accountDir = path.join(root, "accounts", network);
  await mkdir(accountDir, { recursive: true });
  await writeFile(
    path.join(accountDir, `${subject}.json`),
    JSON.stringify(
      {
        subject,
        network,
        identities: [],
        wallets: [],
        transactions: [
          {
            id: txId,
            title: "Imported tx",
            walletName: "Imported wallet",
            network,
            recipient: "addr_test1vr9dummy000000000000000000000000000000000000000000000",
            lovelace: "2000000",
            note: "fixture",
            unsignedTxCbor: "84a40081825820feedface",
            requiredSignatures: 1,
            signerKeyHashes: ["22".repeat(28)],
            signatures: [
              {
                signerKeyHash: "22".repeat(28),
                signerName: "Fixture signer",
                walletName: "Imported wallet",
                witnessCbor,
                signedAt: nowIso(),
              },
            ],
            createdAt: nowIso(),
            updatedAt: nowIso(),
            status: "pending",
          },
        ],
        auditEvents: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
      null,
      2,
    ),
  );
  return { root, subject, txId, witnessCbor, network };
}

async function writeMixedNetworkImportFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cardano-multisig-import-mixed-"));
  const targetNetwork = process.env.CARDANO_NETWORK || "preprod";
  const extraNetwork = targetNetwork === "mainnet" ? "preprod" : "mainnet";
  const createdAt = nowIso();

  for (const fixture of [
    { network: targetNetwork, subject: `mixed-target-${Date.now()}` },
    { network: extraNetwork, subject: `mixed-extra-${Date.now()}` },
  ]) {
    const accountDir = path.join(root, "accounts", fixture.network);
    await mkdir(accountDir, { recursive: true });
    await writeFile(
      path.join(accountDir, `${fixture.subject}.json`),
      JSON.stringify(
        {
          subject: fixture.subject,
          network: fixture.network,
          identities: [],
          wallets: [],
          transactions: [],
          auditEvents: [],
          createdAt,
          updatedAt: createdAt,
        },
        null,
        2,
      ),
    );
  }

  return { root, targetNetwork, extraNetwork };
}

async function main() {
  const identity = createIdentity({
    kind: "payment",
    keyHash: "11".repeat(28),
    addressHex: "01".repeat(57),
  });

  const { session, cookie } = await createSession(identity, process.env.CARDANO_NETWORK || "preprod", { userAgent: "Postgres smoke browser" });
  const loadedSession = await loadSession(new Request("http://localhost/api/account/state", { headers: { cookie } }));
  assert(loadedSession, "expected session to load back from signed cookie");
  assert.equal(loadedSession.subject, session.subject);

  const walletId = `wallet-${Date.now()}`;
  const txId = `draft-${Date.now()}`;
  const relayCapability = "c".repeat(43);
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
        signatures: [
          {
            signerKeyHash: identity.keyHash,
            signerName: "QA signer",
            walletName: "QA wallet",
            witnessCbor: "84a10081825820deadc0de",
            signedAt: nowIso(),
          },
        ],
        createdAt: nowIso(),
        status: "pending",
        relayRoom: {
          roomId: `room-${Date.now()}`,
          coordinatorToken: relayCapability,
          sharedInviteUrl: `http://localhost/sign#r=${relayCapability}`,
          signerInvites: [{ keyHash: identity.keyHash, label: "QA signer", inviteUrl: `http://localhost/sign#r=${relayCapability}` }],
          createdAt: nowIso(),
          status: "open",
        },
      },
    ],
    contacts: [{
      id: `contact-${Date.now()}`,
      label: "Smoke supplier",
      address: "addr_test1smokesupplier000000000000000000000000000000000000000000",
      handle: "smokesupplier",
      network: "preprod",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }],
    preferences: { notificationsEnabled: true, defaultTransactionFilter: "ready", preferredWalletId: walletId },
  });
  assert.equal(accountSnapshot.wallets.length, 1);
  assert.equal(accountSnapshot.transactions.length, 1);
  assert.equal(accountSnapshot.contacts?.length, 1);
  assert.equal(accountSnapshot.preferences?.defaultTransactionFilter, "ready");

  const second = await createSession(identity, process.env.CARDANO_NETWORK || "preprod", { userAgent: "Second smoke device" });
  const sessions = await listAccountSessions(session);
  assert(sessions.some((item) => item.id === session.id && item.userAgent === "Postgres smoke browser"));
  assert(sessions.some((item) => item.id === second.session.id && item.userAgent === "Second smoke device"));
  assert.equal(await revokeAccountSession(session, second.session.id), true);
  assert.equal((await listAccountSessions(session)).some((item) => item.id === second.session.id), false);

  await query(
    `update cm_accounts
     set updated_at = date_trunc('second', updated_at) + interval '654321 microseconds'
     where network = $1 and subject = $2`,
    [loadedSession.network, loadedSession.subject],
  );

  const reloadedSnapshot = await loadAccountSnapshot(loadedSession);
  assert.equal(reloadedSnapshot.wallets.length, 1);
  assert.equal(reloadedSnapshot.transactions.length, 1);
  assert.equal(reloadedSnapshot.contacts?.[0]?.label, "Smoke supplier");
  assert.equal(reloadedSnapshot.preferences?.preferredWalletId, walletId);
  assert.equal(reloadedSnapshot.transactions[0]?.relayRoom?.coordinatorToken, relayCapability);
  assert.equal(reloadedSnapshot.transactions[0]?.relayRoom?.signerInvites?.[0]?.inviteUrl, `http://localhost/sign#r=${relayCapability}`);
  assert.equal(
    (reloadedSnapshot.transactions[0]?.signatures[0] as unknown as { witnessCiphertext?: string })?.witnessCiphertext,
    undefined,
    "expected encrypted witness storage fields to stay server-side",
  );
  assert(reloadedSnapshot.updatedAt, "expected a server snapshot version");
  assert.match(reloadedSnapshot.updatedAt, /\.\d{6}Z$/, "expected the account version to preserve PostgreSQL microseconds");
  const noOpSnapshot = await replaceAccountSnapshot(
    loadedSession,
    { wallets: reloadedSnapshot.wallets, transactions: reloadedSnapshot.transactions },
    "smoke.no-op-replace",
    reloadedSnapshot.updatedAt,
  );
  assert.equal(noOpSnapshot.updatedAt, reloadedSnapshot.updatedAt, "expected identical account writes to remain a no-op");
  const legacyMillisecondVersion = reloadedSnapshot.updatedAt.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
  const versionedSnapshot = await replaceAccountSnapshot(
    loadedSession,
    {
      wallets: reloadedSnapshot.wallets,
      transactions: reloadedSnapshot.transactions.map((tx) =>
        tx.id === txId ? { ...tx, note: `${tx.note} versioned` } : tx,
      ),
    },
    "smoke.versioned-replace",
    legacyMillisecondVersion,
  );
  await assert.rejects(
    replaceAccountSnapshot(
      loadedSession,
      { wallets: reloadedSnapshot.wallets, transactions: reloadedSnapshot.transactions },
      "smoke.stale-replace",
      reloadedSnapshot.updatedAt,
    ),
    /Server account state changed in another tab/,
  );
  const conflictResponse = await accountStateAction({
    request: new Request("http://localhost/api/account/state", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
        "x-cardano-multisig-csrf": loadedSession.csrfToken,
      },
      body: JSON.stringify({
        intent: "replace",
        baseUpdatedAt: reloadedSnapshot.updatedAt,
        wallets: reloadedSnapshot.wallets,
        transactions: reloadedSnapshot.transactions,
      }),
    }),
  });
  assert.equal(conflictResponse.status, 409, "expected stale account writes to return HTTP 409");
  const storedAccountTx = await query<{ tx_json: { signatures?: Array<{ witnessCiphertext?: string; witnessCbor?: string }>; relayRoom?: { capabilityCiphertext?: string; coordinatorToken?: string; sharedInviteUrl?: string; signerInvites?: unknown[] } } }>(
    `select tx_json from cm_account_transactions where network = $1 and subject = $2 and tx_id = $3`,
    [loadedSession.network, loadedSession.subject, txId],
  );
  const storedSignature = storedAccountTx.rows[0]?.tx_json?.signatures?.[0];
  assert(storedSignature, "expected persisted account signature");
  assert.equal(storedSignature?.witnessCbor, undefined);
  assert.match(storedSignature?.witnessCiphertext || "", /^enc1:/);
  const storedRelayRoom = storedAccountTx.rows[0]?.tx_json?.relayRoom;
  assert.match(storedRelayRoom?.capabilityCiphertext || "", /^sec1:/);
  assert.equal(storedRelayRoom?.coordinatorToken, undefined);
  assert.equal(storedRelayRoom?.sharedInviteUrl, undefined);
  assert.equal(storedRelayRoom?.signerInvites, undefined);

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
    witnesses: [
      {
        id: `witness-${Date.now()}`,
        source: "manual",
        signerKeyHashClaim: identity.keyHash,
        matchedSignerKeyHash: identity.keyHash,
        witnessCbor: "84a10081825820cafebabe",
        walletName: "QA wallet",
        signerName: "QA signer",
        signedAt: nowIso(),
        receivedAt: nowIso(),
        matchStatus: "matched",
      },
    ],
  });

  const coordinatorSession = await resolveRelayTokenSession(relayRoom.coordinatorToken);
  assert(coordinatorSession && coordinatorSession.role === "coordinator", "expected coordinator session");

  const persistedRoom = await readRelayRoom(relayRoom.room.id);
  assert.equal(persistedRoom.witnesses[0]?.witnessCbor, "84a10081825820cafebabe");
  const storedWitness = await query<{ witness_cbor: string }>(
    `select witness_cbor from cm_relay_room_witnesses where room_id = $1 order by received_at asc limit 1`,
    [relayRoom.room.id],
  );
  assert.notEqual(storedWitness.rows[0]?.witness_cbor, "84a10081825820cafebabe");
  assert.match(storedWitness.rows[0]?.witness_cbor || "", /^enc1:/);
  persistedRoom.submission = { txHash: "b4".repeat(32), submittedAt: nowIso() };
  persistedRoom.updatedAt = nowIso();
  await writeRelayRoom(persistedRoom);

  const reloadedRoom = await readRelayRoom(relayRoom.room.id);
  assert.equal(reloadedRoom.submission?.txHash, "b4".repeat(32));

  const importFixture = await writeImportFixture();
  await execFile("node", [path.resolve("scripts/import-file-store.mjs")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CARDANO_MULTISIG_DATA_DIR: importFixture.root,
    },
  });
  const importedTx = await query<{ tx_json: { signatures?: Array<{ witnessCiphertext?: string; witnessCbor?: string }> } }>(
    `select tx_json from cm_account_transactions where network = $1 and subject = $2 and tx_id = $3`,
    [importFixture.network, importFixture.subject, importFixture.txId],
  );
  const importedSignature = importedTx.rows[0]?.tx_json?.signatures?.[0];
  assert(importedSignature, "expected imported account signature");
  assert.equal(importedSignature?.witnessCbor, undefined);
  assert.notEqual(importedSignature?.witnessCiphertext, importFixture.witnessCbor);
  assert.match(importedSignature?.witnessCiphertext || "", /^enc1:/);

  const mixedImportFixture = await writeMixedNetworkImportFixture();
  await assert.rejects(
    execFile("node", [path.resolve("scripts/import-file-store.mjs")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CARDANO_MULTISIG_DATA_DIR: mixedImportFixture.root,
        CARDANO_NETWORK: mixedImportFixture.targetNetwork,
        VITE_CARDANO_NETWORK: mixedImportFixture.targetNetwork,
      },
    }),
    (error) => {
      assert.match(error instanceof Error ? error.message : String(error), new RegExp(`Refusing to import ${mixedImportFixture.extraNetwork} state`));
      return true;
    },
    "expected mixed-network import fixture to be rejected",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        subject: session.subject,
        walletCount: versionedSnapshot.wallets.length,
        transactionCount: versionedSnapshot.transactions.length,
        staleSnapshotRejected: true,
        staleSnapshotReturnsConflict: true,
        postgresVersionPrecisionPreserved: true,
        legacyMillisecondVersionAccepted: true,
        identicalSnapshotWriteSkipped: true,
        importedTransactionEncrypted: true,
        relayCapabilitiesEncrypted: true,
        mixedNetworkImportRejected: true,
        relayRoomId: relayRoom.room.id,
        submissionTxHash: reloadedRoom.submission?.txHash,
      },
      null,
      2,
    ),
  );
}

await main();
