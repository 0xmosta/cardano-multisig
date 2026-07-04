import { normalizeSubmitNetwork, submitErrorMessage, submitSignedTransaction } from "../lib/server/cardano-submit";

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

export async function action({ request }: { request: Request }) {
  try {
    const input = assertSubmitRequest(await limitedJson(request));
    return Response.json(await submitSignedTransaction(input.signedTxCbor, input.network));
  } catch (error) {
    console.error("submit failed", submitErrorMessage(error));
    return Response.json({ ok: false, error: submitErrorMessage(error) }, { status: 400 });
  }
}
