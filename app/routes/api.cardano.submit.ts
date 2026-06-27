import * as CSL from "@emurgo/cardano-serialization-lib-browser";

type CardanoNetwork = "mainnet" | "preprod" | "preview";
type SubmitRequest = { signedTxCbor?: string; network?: string };

type SubmitBackend =
  | { kind: "blockfrost"; network: CardanoNetwork; url: string; projectId: string }
  | { kind: "custom"; network: CardanoNetwork; url: string };

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Could not submit transaction.";
  }
}

function normalizeNetwork(value: string | null | undefined): CardanoNetwork {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

function configuredNetwork() {
  return normalizeNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
}

function hasAnyEnv(names: string[]) {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

function assertBlockfrostUrlMatchesNetwork(url: string, network: CardanoNetwork) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!host.endsWith("blockfrost.io")) return;
  const expected = `cardano-${network}.blockfrost.io`;
  if (host !== expected) throw new Error(`Configured Cardano network is ${network}, but Blockfrost URL points to ${host}.`);
}

function getBlockfrostConfig() {
  const network = configuredNetwork();
  const defaultUrl = `https://cardano-${network}.blockfrost.io/api/v0`;
  const url = (process.env.BLOCKFROST_URL || process.env.CARDANO_BLOCKFROST_URL || defaultUrl).replace(/\/$/, "");
  const projectId = process.env.BLOCKFROST_PROJECT_ID || process.env.CARDANO_BLOCKFROST_PROJECT_ID || "";
  assertBlockfrostUrlMatchesNetwork(url, network);
  return { network, url, projectId };
}

function submitUrl() {
  return (
    process.env.CARDANO_SUBMIT_URL ||
    process.env.CARDANO_NODE_SUBMIT_URL ||
    process.env.CARDANO_SUBMIT_API_URL ||
    ""
  ).trim();
}

function hexToBytes(hex: string) {
  const normalized = hex.trim().toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error("Signed transaction CBOR must be hex-encoded.");
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function assertSubmitRequest(body: unknown) {
  const input = (body || {}) as SubmitRequest;
  const signedTxCbor = String(input.signedTxCbor || "").trim().toLowerCase();
  if (!signedTxCbor) throw new Error("Signed transaction CBOR is required.");
  const network = input.network ? normalizeNetwork(input.network) : configuredNetwork();
  return { signedTxCbor, network };
}

function resolveSubmitBackend(): SubmitBackend {
  const network = configuredNetwork();
  if (network === "mainnet") {
    throw new Error("Mainnet submission is disabled in this build. Switch to preprod/preview or use an explicitly authorized mainnet flow.");
  }

  const customUrl = submitUrl();
  if (customUrl) {
    return { kind: "custom", network, url: customUrl.replace(/\/$/, "") };
  }

  const blockfrost = getBlockfrostConfig();
  if (blockfrost.projectId.trim()) {
    return { kind: "blockfrost", network, url: blockfrost.url, projectId: blockfrost.projectId };
  }

  throw new Error("No preprod/preview submit backend is configured. Set Blockfrost or CARDANO_SUBMIT_URL first.");
}

function parseSubmitResponse(text: string, contentType: string, fallbackHash: string) {
  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(text) as
        | string
        | { txHash?: string; hash?: string; id?: string; result?: { txHash?: string; hash?: string; id?: string } };
      if (typeof body === "string") return body.trim() || fallbackHash;
      const candidate = body.txHash || body.hash || body.id || body.result?.txHash || body.result?.hash || body.result?.id;
      return typeof candidate === "string" && candidate.trim() ? candidate.trim() : fallbackHash;
    } catch {
      return fallbackHash;
    }
  }
  const trimmed = text.trim();
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed : fallbackHash;
}

async function submitViaBlockfrost(backend: Extract<SubmitBackend, { kind: "blockfrost" }>, signedTxCbor: string, localTxHash: string) {
  const response = await fetch(`${backend.url}/tx/submit`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "content-type": "application/cbor",
      project_id: backend.projectId,
    },
    body: hexToBytes(signedTxCbor),
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() || `HTTP ${response.status}`;
    throw new Error(`Blockfrost submit failed (${response.status}): ${detail}`);
  }

  return parseSubmitResponse(text, response.headers.get("content-type") || "", localTxHash);
}

async function submitViaCustom(backend: Extract<SubmitBackend, { kind: "custom" }>, signedTxCbor: string, localTxHash: string) {
  const response = await fetch(backend.url, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "content-type": "application/cbor",
    },
    body: hexToBytes(signedTxCbor),
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() || `HTTP ${response.status}`;
    throw new Error(`Submit endpoint failed (${response.status}): ${detail}`);
  }

  return parseSubmitResponse(text, response.headers.get("content-type") || "", localTxHash);
}

export async function action({ request }: { request: Request }) {
  try {
    const input = assertSubmitRequest(await request.json());
    const backend = resolveSubmitBackend();
    if (input.network !== backend.network) {
      throw new Error(`Transaction targets ${input.network}, but the configured submit backend is ${backend.network}.`);
    }

    const tx = CSL.FixedTransaction.from_hex(input.signedTxCbor);
    const localTxHash = tx.transaction_hash().to_hex();
    const txHash =
      backend.kind === "blockfrost"
        ? await submitViaBlockfrost(backend, input.signedTxCbor, localTxHash)
        : await submitViaCustom(backend, input.signedTxCbor, localTxHash);

    return Response.json({ ok: true, network: backend.network, txHash, localTxHash, backend: backend.kind });
  } catch (error) {
    console.error("submit failed", errorMessage(error));
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}
