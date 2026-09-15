import { verifyAdminRequest } from "./adminSessionDeps.ts";

/**
 * THE FRONT DOOR EVERY ADMIN ACTION ROUTE GOES THROUGH.
 *
 * Four routes write order state, and each of them must check the same
 * three things before it does anything else: a valid admin session, a
 * body small enough to refuse an unauthorized flood, and JSON that parses.
 * Written once so that all four are provably identical rather than
 * accidentally similar - a test asserts every action route calls this and
 * nothing else stands between the request and the session check.
 *
 * ── THE SESSION IS CHECKED BEFORE THE BODY IS READ ────────────
 *
 * Deliberate ordering. A caller with no session must not be able to make
 * this process parse anything, however small, and must not be able to
 * tell a malformed body from a missing session: both answers below are
 * reached without the other ever running.
 *
 * ── THE SECRETS STAY ON THE SERVER ────────────────────────────
 *
 * FULFILLMENT_ADMIN_SECRET and CANCELLATION_ADMIN_SECRET authorize the
 * /api/internal/orders/* routes and are not read here, not sent anywhere,
 * and never reach a browser. The admin session is this path's
 * authorization; the underlying database functions are the same ones.
 */

/** Bounded so an unauthorized caller cannot stream a large body at us. */
export const MAX_ACTION_BODY_BYTES = 2_000;

export type AdminActionContext = { session: { email: string }; body: unknown };

export type AdminActionGate =
  | { ok: true; context: AdminActionContext }
  | { ok: false; response: Response };

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Verifies the admin session and parses the body, or returns the
 * response the route should send instead.
 */
export async function openAdminAction(request: Request): Promise<AdminActionGate> {
  const session = verifyAdminRequest(request);
  if (!session) {
    return { ok: false, response: json({ error: "Nicht autorisiert." }, 401) };
  }

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.length > MAX_ACTION_BODY_BYTES) {
      return { ok: false, response: json({ error: "Ungültige Anfrage." }, 400) };
    }
    if (raw) body = JSON.parse(raw);
  } catch {
    return { ok: false, response: json({ error: "Ungültige Anfrage." }, 400) };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: json({ error: "Ungültige Anfrage." }, 400) };
  }

  return { ok: true, context: { session, body } };
}

/** An action outcome as an HTTP response, with no detail on a refusal. */
export function adminActionResponse(outcome: { ok: boolean; status?: number; error?: string }): Response {
  if (!outcome.ok) {
    return json({ error: outcome.error ?? "Aktion fehlgeschlagen." }, outcome.status ?? 400);
  }
  return json(outcome, 200);
}
