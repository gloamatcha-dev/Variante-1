import { guardLaunchAdmin, readAdminBody } from "../../../../../lib/launchAdminRoute.ts";
import { SEND_CONFIRMATION, hasConfirmation } from "../../../../../lib/launchAdminAuth.ts";
import { buildLaunchSendWiring } from "../../../../../lib/launchSendDeps.ts";
import { DEFAULT_BATCH_SIZE, runLaunchSend } from "../../../../../lib/launchSend.ts";
import { SHOP_STATUS } from "../../../../content";

/**
 * STARTING THE SEND.
 *
 * The only endpoint in this repository that can mail the whole waiting
 * list, and it is written to be as hard to trigger by accident as a
 * useful endpoint can be.
 *
 * ── FOUR THINGS HAVE TO BE TRUE, AND NONE IS A CLOCK ──────────
 *
 *   1. A valid LAUNCH_ADMIN_SECRET (lib/launchAdminRoute.ts).
 *   2. The exact confirmation phrase in the body.
 *   3. SHOP_STATUS === "live", checked here.
 *   4. launch_release.released === true, checked INSIDE the claim
 *      function in migration 044 - where this endpoint cannot forget it
 *      and a future caller cannot skip it.
 *
 * Reaching 1 October at 12:00 is not one of them. The planned instant
 * is a fact about what the site SAYS; it grants nothing. Equally, not
 * having reached it forbids nothing: if the shop is live and a person
 * has released the launch, the clock has no further say.
 *
 * ── IT IS SAFE TO CALL TWICE ──────────────────────────────────
 *
 * Which matters, because the honest failure mode of a long HTTP request
 * is an operator who does not know whether it worked and clicks again.
 * A second call claims only rows the first did not finish: the claim is
 * atomic, already-sent rows are invisible to it, and rows whose outcome
 * was unknown are parked rather than retried. See lib/launchSend.ts.
 *
 * ── IT DOES A BOUNDED AMOUNT OF WORK ──────────────────────────
 *
 * One invocation drains at most `maxRows` and then returns. A serverless
 * runtime will kill a request long before a list of any size is
 * finished, and a run that is killed mid-flight leaves claims to expire.
 * So the endpoint is designed to be called repeatedly until
 * `confirmedUnsent` reaches zero, and it reports enough for the operator
 * to see that happening.
 */

/** Conservative default: finishes well inside a serverless request budget. */
const DEFAULT_MAX_ROWS_PER_CALL = 200;

export async function POST(request: Request): Promise<Response> {
  const gate = await guardLaunchAdmin(request);
  if (!gate.ok) return gate.response;

  const body = await readAdminBody(request);

  if (!hasConfirmation(body, SEND_CONFIRMATION)) {
    return Response.json(
      { error: `Bestätigung fehlt. Erwartet: {"confirm":"${SEND_CONFIRMATION}"}` },
      { status: 400 }
    );
  }

  // SHOP_STATUS is declared `as const`, so TypeScript narrows it to the
  // literal currently deployed and calls any comparison with "live"
  // unreachable. The comparison is the point: this file has to keep
  // working when the constant is flipped and redeployed, which is
  // exactly how the shop is released. Widened here rather than in
  // app/content.ts so no business file is touched for a type.
  const shopStatus: string = SHOP_STATUS;

  // The shop has to actually be open. The mail says it is.
  if (shopStatus !== "live") {
    return Response.json(
      { error: `Der Shop ist noch ${shopStatus}. Es wird nichts versendet.` },
      { status: 409 }
    );
  }

  const wiring = buildLaunchSendWiring();
  if (!wiring.ok) {
    console.error("Launch admin: send is not configured -", wiring.reason);
    return Response.json({ error: "Versand ist nicht konfiguriert." }, { status: 503 });
  }

  const requested = Number((body as { maxRows?: unknown }).maxRows);
  const maxRows =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), DEFAULT_MAX_ROWS_PER_CALL)
      : DEFAULT_MAX_ROWS_PER_CALL;

  const summary = await runLaunchSend(wiring.db, wiring.mailer, {
    batchSize: DEFAULT_BATCH_SIZE,
    maxRows,
  });

  // Counts only - no address, no id, no key. `needsReview` and
  // `unmarked` are the two an operator has to look at: both mean a
  // person has to reconcile against the provider's delivery log, and
  // neither will be retried automatically.
  return Response.json(summary, { status: 200 });
}
