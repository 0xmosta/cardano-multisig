import * as CSL from "@emurgo/cardano-serialization-lib-browser";
import { isKeyHash, normalizeKeyHash } from "../lib/multisig";
import {
  type RelayRoomCreateRequest,
  type RelayRoomSessionRequest,
  type RelayRoomSignRequest,
  type RelayRoomSubmitRequest,
  relayInviteUrl,
} from "../lib/relay-room";
import { verifiedWitnessKeyHashes } from "../lib/witness-verification";

async function relayStore() {
  return import("../lib/server/relay-room-store");
}

function requestOrigin(request: Request) {
  const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(/:$/, "");
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  return new URL(request.url).origin;
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
  return {
    intent: "sign",
    token,
    witnessCbor,
    walletName: String(raw.walletName || "").trim() || undefined,
    signerName: String(raw.signerName || "").trim() || undefined,
    signedAt: String(raw.signedAt || "").trim() || undefined,
  };
}

function assertRelaySubmitPayload(raw: Record<string, unknown>): RelayRoomSubmitRequest {
  const token = String(raw.token || "").trim();
  const txHash = String(raw.txHash || "").trim().toLowerCase();
  if (!token) throw new Error("Relay coordinator token is required.");
  if (!/^[0-9a-f]{64}$/i.test(txHash)) throw new Error("txHash must be a 64-character hex string.");
  return { intent: "submit", token, txHash };
}

async function handleCreate(request: Request, raw: Record<string, unknown>) {
  const { assertRelayCreatePayload, createRelayRoom } = await relayStore();
  const payload = assertRelayCreatePayload(raw as unknown as RelayRoomCreateRequest);
  await configuredNetworkGuard(payload.network);
  CSL.Transaction.from_hex(payload.tx.unsignedTxCbor);
  const created = await createRelayRoom(payload);
  const origin = requestOrigin(request);
  return Response.json({
    ok: true,
    roomId: created.room.id,
    coordinatorToken: created.coordinatorToken,
    signerInvites: created.signerTokens.map((signer) => ({
      keyHash: signer.keyHash,
      label: signer.label,
      inviteUrl: relayInviteUrl(origin, signer.token),
    })),
    expiresAt: created.room.expiresAt,
  });
}

async function handleSession(raw: Record<string, unknown>) {
  const { coordinatorRoomView, replaceRelayRoomFile, resolveRelayTokenSession, signerRoomView } = await relayStore();
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
    return {
      ...room,
      updatedAt: seenAt,
      signers: room.signers.map((signer) =>
        signer.keyHash === session.signer.keyHash ? { ...signer, lastSeenAt: seenAt } : signer,
      ),
    };
  });

  if (session.role === "coordinator") {
    return Response.json({ ok: true, role: "coordinator", room: coordinatorRoomView(current) });
  }

  const signer = current.signers.find((item) => item.keyHash === session.signer.keyHash);
  if (!signer) throw new Error("Relay signer is no longer available for this room.");
  return Response.json({ ok: true, role: "signer", room: signerRoomView(current, signer) });
}

async function handleSign(raw: Record<string, unknown>) {
  const { relayProgress, replaceRelayRoomFile, resolveRelayTokenSession } = await relayStore();
  const payload = assertRelaySignPayload(raw);
  const session = await resolveRelayTokenSession(payload.token);
  if (!session || session.role !== "signer") throw new Error("Relay signer room not found or invite has expired.");
  await configuredNetworkGuard(session.room.network);
  const witnessKeyHashes = verifiedWitnessKeyHashes(session.room.tx.unsignedTxCbor, payload.witnessCbor);
  const matchedSignerKeyHash = witnessKeyHashes.find((keyHash) => keyHash === session.signer.keyHash);
  if (!matchedSignerKeyHash) {
    throw new Error("Witness is valid for this transaction, but it does not match the signer invite token.");
  }
  const deliveredAt = new Date().toISOString();

  const room = await replaceRelayRoomFile(session.room, (current) => {
    if (current.status !== "open") {
      throw new Error(`Relay room is ${current.status}; new witness uploads are disabled.`);
    }
    const nextWitness = {
      id: `witness_${Math.random().toString(36).slice(2, 10)}`,
      source: "relay" as const,
      signerKeyHashClaim: session.signer.keyHash,
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
        signer.keyHash === session.signer.keyHash
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
            witness.source !== "relay" || normalizeKeyHash(witness.signerKeyHashClaim || "") !== session.signer.keyHash,
        ),
        nextWitness,
      ],
    };
  });

  return Response.json({
    ok: true,
    delivered: true,
    matchStatus: matchedSignerKeyHash ? "matched" : "unmatched",
    matchedSignerKeyHash,
    thresholdReached: relayProgress(room).matchedCount >= Math.max(room.tx.requiredSignatures || 1, 1),
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

export async function action({ request }: { request: Request }) {
  try {
    if (request.method.toUpperCase() !== "POST") {
      throw new Error("Relay rooms accept POST requests only.");
    }
    const body = await request.json();
    const { intent, input } = assertIntent(body);
    if (intent === "create") return await handleCreate(request, input);
    if (intent === "session") return await handleSession(input);
    if (intent === "sign") return await handleSign(input);
    if (intent === "submit") return await handleSubmit(input);
    throw new Error(`Unsupported relay room intent: ${intent}`);
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}
