import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

type CardanoNetwork = "mainnet" | "preprod" | "preview";
type KoiosCredentialUtxo = { payment_cred?: string; stake_address?: string | null };
type SignerHandle = { name: string; stakeAddress: string };
type CacheEntry = { value: SignerHandle | null; expiresAt: number };

const MAX_KEY_HASHES = 16;
const CACHE_TTL_MS = 10 * 60_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const handleCache = new Map<string, CacheEntry>();

function normalizeNetwork(value: string | null | undefined): CardanoNetwork {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

function configuredNetwork() {
  return normalizeNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
}

function parseKeyHashes(value: string | null) {
  return Array.from(
    new Set(
      (value || "")
        .split(",")
        .map((keyHash) => keyHash.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function validKeyHash(value: string) {
  return /^[0-9a-f]{56}$/.test(value);
}

async function fetchStakeAddresses(keyHashes: string[]) {
  const response = await fetch(
    "https://api.koios.rest/api/v1/credential_utxos?select=payment_cred,stake_address&limit=500",
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ _payment_credentials: keyHashes, _extended: false }),
      signal: AbortSignal.timeout(6_000),
    },
  );
  if (!response.ok) throw new Error("Could not inspect signer addresses.");
  const rows = (await response.json()) as KoiosCredentialUtxo[];
  const byKeyHash = new Map<string, Set<string>>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const keyHash = String(row.payment_cred || "").trim().toLowerCase();
    const stakeAddress = String(row.stake_address || "").trim().toLowerCase();
    if (!validKeyHash(keyHash) || !/^stake1[0-9a-z]+$/.test(stakeAddress)) continue;
    const addresses = byKeyHash.get(keyHash) || new Set<string>();
    addresses.add(stakeAddress);
    byKeyHash.set(keyHash, addresses);
  }
  return byKeyHash;
}

async function fetchDefaultHandle(stakeAddress: string): Promise<SignerHandle | null> {
  try {
    const response = await fetch(`https://api.handle.me/holders/${encodeURIComponent(stakeAddress)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { default_handle?: string; handles?: string[]; address?: string };
    const name = String(body.default_handle || body.handles?.[0] || "").trim().replace(/^\$/, "");
    if (!name || name.length > 128 || String(body.address || stakeAddress).toLowerCase() !== stakeAddress) return null;
    return { name, stakeAddress };
  } catch {
    return null;
  }
}

async function resolveSignerHandles(keyHashes: string[]) {
  const now = Date.now();
  const resolved: Record<string, SignerHandle> = {};
  const missing: string[] = [];

  for (const keyHash of keyHashes) {
    const cached = handleCache.get(keyHash);
    if (!cached || cached.expiresAt <= now) {
      handleCache.delete(keyHash);
      missing.push(keyHash);
    } else if (cached.value) {
      resolved[keyHash] = cached.value;
    }
  }

  if (missing.length) {
    const stakeAddresses = await fetchStakeAddresses(missing);
    await Promise.all(
      missing.map(async (keyHash) => {
        const candidates = Array.from(stakeAddresses.get(keyHash) || []);
        const matches = (await Promise.all(candidates.map(fetchDefaultHandle))).filter((value): value is SignerHandle => Boolean(value));
        const uniqueNames = new Set(matches.map((match) => match.name.toLowerCase()));
        const value = uniqueNames.size === 1 ? matches[0] : null;
        handleCache.set(keyHash, { value, expiresAt: now + CACHE_TTL_MS });
        if (value) resolved[keyHash] = value;
      }),
    );
  }

  return resolved;
}

export async function loader({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "cardano-signer-handles", limit: 60, windowMs: 60_000 });
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, error: "Signer identity lookup unavailable." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const url = new URL(request.url);
  const network = configuredNetwork();
  const requestedNetwork = normalizeNetwork(url.searchParams.get("network") || network);
  if (requestedNetwork !== network) {
    return Response.json({ ok: false, error: `Signer network ${requestedNetwork} does not match configured network ${network}.` }, { status: 409, headers: NO_STORE_HEADERS });
  }

  const keyHashes = parseKeyHashes(url.searchParams.get("keyHashes"));
  if (keyHashes.length > MAX_KEY_HASHES || keyHashes.some((keyHash) => !validKeyHash(keyHash))) {
    return Response.json({ ok: false, error: "Signer key hashes are invalid." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (network !== "mainnet" || !keyHashes.length) {
    return Response.json({ ok: true, network, handles: {} }, { headers: NO_STORE_HEADERS });
  }

  try {
    const handles = await resolveSignerHandles(keyHashes);
    return Response.json({ ok: true, network, handles }, { headers: NO_STORE_HEADERS });
  } catch {
    return Response.json({ ok: true, network, handles: {} }, { headers: NO_STORE_HEADERS });
  }
}
