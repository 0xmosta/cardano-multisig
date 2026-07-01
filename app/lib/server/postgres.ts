import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Network } from "../multisig";

declare global {
  // eslint-disable-next-line no-var
  var __cardanoMultisigPgPool: Pool | undefined;
}

const APP_NAME = "cardano-multisig";

export function normalizeNetwork(value: string | null | undefined): Network {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}

export function configuredNetwork() {
  return normalizeNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
}

export function databaseUrl() {
  const value = (process.env.DATABASE_URL || "").trim();
  return value || null;
}

export function migrationDatabaseUrl() {
  const value = (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  return value || null;
}

export function postgresEnabled() {
  return Boolean(databaseUrl());
}

export function fileStoreAllowed() {
  if (postgresEnabled()) return false;
  if (process.env.CARDANO_MULTISIG_ALLOW_FILE_STORE === "1") return true;
  const env = (process.env.NODE_ENV || "development").trim().toLowerCase();
  return env !== "production" && configuredNetwork() !== "mainnet";
}

export function assertPersistenceMode(feature: string) {
  if (postgresEnabled()) return "postgres" as const;
  if (fileStoreAllowed()) return "file" as const;
  throw new Error(`${feature} requires DATABASE_URL for ${configuredNetwork()} deployments. File storage is development-only unless CARDANO_MULTISIG_ALLOW_FILE_STORE=1 is set.`);
}

function createPool() {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL persistence.");
  return new Pool({
    application_name: APP_NAME,
    connectionString,
    max: Number.parseInt(process.env.CARDANO_MULTISIG_DB_POOL_MAX || "10", 10) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSLMODE === "disable" ? false : undefined,
  });
}

export function getPool() {
  if (!globalThis.__cardanoMultisigPgPool) {
    globalThis.__cardanoMultisigPgPool = createPool();
  }
  return globalThis.__cardanoMultisigPgPool;
}

export async function query<Row extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPool().query<Row>(text, params);
}

export async function withClient<T>(action: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    return await action(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(action: (client: PoolClient) => Promise<T>) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

export function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}
