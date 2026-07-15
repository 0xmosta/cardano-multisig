import type { PoolClient } from "pg";
import type { RelayRoomWitnessRecord } from "../relay-room";
import type { RelayRoomRecord, RelayRoomTokenSession } from "./relay-room-store";
import { withClient, withTransaction } from "./postgres";
import { decryptWitness, encryptWitness } from "./witness-crypto";

type RelayRoomRow = {
  id: string;
  network: string;
  owner_subject: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
  tx_json: unknown;
  coordinator_token_hash: string;
  coordinator_last_seen_at: Date | string | null;
  shared_signer_token_hash: string | null;
  shared_signer_last_seen_at: Date | string | null;
  submission_tx_hash: string | null;
  submission_submitted_at: Date | string | null;
  submission_failure_error: string | null;
  submission_failure_failed_at: Date | string | null;
};

type RelaySignerRow = {
  room_id: string;
  key_hash: string;
  label: string | null;
  token_hash: string;
  created_at: Date | string;
  last_seen_at: Date | string | null;
  delivered_at: Date | string | null;
};

// Raw witness CBOR stays server-side only for coordinator-side assembly/submission.
// Signer/viewer payloads must come from the redacted projections in relay-room-store.ts.
type RelayWitnessRow = {
  room_id: string;
  witness_id: string;
  source: string;
  signer_key_hash_claim: string | null;
  matched_signer_key_hash: string | null;
  witness_cbor: string;
  wallet_name: string | null;
  signer_name: string | null;
  signed_at: Date | string;
  received_at: Date | string;
  match_status: string;
};

function asIso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : undefined;
}

function roomFromRows(room: RelayRoomRow, signers: RelaySignerRow[], witnesses: RelayWitnessRow[]): RelayRoomRecord {
  return {
    id: room.id,
    network: room.network as RelayRoomRecord["network"],
    ownerSubject: room.owner_subject || undefined,
    status: room.status as RelayRoomRecord["status"],
    createdAt: new Date(room.created_at).toISOString(),
    updatedAt: new Date(room.updated_at).toISOString(),
    expiresAt: new Date(room.expires_at).toISOString(),
    tx: room.tx_json as RelayRoomRecord["tx"],
    coordinator: {
      tokenHash: room.coordinator_token_hash,
      lastSeenAt: asIso(room.coordinator_last_seen_at),
    },
    sharedSigner: room.shared_signer_token_hash
      ? {
          tokenHash: room.shared_signer_token_hash,
          lastSeenAt: asIso(room.shared_signer_last_seen_at),
        }
      : undefined,
    signers: signers.map((signer) => ({
      keyHash: signer.key_hash,
      label: signer.label || undefined,
      tokenHash: signer.token_hash,
      createdAt: new Date(signer.created_at).toISOString(),
      lastSeenAt: asIso(signer.last_seen_at),
      deliveredAt: asIso(signer.delivered_at),
    })),
    witnesses: witnesses.map((witness) => ({
      id: witness.witness_id,
      source: witness.source === "manual" ? "manual" : "relay",
      signerKeyHashClaim: witness.signer_key_hash_claim || undefined,
      matchedSignerKeyHash: witness.matched_signer_key_hash || undefined,
      witnessCbor: decryptWitness(witness.witness_cbor),
      walletName: witness.wallet_name || undefined,
      signerName: witness.signer_name || undefined,
      signedAt: new Date(witness.signed_at).toISOString(),
      receivedAt: new Date(witness.received_at).toISOString(),
      matchStatus: witness.match_status === "unmatched" ? "unmatched" : "matched",
    })),
    submission: room.submission_tx_hash && room.submission_submitted_at
      ? {
          txHash: room.submission_tx_hash,
          submittedAt: new Date(room.submission_submitted_at).toISOString(),
        }
      : undefined,
    submissionFailure: room.submission_failure_error && room.submission_failure_failed_at
      ? {
          error: room.submission_failure_error,
          failedAt: new Date(room.submission_failure_failed_at).toISOString(),
        }
      : undefined,
  };
}

async function loadRelated(client: PoolClient, roomIds: string[]) {
  if (!roomIds.length) {
    return { signersByRoom: new Map<string, RelaySignerRow[]>(), witnessesByRoom: new Map<string, RelayWitnessRow[]>() };
  }
  const signers = await client.query<RelaySignerRow>(
    `select room_id, key_hash, label, token_hash, created_at, last_seen_at, delivered_at
     from cm_relay_room_signers where room_id = any($1::text[]) order by created_at asc`,
    [roomIds],
  );
  const witnesses = await client.query<RelayWitnessRow>(
    `select room_id, witness_id, source, signer_key_hash_claim, matched_signer_key_hash,
            witness_cbor, wallet_name, signer_name, signed_at, received_at, match_status
     from cm_relay_room_witnesses where room_id = any($1::text[]) order by received_at asc`,
    [roomIds],
  );
  const signersByRoom = new Map<string, RelaySignerRow[]>();
  const witnessesByRoom = new Map<string, RelayWitnessRow[]>();
  for (const signer of signers.rows) {
    signersByRoom.set(signer.room_id, [...(signersByRoom.get(signer.room_id) || []), signer]);
  }
  for (const witness of witnesses.rows) {
    witnessesByRoom.set(witness.room_id, [...(witnessesByRoom.get(witness.room_id) || []), witness]);
  }
  return { signersByRoom, witnessesByRoom };
}

export async function readRelayRoomPostgres(roomId: string) {
  return withClient(async (client) => {
    const roomResult = await client.query<RelayRoomRow>(`select * from cm_relay_rooms where id = $1`, [roomId]);
    const room = roomResult.rows[0];
    if (!room) throw new Error(`Relay room ${roomId} was not found.`);
    const { signersByRoom, witnessesByRoom } = await loadRelated(client, [roomId]);
    return roomFromRows(room, signersByRoom.get(roomId) || [], witnessesByRoom.get(roomId) || []);
  });
}

export async function writeRelayRoomPostgres(room: RelayRoomRecord) {
  await withTransaction(async (client) => {
    await client.query(
      `insert into cm_relay_rooms (
        id, network, owner_subject, status, created_at, updated_at, expires_at, tx_json,
        coordinator_token_hash, coordinator_last_seen_at,
        shared_signer_token_hash, shared_signer_last_seen_at,
        submission_tx_hash, submission_submitted_at,
        submission_failure_error, submission_failure_failed_at
      ) values (
        $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::jsonb,
        $9, $10::timestamptz, $11, $12::timestamptz, $13, $14::timestamptz, $15, $16::timestamptz
      ) on conflict (id) do update set
        network = excluded.network,
        owner_subject = excluded.owner_subject,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at,
        tx_json = excluded.tx_json,
        coordinator_token_hash = excluded.coordinator_token_hash,
        coordinator_last_seen_at = excluded.coordinator_last_seen_at,
        shared_signer_token_hash = excluded.shared_signer_token_hash,
        shared_signer_last_seen_at = excluded.shared_signer_last_seen_at,
        submission_tx_hash = excluded.submission_tx_hash,
        submission_submitted_at = excluded.submission_submitted_at,
        submission_failure_error = excluded.submission_failure_error,
        submission_failure_failed_at = excluded.submission_failure_failed_at`,
      [
        room.id,
        room.network,
        room.ownerSubject || null,
        room.status,
        room.createdAt,
        room.updatedAt,
        room.expiresAt,
        JSON.stringify(room.tx),
        room.coordinator.tokenHash,
        room.coordinator.lastSeenAt || null,
        room.sharedSigner?.tokenHash || null,
        room.sharedSigner?.lastSeenAt || null,
        room.submission?.txHash || null,
        room.submission?.submittedAt || null,
        room.submissionFailure?.error || null,
        room.submissionFailure?.failedAt || null,
      ],
    );
    await client.query(`delete from cm_relay_room_signers where room_id = $1`, [room.id]);
    for (const signer of room.signers) {
      await client.query(
        `insert into cm_relay_room_signers (
          room_id, key_hash, label, token_hash, created_at, last_seen_at, delivered_at
        ) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
        [room.id, signer.keyHash, signer.label || null, signer.tokenHash, signer.createdAt, signer.lastSeenAt || null, signer.deliveredAt || null],
      );
    }
    await client.query(`delete from cm_relay_room_witnesses where room_id = $1`, [room.id]);
    for (const witness of room.witnesses) {
      await client.query(
        `insert into cm_relay_room_witnesses (
          room_id, witness_id, source, signer_key_hash_claim, matched_signer_key_hash,
          witness_cbor, wallet_name, signer_name, signed_at, received_at, match_status
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11)`,
        [
          room.id,
          witness.id,
          witness.source,
          witness.signerKeyHashClaim || null,
          witness.matchedSignerKeyHash || null,
          encryptWitness(witness.witnessCbor),
          witness.walletName || null,
          witness.signerName || null,
          witness.signedAt,
          witness.receivedAt,
          witness.matchStatus,
        ],
      );
    }
  });
}

export async function listRelayRoomsPostgres() {
  return withClient(async (client) => {
    const roomResult = await client.query<RelayRoomRow>(`select * from cm_relay_rooms order by created_at asc`);
    const roomIds = roomResult.rows.map((row) => row.id);
    const { signersByRoom, witnessesByRoom } = await loadRelated(client, roomIds);
    return roomResult.rows.map((room) => roomFromRows(room, signersByRoom.get(room.id) || [], witnessesByRoom.get(room.id) || []));
  });
}

export async function cleanupExpiredRelayRoomsPostgres() {
  await withClient((client) =>
    client.query(
      `update cm_relay_rooms set status = 'expired', updated_at = now()
       where status = 'open' and expires_at < now()`,
    ),
  );
}

export async function resolveRelayTokenSessionPostgres(tokenHash: string): Promise<RelayRoomTokenSession | null> {
  return withClient(async (client) => {
    await client.query(`update cm_relay_rooms set status = 'expired', updated_at = now() where status = 'open' and expires_at < now()`);

    const directRoom = await client.query<RelayRoomRow>(
      `select * from cm_relay_rooms
       where coordinator_token_hash = $1 or shared_signer_token_hash = $1
       order by created_at desc limit 1`,
      [tokenHash],
    );
    if (directRoom.rows[0]) {
      const room = directRoom.rows[0];
      const { signersByRoom, witnessesByRoom } = await loadRelated(client, [room.id]);
      const hydrated = roomFromRows(room, signersByRoom.get(room.id) || [], witnessesByRoom.get(room.id) || []);
      if (room.coordinator_token_hash === tokenHash) return { role: "coordinator", room: hydrated };
      return { role: "shared-signer", room: hydrated };
    }

    const signerResult = await client.query<RelaySignerRow>(
      `select room_id, key_hash, label, token_hash, created_at, last_seen_at, delivered_at
       from cm_relay_room_signers where token_hash = $1 order by created_at desc limit 1`,
      [tokenHash],
    );
    const signer = signerResult.rows[0];
    if (!signer) return null;
    const roomResult = await client.query<RelayRoomRow>(`select * from cm_relay_rooms where id = $1`, [signer.room_id]);
    const room = roomResult.rows[0];
    if (!room) return null;
    const { signersByRoom, witnessesByRoom } = await loadRelated(client, [room.id]);
    const hydrated = roomFromRows(room, signersByRoom.get(room.id) || [], witnessesByRoom.get(room.id) || []);
    const hydratedSigner = hydrated.signers.find((entry) => entry.tokenHash === tokenHash);
    if (!hydratedSigner) return null;
    return { role: "signer", room: hydrated, signer: hydratedSigner };
  });
}

export async function removeRelayRoomPostgres(roomId: string) {
  await withClient((client) => client.query(`delete from cm_relay_rooms where id = $1`, [roomId]));
}
