import { challengeHexFromJson, keyHashFromAddressHex, verifyCip30SignData } from "../lib/server/cip30-sign-data";
import {
  accountSessionResponse,
  assertOrigin,
  createIdentity,
  createSession,
  destroySession,
  challengePayload,
  loadAccountSnapshot,
  loadSession,
  storeChallenge,
  consumeChallenge,
} from "../lib/server/account-store";
import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

type SessionAction =
  | { intent: "challenge"; network?: string; addressHex?: string; rewardAddressHex?: string }
  | { intent: "verify"; network?: string; challengeId?: string; addressHex?: string; rewardAddressHex?: string; signature?: string; key?: string }
  | { intent: "logout" };

const MAX_ACCOUNT_REQUEST_BYTES = 100_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

async function limitedJson(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_ACCOUNT_REQUEST_BYTES) {
    throw new Error("Authenticated account request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_ACCOUNT_REQUEST_BYTES) {
    throw new Error("Authenticated account request body is too large.");
  }
  return JSON.parse(text) as unknown;
}

function assertObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid authenticated account request body.");
  }
  return value as Record<string, unknown>;
}

function requestBody(body: unknown) {
  const input = assertObject(body);
  return {
    intent: String(input.intent || "").trim(),
    input,
  };
}

export async function loader({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-session-read", limit: 240, windowMs: 60_000 });
    const session = await loadSession(request);
    const snapshot = session ? await loadAccountSnapshot(session) : undefined;
    return Response.json(accountSessionResponse(session, snapshot), { headers: NO_STORE_HEADERS });
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, error: "Could not load account session." }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-session-write", limit: 60, windowMs: 60_000 });
    if (request.method.toUpperCase() !== "POST") {
      throw new Error("Authenticated account session API accepts POST only.");
    }
    const { intent, input } = requestBody(await limitedJson(request));
    const origin = assertOrigin(request);
    if (intent === "logout") {
      const cleared = await destroySession(request);
      return Response.json({ ok: true, authenticated: false }, { headers: { ...NO_STORE_HEADERS, "set-cookie": cleared } });
    }

    if (intent === "challenge") {
      const rewardAddressHex = String(input.rewardAddressHex || "").trim().toLowerCase();
      const addressHex = String((rewardAddressHex || input.addressHex || "")).trim().toLowerCase();
      if (!addressHex) throw new Error("Wallet addressHex is required for account auth challenge.");
      const identity = createIdentity({ kind: rewardAddressHex ? "stake" : "payment", keyHash: keyHashFromAddressHex(addressHex), addressHex });
      const payload = challengePayload({ origin, network: String(input.network || "preprod"), identity, nonce: crypto.randomUUID() });
      const challenge = await storeChallenge({
        network: String(input.network || "preprod"),
        origin,
        identity,
        payloadHex: challengeHexFromJson(payload),
        nonce: payload.nonce,
      });
      return Response.json({ ok: true, challengeId: challenge.id, challengeHex: challenge.payloadHex, challenge: payload }, { headers: NO_STORE_HEADERS });
    }

    if (intent === "verify") {
      const challengeId = String(input.challengeId || "").trim();
      const signature = String(input.signature || "").trim();
      const key = String(input.key || "").trim();
      const rewardAddressHex = String(input.rewardAddressHex || "").trim().toLowerCase();
      const addressHex = String((rewardAddressHex || input.addressHex || "")).trim().toLowerCase();
      if (!challengeId || !signature || !key || !addressHex) {
        throw new Error("challengeId, addressHex, signature, and key are required to verify wallet auth.");
      }
      const challenge = await consumeChallenge(challengeId);
      if (!challenge) throw new Error("Wallet auth challenge was not found. Request a fresh challenge.");
      if (challenge.origin !== origin) {
        throw new Error("Wallet auth challenge origin mismatch.");
      }
      if (challenge.identity.addressHex !== addressHex || challenge.identity.kind !== (rewardAddressHex ? "stake" : "payment")) {
        throw new Error("Wallet auth challenge identity mismatch.");
      }
      const verified = verifyCip30SignData({
        addressHex,
        payloadHex: challenge.payloadHex,
        signatureHex: signature,
        keyHex: key,
      });
      if (verified.keyHash !== challenge.identity.keyHash) {
        throw new Error("Wallet auth challenge key hash mismatch.");
      }
      const identity = createIdentity({
        kind: rewardAddressHex ? "stake" : "payment",
        keyHash: verified.keyHash,
        addressHex,
      });
      const created = await createSession(identity, String(input.network || challenge.network), {
        userAgent: request.headers.get("user-agent") || undefined,
      });
      const snapshot = await loadAccountSnapshot(created.session);
      return Response.json(
        {
          ok: true,
          ...accountSessionResponse(created.session, snapshot),
        },
        { headers: { ...NO_STORE_HEADERS, "set-cookie": created.cookie } },
      );
    }

    throw new Error(`Unsupported authenticated account intent: ${intent}`);
  } catch (error) {
    const limited = rateLimitErrorResponse(error);
    if (limited) return limited;
    const message = error instanceof Error ? error.message : "Authenticated account session request failed.";
    return Response.json({ ok: false, error: message }, { status: 400, headers: NO_STORE_HEADERS });
  }
}
