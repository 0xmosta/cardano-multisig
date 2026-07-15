import {
  assertSessionMutationRequest,
  listAccountSessions,
  loadSession,
  renameAccountSession,
  revokeAccountSession,
  revokeOtherAccountSessions,
} from "../lib/server/account-store";
import { enforceRateLimit, rateLimitErrorResponse } from "../lib/server/rate-limit";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function loader({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-sessions-read", limit: 60, windowMs: 60_000 });
    const session = await loadSession(request);
    if (!session) return Response.json({ ok: false, error: "Sign in first." }, { status: 401, headers: NO_STORE_HEADERS });
    return Response.json({ ok: true, currentSessionId: session.id, sessions: await listAccountSessions(session) }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not load sessions." }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

export async function action({ request }: { request: Request }) {
  try {
    await enforceRateLimit(request, { scope: "account-sessions-write", limit: 30, windowMs: 60_000 });
    if (request.method.toUpperCase() !== "POST") throw new Error("Session management accepts POST only.");
    const session = await loadSession(request);
    if (!session) return Response.json({ ok: false, error: "Sign in first." }, { status: 401, headers: NO_STORE_HEADERS });
    assertSessionMutationRequest(request, session, request.headers.get("x-cardano-multisig-csrf"));
    const input = await request.json() as { intent?: unknown; sessionId?: unknown; label?: unknown };
    if (input.intent === "revoke_others") {
      return Response.json({ ok: true, revoked: await revokeOtherAccountSessions(session) }, { headers: NO_STORE_HEADERS });
    }
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId || sessionId.length > 128) throw new Error("A valid session id is required.");
    if (input.intent === "rename") {
      const label = typeof input.label === "string" ? input.label.trim() : "";
      if (label.length > 80) throw new Error("Device name must be 80 characters or fewer.");
      return Response.json({ ok: true, renamed: await renameAccountSession(session, sessionId, label) }, { headers: NO_STORE_HEADERS });
    }
    if (input.intent !== "revoke") throw new Error("Unsupported session action.");
    if (sessionId === session.id) throw new Error("Sign out from this device instead of revoking the current session.");
    return Response.json({ ok: true, revoked: await revokeAccountSession(session, sessionId) }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return rateLimitErrorResponse(error) || Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not revoke session." }, { status: 400, headers: NO_STORE_HEADERS });
  }
}
