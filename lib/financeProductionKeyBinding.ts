import {randomUUID} from 'node:crypto';
import {createStripeReconciliationRead} from './stripeReconciliationClient.ts';

const account = 'acct_1U6B3ODI76FH9qsq';
const paymentIntent = 'pi_3UNcyODI76FH9qsq15ToRfXY';
const amount = 23268;
// Stable across deployments and instances. A consumed attempt cannot be rearmed.
const operationId = 'e874b7fc-14f9-4e22-80f4-0a738ae9abdc';

type Config = {
  account_id: string;
  owner_id: string;
  known_payment_intent: string;
  known_amount_cents: number;
};

type Options = {
  ownerId: string;
  confirm: unknown;
  loadConfig: () => Promise<Config | null>;
  consume: (args: Record<string, string>) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
};

export async function verifyProductionKeyBinding(options: Options) {
  const env = options.env ?? process.env;
  const approvedCommit = env.FINANCE_KEY_BINDING_APPROVED_COMMIT;
  const key = env.STRIPE_RECONCILIATION_READ_KEY;
  if (
    options.confirm !== 'VERIFY_ONE_PRODUCTION_PAYMENT_INTENT' ||
    env.VERCEL_ENV !== 'production' ||
    !approvedCommit || !/^[a-f0-9]{40}$/.test(approvedCommit) ||
    approvedCommit !== env.VERCEL_GIT_COMMIT_SHA ||
    !key?.startsWith('rk_live_')
  ) return false;

  try {
    const config = await options.loadConfig();
    if (config?.owner_id !== options.ownerId || config.account_id !== account ||
        config.known_payment_intent !== paymentIntent || config.known_amount_cents !== amount) return false;

    // The existing RPC returns success on a replay only for the same entity.
    // A distinct entity per attempt makes the unique operation key fail closed
    // for every competing or subsequent request, including after a timeout.
    const claimed = await options.consume({
      p_actor_user_id: options.ownerId,
      p_module: 'finance',
      p_action: 'verify_production_key_binding',
      p_entity_type: 'diagnostic_attempt',
      p_entity_id: randomUUID(),
      p_summary: 'Einmalige Stripe-Schlüsselbindungsprüfung beansprucht.',
      p_operation_id: operationId,
    });
    if (!claimed) return false;

    const read = createStripeReconciliationRead(key, options.request, () => 12000);
    const payment = await read('/v1/payment_intents/' + paymentIntent, {});
    return payment.id === paymentIntent && payment.livemode === true &&
      payment.currency === 'eur' && payment.status === 'succeeded' &&
      payment.amount_received === amount;
  } catch {
    return false;
  }
}
