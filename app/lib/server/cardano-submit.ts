import * as CSL from "@emurgo/cardano-serialization-lib-browser";

type CardanoNetwork = "mainnet" | "preprod" | "preview";

type SubmitBackend =
  | { kind: "blockfrost"; network: CardanoNetwork; url: string; projectId: string }
  | { kind: "custom"; network: CardanoNetwork; url: string }
  | { kind: "ogmios"; network: CardanoNetwork; url: string };

export type SubmitResult = {
  ok: true;
  network: CardanoNetwork;
  txHash: string;
  localTxHash: string;
  backend: SubmitBackend["kind"];
};

export function submitErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Could not submit transaction.";
  }
}

export function normalizeSubmitNetwork(value: string | null | undefined): CardanoNetwork {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

function configuredNetwork() {
  return normalizeSubmitNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
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

export async function fetchSubmittedTransactionCbor(txHash: string, requestedNetwork: string) {
  const network = normalizeSubmitNetwork(requestedNetwork);
  const blockfrost = getBlockfrostConfig();
  if (network !== blockfrost.network) {
    throw new Error(`Transaction targets ${network}, but the configured Blockfrost backend is ${blockfrost.network}.`);
  }
  if (!blockfrost.projectId.trim()) return null;
  const normalizedTxHash = txHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedTxHash)) throw new Error("Submitted transaction hash is invalid.");

  const response = await fetch(`${blockfrost.url}/txs/${normalizedTxHash}/cbor`, {
    headers: { accept: "application/json", project_id: blockfrost.projectId },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Blockfrost transaction lookup failed (${response.status}).`);
  const body = (await response.json()) as { cbor?: unknown };
  const cbor = typeof body.cbor === "string" ? body.cbor.trim().toLowerCase() : "";
  if (!cbor || cbor.length > 500_000 || cbor.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cbor)) {
    throw new Error("Blockfrost returned invalid transaction CBOR.");
  }
  return cbor;
}

function submitUrl() {
  return (
    process.env.CARDANO_SUBMIT_URL ||
    process.env.CARDANO_NODE_SUBMIT_URL ||
    process.env.CARDANO_SUBMIT_API_URL ||
    ""
  ).trim();
}

function ogmiosUrl() {
  return (process.env.CARDANO_OGMIOS_URL || process.env.OGMIOS_URL || "").trim();
}

export function hexToBytes(hex: string) {
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

function resolveSubmitBackend(): SubmitBackend {
  const network = configuredNetwork();
  const customUrl = submitUrl();
  if (customUrl) {
    return { kind: "custom", network, url: customUrl.replace(/\/$/, "") };
  }

  const ogmios = ogmiosUrl();
  if (ogmios) {
    return { kind: "ogmios", network, url: ogmios };
  }

  const blockfrost = getBlockfrostConfig();
  if (blockfrost.projectId.trim()) {
    return { kind: "blockfrost", network, url: blockfrost.url, projectId: blockfrost.projectId };
  }

  throw new Error("No submit backend is configured. Set CARDANO_OGMIOS_URL, Blockfrost, or CARDANO_SUBMIT_URL first.");
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

async function submitViaOgmios(backend: Extract<SubmitBackend, { kind: "ogmios" }>, signedTxCbor: string, localTxHash: string) {
  const socket = new WebSocket(backend.url);
  const id = `submit-${Date.now().toString(36)}`;
  const result = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Ogmios submit timed out."));
    }, 30_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "submitTransaction",
        params: { transaction: { cbor: signedTxCbor } },
        id,
      }));
    });

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      try {
        const body = JSON.parse(String(event.data)) as {
          result?: string | { transaction?: { id?: string }; id?: string };
          error?: { message?: string; data?: unknown };
        };
        if (body.error) {
          const detail = body.error.data ? ` ${JSON.stringify(body.error.data)}` : "";
          reject(new Error(`Ogmios submit failed: ${body.error.message || "unknown error"}.${detail}`));
          return;
        }
        resolve(body.result);
      } catch (error) {
        reject(error);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Ogmios submit connection failed."));
    });
  });

  if (typeof result === "string" && /^[0-9a-f]{64}$/i.test(result)) return result;
  if (result && typeof result === "object") {
    const body = result as { transaction?: { id?: string }; id?: string };
    return body.transaction?.id || body.id || localTxHash;
  }
  return localTxHash;
}

export async function submitSignedTransaction(signedTxCbor: string, requestedNetwork: string): Promise<SubmitResult> {
  const network = normalizeSubmitNetwork(requestedNetwork);
  const backend = resolveSubmitBackend();
  if (network !== backend.network) {
    throw new Error(`Transaction targets ${network}, but the configured submit backend is ${backend.network}.`);
  }

  const tx = CSL.FixedTransaction.from_hex(signedTxCbor);
  const localTxHash = tx.transaction_hash().to_hex();
  const txHash =
    backend.kind === "blockfrost"
      ? await submitViaBlockfrost(backend, signedTxCbor, localTxHash)
      : backend.kind === "ogmios"
        ? await submitViaOgmios(backend, signedTxCbor, localTxHash)
        : await submitViaCustom(backend, signedTxCbor, localTxHash);

  return { ok: true, network: backend.network, txHash, localTxHash, backend: backend.kind };
}
