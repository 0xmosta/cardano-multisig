import { isRecord } from "../lib/multisig";
import { assertSessionMutationRequest, loadSession } from "../lib/server/account-store";
import { deletePushSubscription, pushConfiguration, savePushSubscription } from "../lib/server/push-notifications";
import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function parseSubscription(value: unknown) {
  if (!isRecord(value) || !isRecord(value.keys)) throw new Error("Invalid push subscription.");
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const p256dh = typeof value.keys.p256dh === "string" ? value.keys.p256dh.trim() : "";
  const auth = typeof value.keys.auth === "string" ? value.keys.auth.trim() : "";
  if (!endpoint.startsWith("https://") || endpoint.length > 2_048 || !p256dh || p256dh.length > 512 || !auth || auth.length > 512) {
    throw new Error("Invalid push subscription.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function loader({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "push-config", limit: 60, windowMs: 60_000 });
    return Response.json({ ok: true, ...pushConfiguration() }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, enabled: false, publicKey: "" }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "push-subscription", limit: 30, windowMs: 60_000 });
    const session = await loadSession(request);
    if (!session) return Response.json({ ok: false, error: "Sign in first." }, { status: 401, headers: NO_STORE_HEADERS });
    assertSessionMutationRequest(request, session, request.headers.get("x-cardano-multisig-csrf"));
    const input = await request.json() as { intent?: unknown; subscription?: unknown; endpoint?: unknown };
    if (input.intent === "subscribe") {
      if (!pushConfiguration().enabled) return Response.json({ ok: false, error: "Background notifications are not configured on this server." }, { status: 503, headers: NO_STORE_HEADERS });
      await savePushSubscription(session.network, session.subject, session.id, parseSubscription(input.subscription));
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    }
    if (input.intent === "unsubscribe") {
      const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
      await deletePushSubscription(session.network, session.subject, endpoint || undefined);
      return Response.json({ ok: true }, { headers: NO_STORE_HEADERS });
    }
    throw new Error("Unsupported notification action.");
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, error: error instanceof Error ? error.message : "Notification request failed." }, { status: 400, headers: NO_STORE_HEADERS });
  }
}
