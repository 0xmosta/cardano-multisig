import { normalizeSubmitNetwork, submitErrorMessage, submitSignedTransaction } from "../lib/server/cardano-submit";

type SubmitRequest = { signedTxCbor?: string; network?: string };

function assertSubmitRequest(body: unknown) {
  const input = (body || {}) as SubmitRequest;
  const signedTxCbor = String(input.signedTxCbor || "").trim().toLowerCase();
  if (!signedTxCbor) throw new Error("Signed transaction CBOR is required.");
  const network = normalizeSubmitNetwork(input.network || process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
  return { signedTxCbor, network };
}

export async function action({ request }: { request: Request }) {
  try {
    const input = assertSubmitRequest(await request.json());
    return Response.json(await submitSignedTransaction(input.signedTxCbor, input.network));
  } catch (error) {
    console.error("submit failed", submitErrorMessage(error));
    return Response.json({ ok: false, error: submitErrorMessage(error) }, { status: 400 });
  }
}
