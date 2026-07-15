import { configuredNetwork, postgresEnabled, query } from "../lib/server/postgres";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function loader() {
  const startedAt = Date.now();
  try {
    if (!postgresEnabled()) throw new Error("PostgreSQL is not configured.");
    await query("select 1");
    return Response.json({
      ok: true,
      network: configuredNetwork(),
      persistence: "postgres",
      latencyMs: Date.now() - startedAt,
    }, { headers: NO_STORE_HEADERS });
  } catch {
    return Response.json({
      ok: false,
      network: configuredNetwork(),
      persistence: postgresEnabled() ? "postgres" : "unavailable",
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
