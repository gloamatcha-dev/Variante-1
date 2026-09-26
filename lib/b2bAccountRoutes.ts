import type { AuthenticatedCaller } from "./verifyUser";
import {
  cancelB2bMonthly,
  changeB2bMonthlyQuantity,
  type B2bChangeDeps,
  type B2bChangeOutcome,
} from "./b2bAccountChange.ts";
import { normaliseB2bCancellationReason } from "./b2bChangeRules.ts";

/**
 * THE TWO CUSTOMER WRITE SURFACES (Package 5G).
 *
 * POST /api/b2b/supply/[agreementId]/quantity
 * POST /api/b2b/supply/[agreementId]/cancel
 *
 * The same five gates the B2B checkout route has, in the same order and
 * for the same reasons: the FLAG costs one boolean, the CALLER is
 * verified before a body is read, the BUSINESS ACCOUNT is checked, and
 * only then is anything commercial touched.
 *
 * ── WHAT THE CLIENT MAY SEND ──────────────────────────────────
 *
 * quantity   { quantityPacks: 1..10 }
 * cancel     { reason?: string }
 *
 * And that is the whole vocabulary. No amount, no price id, no
 * subscription id, no effective date: every one of those is derived
 * server-side from the agreement and from Stripe, so a crafted body
 * cannot buy a different price or a different end date.
 */

type ErrorResponse = { error: string };

const json = (body: unknown, status: number) =>
  Response.json(body as Record<string, unknown>, { status });
const fail = (status: number, message: string) =>
  json({ error: message } as ErrorResponse, status);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type B2bAccountRouteDeps = {
  isEnabled: () => boolean;
  verifyCaller: (request: Request) => Promise<AuthenticatedCaller | null>;
  isBusinessAccount: (token: string, userId: string) => Promise<boolean>;
  change: B2bChangeDeps;
};

/**
 * The gates, once, for both routes.
 *
 * Returning a Response rather than throwing keeps the happy path of
 * each handler flat and makes "which gate refused" obvious in a test.
 */
async function gate(
  request: Request,
  deps: B2bAccountRouteDeps,
  agreementId: string
): Promise<{ ok: true; caller: AuthenticatedCaller } | { ok: false; response: Response }> {
  // 1. THE FLAG, BEFORE ANYTHING.
  if (!deps.isEnabled()) {
    return { ok: false, response: fail(404, "Nicht gefunden.") };
  }

  // 2. THE CALLER.
  const caller = await deps.verifyCaller(request);
  if (!caller) {
    return { ok: false, response: fail(401, "Bitte melde dich an.") };
  }

  // 3. THE BUSINESS ACCOUNT.
  const isBusiness = await deps.isBusinessAccount(caller.token, caller.userId);
  if (!isBusiness) {
    return { ok: false, response: fail(403, "Dieser Bereich ist Geschäftskonten vorbehalten.") };
  }

  // 4. A WELL-FORMED ID. Checked before it reaches a query.
  if (!UUID_RE.test(agreementId)) {
    return { ok: false, response: fail(404, "Belieferung nicht gefunden.") };
  }

  return { ok: true, caller };
}

/**
 * One outcome vocabulary, one HTTP mapping.
 *
 * `not_found` covers BOTH "no such agreement" and "somebody else's
 * agreement", deliberately: a 403 on another customer's id would
 * confirm the id exists.
 */
const STATUS_FOR: Record<string, number> = {
  not_found: 404,
  not_monthly: 409,
  not_active: 409,
  no_subscription: 409,
  no_billing_period: 409,
  not_priced: 409,
  cancellation_pending: 409,
  invalid_quantity: 400,
  invalid_reason: 400,
  quantity_out_of_range: 400,
  unexpected_subscription: 409,
  price_unavailable: 503,
};

const MESSAGE_FOR: Record<string, string> = {
  not_found: "Belieferung nicht gefunden.",
  not_monthly: "Diese Änderung ist nur bei monatlicher Belieferung möglich.",
  not_active: "Diese Belieferung ist nicht aktiv.",
  no_subscription: "Für diese Belieferung liegt noch keine Abrechnung vor.",
  no_billing_period: "Der nächste Abrechnungstermin steht gerade nicht fest. Bitte versuche es später erneut.",
  not_priced: "Für diese Belieferung liegt kein gültiger Preis vor.",
  cancellation_pending: "Deine Kündigung ist bereits vorgemerkt. Bis zum Enddatum bleibt alles wie vereinbart.",
  quantity_out_of_range: "Bitte wähle 1 bis 10 Packungen.",
  unexpected_subscription: "Diese Belieferung lässt sich gerade nicht ändern. Bitte melde dich bei uns.",
  price_unavailable: "Die Änderung ist gerade nicht möglich. Bitte versuche es später erneut.",
};

const GENERIC = "Die Änderung ist gerade nicht möglich. Bitte versuche es später erneut.";

function respond(outcome: B2bChangeOutcome): Response {
  if (outcome.ok) {
    return json({ ok: true, result: outcome.kind, ...(outcome.detail ?? {}) }, 200);
  }
  // The internal reason is LOGGED, never returned: it names database
  // results and Stripe objects.
  console.error(`B2B account change refused (${outcome.kind}): ${outcome.reason}`);
  return fail(STATUS_FOR[outcome.kind] ?? 409, MESSAGE_FOR[outcome.kind] ?? GENERIC);
}

/* ── QUANTITY ───────────────────────────────────────────────── */

export async function handleB2bQuantityChange(
  request: Request,
  deps: B2bAccountRouteDeps,
  agreementId: string
): Promise<Response> {
  const gated = await gate(request, deps, agreementId);
  if (!gated.ok) return gated.response;

  let body: { quantityPacks?: unknown };
  try {
    body = (await request.json()) as { quantityPacks?: unknown };
  } catch {
    return fail(400, "Ungültige Anfrage.");
  }

  const outcome = await changeB2bMonthlyQuantity(deps.change, {
    agreementId,
    userId: gated.caller.userId,
    quantityPacks: body.quantityPacks,
  });
  return respond(outcome);
}

/* ── CANCELLATION ───────────────────────────────────────────── */

export async function handleB2bCancellation(
  request: Request,
  deps: B2bAccountRouteDeps,
  agreementId: string
): Promise<Response> {
  const gated = await gate(request, deps, agreementId);
  if (!gated.ok) return gated.response;

  // A BODY IS OPTIONAL HERE. A cancellation with no reason is a
  // cancellation, and refusing one for a missing free-text field would
  // be a worse experience than the thing being cancelled.
  let body: { reason?: unknown } = {};
  try {
    body = (await request.json()) as { reason?: unknown };
  } catch {
    body = {};
  }

  const reason = normaliseB2bCancellationReason(body.reason);
  if (!reason.ok) {
    return fail(400, "Bitte kürze deine Begründung auf höchstens 500 Zeichen.");
  }

  const outcome = await cancelB2bMonthly(deps.change, {
    agreementId,
    userId: gated.caller.userId,
    reason: reason.reason,
  });
  return respond(outcome);
}
