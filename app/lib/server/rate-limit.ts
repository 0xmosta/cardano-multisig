import { createHmac } from "node:crypto";
import { postgresEnabled, withClient } from "./postgres";

type RateLimitOptions = {
  scope: string;
  limit: number;
  windowMs: number;
  actor?: string;
};

type MemoryBucket = {
  count: number;
  expiresAt: number;
};

const memoryBuckets = new Map<string, MemoryBucket>();
const MAX_MEMORY_BUCKETS = 10_000;

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests. Try again shortly.");
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

function rateLimitSecret() {
  const value = (
    process.env.CARDANO_MULTISIG_RATE_LIMIT_SECRET ||
    process.env.CARDANO_MULTISIG_SESSION_SECRET ||
    process.env.CARDANO_MULTISIG_ACCOUNT_SECRET ||
    ""
  ).trim();
  if (!value) throw new Error("A server secret is required for API rate limiting.");
  return value;
}

function clientAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    "unavailable"
  ).trim().slice(0, 256);
}

function actorHash(scope: string, actor: string) {
  return createHmac("sha256", rateLimitSecret()).update(`${scope}\0${actor}`).digest("hex");
}

function cleanupMemoryBuckets(now: number) {
  if (memoryBuckets.size < MAX_MEMORY_BUCKETS) return;
  for (const [key, bucket] of memoryBuckets) {
    if (bucket.expiresAt <= now || memoryBuckets.size >= MAX_MEMORY_BUCKETS) memoryBuckets.delete(key);
    if (memoryBuckets.size < MAX_MEMORY_BUCKETS / 2) break;
  }
}

async function postgresCount(scope: string, hash: string, windowStart: Date, expiresAt: Date) {
  return withClient(async (client) => {
    if (Math.random() < 0.01) {
      await client.query(`delete from cm_api_rate_limits where expires_at < now()`);
    }
    const result = await client.query<{ request_count: number }>(
      `insert into cm_api_rate_limits (scope, actor_hash, window_start, request_count, expires_at)
       values ($1, $2, $3::timestamptz, 1, $4::timestamptz)
       on conflict (scope, actor_hash, window_start)
       do update set request_count = cm_api_rate_limits.request_count + 1, expires_at = excluded.expires_at
       returning request_count`,
      [scope, hash, windowStart.toISOString(), expiresAt.toISOString()],
    );
    return Number(result.rows[0]?.request_count || 1);
  });
}

function memoryCount(scope: string, hash: string, windowStartMs: number, expiresAtMs: number) {
  cleanupMemoryBuckets(Date.now());
  const key = `${scope}:${hash}:${windowStartMs}`;
  const current = memoryBuckets.get(key);
  const count = (current?.count || 0) + 1;
  memoryBuckets.set(key, { count, expiresAt: expiresAtMs });
  return count;
}

export async function enforceRateLimit(request: Request, options: RateLimitOptions) {
  const now = Date.now();
  const windowStartMs = Math.floor(now / options.windowMs) * options.windowMs;
  const expiresAtMs = windowStartMs + options.windowMs * 2;
  const actor = options.actor?.trim() || `ip:${clientAddress(request)}`;
  const hash = actorHash(options.scope, actor);
  const count = postgresEnabled()
    ? await postgresCount(options.scope, hash, new Date(windowStartMs), new Date(expiresAtMs))
    : memoryCount(options.scope, hash, windowStartMs, expiresAtMs);
  if (count > options.limit) {
    throw new RateLimitError(Math.ceil((windowStartMs + options.windowMs - now) / 1_000));
  }
  return { limit: options.limit, remaining: Math.max(options.limit - count, 0) };
}

export function rateLimitErrorResponse(error: unknown) {
  if (!(error instanceof RateLimitError)) return null;
  return Response.json(
    { ok: false, error: error.message },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(error.retryAfterSeconds),
      },
    },
  );
}
