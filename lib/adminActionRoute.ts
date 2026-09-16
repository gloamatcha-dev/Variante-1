import { verifyAdminRequest } from "./adminSessionDeps.ts";
import { resolveAdminIdentity, type AdminIdentity } from "./adminIdentityDeps.ts";
import { roleSatisfies, type AdminCapability } from "./adminRoles.ts";

/**
 * THE FRONT DOOR EVERY ADMIN ACTION ROUTE GOES THROUGH.
 *
 * Thirteen routes go through here - ten that write order or inventory
 * state and three that read it - and each must check the same things
 * before it does anything else: a valid admin session, an admin_users
 * row that is still active, a ROLE sufficient for what the route does, a
 * body small enough to refuse an unauthorized flood, and JSON that
 * parses. Written once so that all thirteen are provably identical
 * rather than accidentally similar - a test asserts every one of them
 * calls this and that nothing else stands between a request and the
 * session check.
 *
 * ── THIS IS THE ONE PLACE A ROLE IS ENFORCED ──────────────────
 *
 * Not ten checks that must agree. A viewer is refused HERE, on the
 * server, by a route that never runs - not by a button the UI chose not
 * to draw. Hiding a control is a suggestion; this is the rule.
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

export type AdminActionContext = {
  session: { userId: string; email: string };
  /** The admin_users row, read fresh for this request. */
  identity: AdminIdentity;
  body: unknown;
};

export type AdminActionGate =
  | { ok: true; context: AdminActionContext }
  | { ok: false; response: Response };

const json = (body: unknown, status: number) => Response.json(body, { status });

/**
 * Verifies the admin session and parses the body, or returns the
 * response the route should send instead.
 */
export async function openAdminAction(
  request: Request,
  /**
   * WHAT THIS ROUTE NEEDS, stated by the ROUTE and never by the caller.
   *
   * Defaults to "write" on purpose. A route added later that forgets to
   * say what it is gets the RESTRICTIVE answer, so the failure mode of
   * forgetting is a viewer who cannot read something - visible, and
   * fixed in a minute - rather than a viewer who can ship an order.
   */
  capability: AdminCapability = "write"
): Promise<AdminActionGate> {
  const session = verifyAdminRequest(request);
  if (!session) {
    return { ok: false, response: json({ error: "Nicht autorisiert." }, 401) };
  }

  // ── WHO THEY ARE NOW, NOT WHO THEY WERE AT SIGN-IN ──────────
  //
  // Read fresh from admin_users. A row that is missing, switched off or
  // carrying an unrecognised role ends the request here. This is 401
  // rather than 403: a cookie whose subject is no longer an
  // administrator is not an under-privileged caller, it is an
  // unauthenticated one.
  const lookup = await resolveAdminIdentity(session.userId, session.email);
  if (!lookup.ok) {
    return { ok: false, response: json({ error: "Nicht autorisiert." }, 401) };
  }

  // ── AND WHETHER THAT IS ENOUGH FOR THIS ROUTE ───────────────
  //
  // 403, not 401: this caller IS authenticated and the answer will not
  // change by signing in again. Saying 401 here would send a viewer
  // round a login loop that can never succeed.
  if (!roleSatisfies(lookup.identity.role, capability)) {
    return { ok: false, response: json({ error: "Keine Berechtigung." }, 403) };
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

  return { ok: true, context: { session, identity: lookup.identity, body } };
}

/** An action outcome as an HTTP response, with no detail on a refusal. */
export function adminActionResponse(outcome: { ok: boolean; status?: number; error?: string }): Response {
  if (!outcome.ok) {
    return json({ error: outcome.error ?? "Aktion fehlgeschlagen." }, outcome.status ?? 400);
  }
  return json(outcome, 200);
}

/**
 * THE SAME GATE FOR A ROUTE THAT READS ITS OWN BODY.
 *
 * /api/admin/orders, its detail route and /api/admin/waitlist parse
 * their own payloads and answer their own shapes, so they never used
 * openAdminAction. They still need every identity condition it applies:
 * a valid session, an admin_users row that is still active, and a role
 * sufficient for what they do.
 *
 * Without this, switching somebody to inactive would stop their writes
 * and leave them reading orders and the launch list until their cookie
 * lapsed - which is not what "switched off" means.
 *
 * Returns the identity, or the Response the route should send instead.
 */
export type AdminIdentityGate =
  | { ok: true; session: { userId: string; email: string }; identity: AdminIdentity }
  | { ok: false; response: Response };

export async function requireAdminIdentity(
  request: Request,
  capability: AdminCapability = "write"
): Promise<AdminIdentityGate> {
  const session = verifyAdminRequest(request);
  if (!session) {
    return { ok: false, response: json({ error: "Nicht autorisiert." }, 401) };
  }

  const lookup = await resolveAdminIdentity(session.userId, session.email);
  if (!lookup.ok) {
    return { ok: false, response: json({ error: "Nicht autorisiert." }, 401) };
  }

  if (!roleSatisfies(lookup.identity.role, capability)) {
    return { ok: false, response: json({ error: "Keine Berechtigung." }, 403) };
  }

  return { ok: true, session, identity: lookup.identity };
}
