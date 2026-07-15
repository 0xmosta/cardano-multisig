import {
  AccountStateConflictError,
  accountSessionResponse,
  assertSessionMutationRequest,
  loadAccountSnapshot,
  loadSession,
  replaceAccountSnapshot,
} from "../lib/server/account-store";
import type { MultisigWallet, TxDraft } from "../lib/multisig";
import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

type StateRequest = {
  intent?: "replace";
  baseUpdatedAt?: string;
  wallets?: MultisigWallet[];
  transactions?: TxDraft[];
};

const MAX_STATE_REQUEST_BYTES = 5_000_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

async function limitedJson(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_STATE_REQUEST_BYTES) {
    throw new Error("Authenticated account state payload is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_STATE_REQUEST_BYTES) {
    throw new Error("Authenticated account state payload is too large.");
  }
  return JSON.parse(text) as unknown;
}

function assertObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid authenticated account state payload.");
  }
  return value as Record<string, unknown>;
}

function parseSnapshot(body: unknown) {
  const input = assertObject(body) as StateRequest;
  if (input.intent && input.intent !== "replace") {
    throw new Error("Local-state import is disabled. PostgreSQL is the source of truth.");
  }
  return {
    baseUpdatedAt: typeof input.baseUpdatedAt === "string" ? input.baseUpdatedAt : "",
    wallets: Array.isArray(input.wallets) ? input.wallets : [],
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
  };
}

export async function loader({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-state-read", limit: 240, windowMs: 60_000 });
    const session = await loadSession(request);
    const snapshot = session ? await loadAccountSnapshot(session) : { wallets: [], transactions: [] };
    return Response.json(
      {
        ok: true,
        ...accountSessionResponse(session, snapshot),
        snapshot,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const limited = rateLimitErrorResponse(error);
    if (limited) return limited;
    const message = error instanceof Error ? error.message : "Could not load authenticated account state.";
    return Response.json({ ok: false, error: message }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-state-write", limit: 120, windowMs: 60_000 });
    if (request.method.toUpperCase() !== "POST") {
      throw new Error("Authenticated account state API accepts POST only.");
    }
    const session = await loadSession(request);
    if (!session) {
      return Response.json(
        { ok: false, authenticated: false, error: "Sign in with a wallet first." },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    assertSessionMutationRequest(request, session, request.headers.get("x-cardano-multisig-csrf"));
    const snapshot = parseSnapshot(await limitedJson(request));
    if (!snapshot.baseUpdatedAt) {
      throw new Error("Missing server snapshot version. Refresh the account before saving.");
    }
    const saved = await replaceAccountSnapshot(
      session,
      { wallets: snapshot.wallets, transactions: snapshot.transactions },
      "state.replace",
      snapshot.baseUpdatedAt,
    );
    return Response.json(
      {
        ok: true,
        ...accountSessionResponse(session, saved),
        snapshot: saved,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const limited = rateLimitErrorResponse(error);
    if (limited) return limited;
    const message = error instanceof Error ? error.message : "Could not save authenticated account state.";
    return Response.json(
      { ok: false, error: message },
      { status: error instanceof AccountStateConflictError ? 409 : 400, headers: NO_STORE_HEADERS },
    );
  }
}
