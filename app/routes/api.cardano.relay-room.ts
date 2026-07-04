import { randomBytes } from "node:crypto";
import * as CSL from "@emurgo/cardano-serialization-lib-browser";
import { normalizeKeyHash } from "../lib/multisig";
import {
  type RelayRoomCreateRequest,
  type RelayRoomSessionRequest,
  type RelayRoomSignRequest,
  type RelayRoomSubmitRequest,
  type RelayRoomWitnessRecord,
  relayInviteUrl,
} from "../lib/relay-room";
import { submitErrorMessage, submitSignedTransaction } from "../lib/server/cardano-submit";
import { buildSignedRelayTransactionCbor } from "../lib/server/relay-submit";
import type { RelayRoomRecord } from "../lib/server/relay-room-store";
import { verifiedWitnessKeyHashes } from "../lib/witness-verification";

const MAX_RELAY_REQUEST_BYTES = 1_000_000;
const MAX_WITNESS_CBOR_CHARS = 100_000;
const MAX_TEXT_FIELD_CHARS = 500;

async function relayStore() {
  return import("../lib/server/relay-room-store");
}

function requestOrigin(request: Request) {
  const configuredOrigin = normalizedHttpOrigin(process.env.CARDANO_MULTISIG_PUBLIC_ORIGIN);
  if (configuredOrigin) return configuredOrigin;
  if ((process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new Error("CARDANO_MULTISIG_PUBLIC_ORIGIN is required before relay invite URLs can be created in production.");
  }

  const forwardedHost = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0]?.trim();
  const forwardedProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim().toLowerCase();
  if (forwardedHost) {
    const hostname = forwardedHost.split(":")[0] || "";
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const proto =
      forwardedProto === "http" || forwardedProto === "https"
        ? forwardedProto
        : isLocalHost
          ? new URL(request.url).protocol.replace(/:$/, "")
          : "https";
    const origin = normalizedHttpOrigin(`${proto}://${forwardedHost}`);
    if (origin) return origin;
  }

  return new URL(request.url).origin;
}

function normalizedHttpOrigin(value: string | null | undefined) {
  const input = (value || "").trim();
  if (!input) return null;
  try {
    const origin = new URL(input).origin;
    return origin.startsWith("http://") || origin.startsWith("https://") ? origin : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Relay room request failed.";
  }
}

async function limitedJson(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RELAY_REQUEST_BYTES) {
    throw new Error("Relay room request payload is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RELAY_REQUEST_BYTES) {
    throw new Error("Relay room request payload is too large.");
  }
  return JSON.parse(text) as unknown;
}

function randomRecordId(prefix: string) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function boundedOptionalString(value: unknown, field: string, maxLength: number) {
  const next = String(value || "").trim();
  if (!next) return undefined;
  if (next.length > maxLength) throw new Error(`${field} is too long.`);
  return next;
}

function assertObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid relay room request payload.");
  }
  return value as Record<string, unknown>;
}

function assertIntent(body: unknown) {
  const input = assertObject(body);
  const intent = String(input.intent || "").trim();
  if (!intent) throw new Error("Relay room intent is required.");
  return { intent, input };
}

async function configuredNetworkGuard(requestedNetwork: string) {
  const { configuredNetwork } = await relayStore();
  const network = configuredNetwork();
  if (requestedNetwork !== network) {
    throw new Error(`Relay room targets ${requestedNetwork}, but this deployment is configured for ${network}.`);
  }
  if (network === "mainnet" && process.env.CARDANO_MULTISIG_ENABLE_MAINNET_RELAY !== "1") {
    throw new Error("Mainnet relay rooms are disabled unless CARDANO_MULTISIG_ENABLE_MAINNET_RELAY=1 is set.");
  }
  return network;
}

function assertRelaySessionPayload(raw: Record<string, unknown>): RelayRoomSessionRequest {
  const token = String(raw.token || "").trim();
  if (!token) throw new Error("Relay session token is required.");
  return { intent: "session", token };
}

function assertRelaySignPayload(raw: Record<string, unknown>): RelayRoomSignRequest {
  const token = String(raw.token || "").trim();
  const witnessCbor = String(raw.witnessCbor || "").trim().toLowerCase();
  if (!token) throw new Error("Relay signer token is required.");
  if (!witnessCbor) throw new Error("witnessCbor is required.");
  if (witnessCbor.length > MAX_WITNESS_CBOR_CHARS) throw new Error("witnessCbor is too large.");
  if (!/^[0-9a-f]+$/i.test(witnessCbor) || witnessCbor.length % 2 !== 0) {
    throw new Error("witnessCbor must be hex-encoded CBOR.");
  }
  return {
    intent: "sign",
    token,
    witnessCbor,
    walletName: boundedOptionalString(raw.walletName, "walletName", MAX_TEXT_FIELD_CHARS),
    signerName: boundedOptionalString(raw.signerName, "signerName", MAX_TEXT_FIELD_CHARS),
    signedAt: boundedOptionalString(raw.signedAt, "signedAt", MAX_TEXT_FIELD_CHARS),
  };
}

function assertRelaySubmitPayload(raw: Record<string, unknown>): RelayRoomSubmitRequest {
  const token = String(raw.token || "").trim();
  const txHash = String(raw.txHash || "").trim().toLowerCase();
  if (!token) throw new Error("Relay coordinator token is required.");
  if (!/^[0-9a-f]{64}$/i.test(txHash)) throw new Error("txHash must be a 64-character hex string.");
  return { intent: "submit", token, txHash };
}

function initialWitnessRecords(
  witnesses: unknown,
  unsignedTxCbor: string,
  signerKeyHashes: string[],
): RelayRoomWitnessRecord[] {
  if (!Array.isArray(witnesses)) return [];
  const expected = new Set(signerKeyHashes.map((keyHash) => normalizeKeyHash(keyHash)));
  const receivedAt = new Date().toISOString();
  const initial: RelayRoomWitnessRecord[] = [];
  const seen = new Set<string>();

  for (const item of witnesses) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const witnessCbor = String(raw.witnessCbor || "").trim().toLowerCase();
    if (!witnessCbor) continue;
    if (witnessCbor.length > MAX_WITNESS_CBOR_CHARS || witnessCbor.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(witnessCbor)) continue;

    let verified: string[];
    try {
      verified = verifiedWitnessKeyHashes(unsignedTxCbor, witnessCbor).map((keyHash) => normalizeKeyHash(keyHash));
    } catch {
      continue;
    }
    const matchedSignerKeyHash = verified.find((keyHash) => expected.has(keyHash));
    if (!matchedSignerKeyHash || seen.has(matchedSignerKeyHash)) continue;
    seen.add(matchedSignerKeyHash);

    initial.push({
      id: randomRecordId("initial"),
      source: "manual",
      signerKeyHashClaim: normalizeKeyHash(String(raw.signerKeyHash || matchedSignerKeyHash)),
      matchedSignerKeyHash,
      witnessCbor,
      walletName: boundedOptionalString(raw.walletName, "walletName", MAX_TEXT_FIELD_CHARS),
      signerName: boundedOptionalString(raw.signerName, "signerName", MAX_TEXT_FIELD_CHARS),
      signedAt: boundedOptionalString(raw.signedAt, "signedAt", MAX_TEXT_FIELD_CHARS) || receivedAt,
      receivedAt,
      matchStatus: "matched",
    });
  }

  return initial;
}

async function autoSubmitRelayRoomIfReady(room: RelayRoomRecord) {
  const { relayProgress, replaceRelayRoomFile } = await relayStore();
  let submitError = "";
  const nextRoom = await replaceRelayRoomFile(room, async (current) => {
    if (current.status !== "open" || current.submission?.txHash) return current;
    const progress = relayProgress(current);
    if (progress.matchedCount < progress.requiredSignatures) return current;
    const recentFailureAt = Date.parse(current.submissionFailure?.failedAt || "");
    if (Number.isFinite(recentFailureAt) && Date.now() - recentFailureAt < 45_000) {
      submitError = current.submissionFailure?.error || "Automatic submit is cooling down after a failed attempt.";
      return current;
    }

    try {
      const signedTxCbor = buildSignedRelayTransactionCbor(current);
      const submitted = await submitSignedTransaction(signedTxCbor, current.network);
      return {
        ...current,
        status: "submitted" as const,
        updatedAt: new Date().toISOString(),
        submission: {
          txHash: submitted.txHash,
          submittedAt: new Date().toISOString(),
        },
        submissionFailure: undefined,
      };
    } catch (error) {
      submitError = submitErrorMessage(error);
      console.error(`relay auto submit failed for room ${current.id}: ${submitError}`);
      return {
        ...current,
        updatedAt: new Date().toISOString(),
        submissionFailure: {
          error: submitError,
          failedAt: new Date().toISOString(),
        },
      };
    }
  });
  return { room: nextRoom, submitError };
}

async function handleCreate(request: Request, raw: Record<string, unknown>) {
  const { assertRelayCreatePayload, createRelayRoom } = await relayStore();
  const payload = assertRelayCreatePayload(raw as unknown as RelayRoomCreateRequest);
  await configuredNetworkGuard(payload.network);
  CSL.Transaction.from_hex(payload.tx.unsignedTxCbor);
  const created = await createRelayRoom({
    network: payload.network,
    tx: payload.tx,
    signers: payload.signers,
    witnesses: initialWitnessRecords(raw.witnesses, payload.tx.unsignedTxCbor, payload.tx.signerKeyHashes),
  });
  const origin = requestOrigin(request);
  return Response.json({
    ok: true,
    roomId: created.room.id,
    coordinatorToken: created.coordinatorToken,
    sharedInviteUrl: relayInviteUrl(origin, created.sharedSignerToken),
    signerInvites: created.signerTokens.map((signer) => ({
      keyHash: signer.keyHash,
      label: signer.label,
      inviteUrl: relayInviteUrl(origin, signer.token),
    })),
    expiresAt: created.room.expiresAt,
  });
}

async function handleSession(raw: Record<string, unknown>) {
  const { coordinatorRoomView, replaceRelayRoomFile, resolveRelayTokenSession, sharedSignerRoomView, signerRoomView, syncEquivalentRelayRoomWitnesses } = await relayStore();
  const payload = assertRelaySessionPayload(raw);
  const session = await resolveRelayTokenSession(payload.token);
  if (!session) throw new Error("Relay room not found or invite has expired.");
  await configuredNetworkGuard(session.room.network);

  const current = await replaceRelayRoomFile(session.room, (room) => {
    const seenAt = new Date().toISOString();
    if (session.role === "coordinator") {
      return {
        ...room,
        updatedAt: seenAt,
        coordinator: { ...room.coordinator, lastSeenAt: seenAt },
      };
    }
    if (session.role === "shared-signer") {
      return {
        ...room,
        updatedAt: seenAt,
        sharedSigner: room.sharedSigner ? { ...room.sharedSigner, lastSeenAt: seenAt } : room.sharedSigner,
      };
    }
    return {
      ...room,
      updatedAt: seenAt,
      signers: room.signers.map((signer) =>
        signer.keyHash === session.signer.keyHash ? { ...signer, lastSeenAt: seenAt } : signer,
      ),
    };
  });
  const synced = await syncEquivalentRelayRoomWitnesses(current);
  const autoSubmitted = await autoSubmitRelayRoomIfReady(synced);

  if (session.role === "coordinator") {
    return Response.json({ ok: true, role: "coordinator", room: coordinatorRoomView(autoSubmitted.room), autoSubmitError: autoSubmitted.submitError || undefined });
  }
  if (session.role === "shared-signer") {
    return Response.json({ ok: true, role: "signer", room: sharedSignerRoomView(autoSubmitted.room), autoSubmitError: autoSubmitted.submitError || undefined });
  }

  const signer = autoSubmitted.room.signers.find((item) => item.keyHash === session.signer.keyHash);
  if (!signer) throw new Error("Relay signer is no longer available for this room.");
  return Response.json({ ok: true, role: "signer", room: signerRoomView(autoSubmitted.room, signer), autoSubmitError: autoSubmitted.submitError || undefined });
}

async function handleSign(raw: Record<string, unknown>) {
  const { relayProgress, replaceRelayRoomFile, resolveRelayTokenSession, syncEquivalentRelayRoomWitnesses } = await relayStore();
  const payload = assertRelaySignPayload(raw);
  const session = await resolveRelayTokenSession(payload.token);
  if (!session || (session.role !== "signer" && session.role !== "shared-signer")) throw new Error("Relay signer room not found or invite has expired.");
  await configuredNetworkGuard(session.room.network);
  const witnessKeyHashes = verifiedWitnessKeyHashes(session.room.tx.unsignedTxCbor, payload.witnessCbor).map((keyHash) => normalizeKeyHash(keyHash));
  const matchedSignerKeyHash =
    session.role === "signer"
      ? witnessKeyHashes.find((keyHash) => keyHash === session.signer.keyHash)
      : witnessKeyHashes.find((keyHash) => session.room.tx.signerKeyHashes.includes(keyHash));
  if (!matchedSignerKeyHash) {
    throw new Error("Witness is valid for this transaction, but it does not match any signer in this multisig policy.");
  }
  const deliveredAt = new Date().toISOString();

  const room = await replaceRelayRoomFile(session.room, (current) => {
    if (current.status !== "open") {
      throw new Error(`Relay room is ${current.status}; new witness uploads are disabled.`);
    }
    const nextWitness = {
      id: randomRecordId("witness"),
      source: "relay" as const,
      signerKeyHashClaim: session.role === "signer" ? session.signer.keyHash : matchedSignerKeyHash,
      matchedSignerKeyHash,
      witnessCbor: payload.witnessCbor,
      walletName: payload.walletName,
      signerName: payload.signerName,
      signedAt: payload.signedAt || deliveredAt,
      receivedAt: deliveredAt,
      matchStatus: matchedSignerKeyHash ? ("matched" as const) : ("unmatched" as const),
    };
    return {
      ...current,
      updatedAt: deliveredAt,
      signers: current.signers.map((signer) =>
        signer.keyHash === matchedSignerKeyHash
          ? {
              ...signer,
              lastSeenAt: deliveredAt,
              deliveredAt: matchedSignerKeyHash ? deliveredAt : signer.deliveredAt,
            }
          : signer,
      ),
      witnesses: [
        ...current.witnesses.filter(
          (witness) =>
            witness.source !== "relay" || normalizeKeyHash(witness.matchedSignerKeyHash || witness.signerKeyHashClaim || "") !== matchedSignerKeyHash,
        ),
        nextWitness,
      ],
    };
  });
  const synced = await syncEquivalentRelayRoomWitnesses(room);
  const autoSubmitted = await autoSubmitRelayRoomIfReady(synced);

  return Response.json({
    ok: true,
    delivered: true,
    matchStatus: matchedSignerKeyHash ? "matched" : "unmatched",
    matchedSignerKeyHash,
    thresholdReached: relayProgress(autoSubmitted.room).matchedCount >= Math.max(autoSubmitted.room.tx.requiredSignatures || 1, 1),
    submission: autoSubmitted.room.submission,
    autoSubmitError: autoSubmitted.submitError || undefined,
  });
}

async function handleSubmit(raw: Record<string, unknown>) {
  const { replaceRelayRoomFile, resolveRelayTokenSession } = await relayStore();
  const payload = assertRelaySubmitPayload(raw);
  const session = await resolveRelayTokenSession(payload.token);
  if (!session || session.role !== "coordinator") throw new Error("Relay coordinator room not found or token has expired.");
  await configuredNetworkGuard(session.room.network);

  const room = await replaceRelayRoomFile(session.room, (current) => ({
    ...current,
    status: "submitted",
    updatedAt: new Date().toISOString(),
    submission: {
      txHash: payload.txHash,
      submittedAt: new Date().toISOString(),
    },
  }));

  return Response.json({ ok: true, room: { roomId: room.id, status: room.status, submission: room.submission } });
}

async function handleView(raw: Record<string, unknown>) {
  const roomId = String(raw.roomId || "").trim();
  if (!roomId) throw new Error("roomId is required.");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(roomId)) throw new Error("Invalid roomId.");
  const { publicRelayRoomView, readRelayRoom } = await relayStore();
  const room = await readRelayRoom(roomId);
  await configuredNetworkGuard(room.network);
  return Response.json({ ok: true, role: "viewer", room: publicRelayRoomView(room) });
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method.toUpperCase() !== "POST") {
      throw new Error("Relay rooms accept POST requests only.");
    }
    const body = await limitedJson(request);
    const { intent, input } = assertIntent(body);
    if (intent === "create") return await handleCreate(request, input);
    if (intent === "session") return await handleSession(input);
    if (intent === "view") return await handleView(input);
    if (intent === "sign") return await handleSign(input);
    if (intent === "submit") return await handleSubmit(input);
    throw new Error(`Unsupported relay room intent: ${intent}`);
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}
