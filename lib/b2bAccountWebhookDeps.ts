import {
  agreementForSubscription,
  applyPendingQuantity,
  reconcileCancellation,
  settleCancelledSubscription,
} from "./b2bAccountChangeDeps";
import type { B2bAccountWebhookDeps } from "./b2bAccountWebhook";

/**
 * The real wiring behind the 5G webhook steps.
 *
 * Four RPCs and nothing else - no Stripe client, because every fact
 * these steps need is already on the event object the webhook verified.
 * Kept apart from lib/b2bAccountWebhook.ts so the three steps can be
 * driven with stubs.
 */
export function b2bAccountWebhookDeps(): B2bAccountWebhookDeps {
  return {
    agreementForSubscription,
    applyPendingQuantity,
    reconcileCancellation,
    settleCancelledSubscription,
  };
}
