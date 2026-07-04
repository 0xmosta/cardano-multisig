import {
  accountSessionResponse,
  assertSessionMutationRequest,
  importIntoAccount,
  loadAccountSnapshot,
  loadSession,
  replaceAccountSnapshot,
} from "../lib/server/account-store";
import type { MultisigWallet, TxDraft } from "../lib/multisig";

type StateRequest = {
  intent?: "replace" | "import";
  wallets?: MultisigWallet[];
  transactions?: TxDraft[];
};

const MAX_STATE_REQUEST_BYTES = 5_000_000;

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
  return {
    intent: input.intent || "replace",
    wallets: Array.isArray(input.wallets) ? input.wallets : [],
    transactions: Array.isArray(input.transactions) ? input.transactions : [],
  };
}

export async function loader({ request }: { request: Request }) {
  try {
    const session = await loadSession(request);
    const snapshot = session ? await loadAccountSnapshot(session) : { wallets: [], transactions: [] };
    return Response.json({
      ok: true,
      ...accountSessionResponse(session, snapshot),
      snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load authenticated account state.";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    if (request.method.toUpperCase() !== "POST") {
      throw new Error("Authenticated account state API accepts POST only.");
    }
    const session = await loadSession(request);
    if (!session) {
      return Response.json({ ok: false, authenticated: false, error: "Sign in with a wallet first." }, { status: 401 });
    }
    assertSessionMutationRequest(request, session, request.headers.get("x-cardano-multisig-csrf"));
    const snapshot = parseSnapshot(await limitedJson(request));
    const saved =
      snapshot.intent === "import"
        ? await importIntoAccount(session, { wallets: snapshot.wallets, transactions: snapshot.transactions })
        : await replaceAccountSnapshot(session, { wallets: snapshot.wallets, transactions: snapshot.transactions });
    return Response.json({
      ok: true,
      ...accountSessionResponse(session, saved),
      snapshot: saved,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save authenticated account state.";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
