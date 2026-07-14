import * as CSL from "@emurgo/cardano-serialization-lib-browser";
import { normalizeSubmitNetwork, submitErrorMessage, submitSignedTransaction } from "../lib/server/cardano-submit";
import { assertSessionMutationRequest, loadAccountSnapshot, loadSession } from "../lib/server/account-store";
import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

type SubmitRequest = { signedTxCbor?: string; network?: string };

const MAX_SUBMIT_REQUEST_BYTES = 750_000;
const MAX_SIGNED_TX_CBOR_CHARS = 500_000;

async function limitedJson(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_SUBMIT_REQUEST_BYTES) {
    throw new Error("Submit request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_SUBMIT_REQUEST_BYTES) {
    throw new Error("Submit request body is too large.");
  }
  return JSON.parse(text) as unknown;
}

function assertSubmitRequest(body: unknown) {
  const input = (body || {}) as SubmitRequest;
  const signedTxCbor = String(input.signedTxCbor || "").trim().toLowerCase();
  if (!signedTxCbor) throw new Error("Signed transaction CBOR is required.");
  if (signedTxCbor.length > MAX_SIGNED_TX_CBOR_CHARS) throw new Error("Signed transaction CBOR is too large.");
  if (!/^[0-9a-f]+$/i.test(signedTxCbor) || signedTxCbor.length % 2 !== 0) {
    throw new Error("Signed transaction CBOR must be hex-encoded.");
  }
  const network = normalizeSubmitNetwork(input.network || process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
  if (network === "mainnet" && process.env.CARDANO_MULTISIG_ENABLE_MAINNET_RELAY !== "1") {
    throw new Error("Mainnet transaction submit is disabled unless CARDANO_MULTISIG_ENABLE_MAINNET_RELAY=1 is set.");
  }
  return { signedTxCbor, network };
}

function transactionBodyHex(transactionCbor: string) {
  return Buffer.from(CSL.Transaction.from_hex(transactionCbor).body().to_bytes()).toString("hex");
}

export async function action({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "cardano-submit", limit: 20, windowMs: 60_000 });
    const session = await loadSession(request);
    if (!session) return Response.json({ ok: false, error: "Sign in with a wallet first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    assertSessionMutationRequest(request, session, request.headers.get("x-cardano-multisig-csrf"));
    const input = assertSubmitRequest(await limitedJson(request));
    if (input.network !== session.network) throw new Error("Signed transaction network does not match the authenticated account.");
    const submittedBody = transactionBodyHex(input.signedTxCbor);
    const snapshot = await loadAccountSnapshot(session);
    const belongsToAccount = snapshot.transactions.some((tx) => {
      if (tx.network !== input.network || !tx.unsignedTxCbor?.trim()) return false;
      try {
        return transactionBodyHex(tx.unsignedTxCbor) === submittedBody;
      } catch {
        return false;
      }
    });
    if (!belongsToAccount) throw new Error("Signed transaction does not match a transaction in this authenticated account.");
    return Response.json(await submitSignedTransaction(input.signedTxCbor, input.network), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const limited = rateLimitErrorResponse(error);
    if (limited) return limited;
    console.error("submit failed", submitErrorMessage(error));
    return Response.json({ ok: false, error: submitErrorMessage(error) }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
