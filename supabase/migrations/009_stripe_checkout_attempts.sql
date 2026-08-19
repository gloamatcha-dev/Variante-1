-- ============================================================
-- GLOA – Stripe Checkout Attempts + Webhook Event Deduplication
-- Run in Supabase SQL Editor AFTER 001–008
--
-- Foundation only: no orders/order_items are created here.
-- checkout_attempts records the authoritative server-side quote for a
-- checkout attempt and tracks it through Stripe payment confirmation.
-- Real order creation (with final shipping/tax/customer data) is a
-- separate, later migration and task.
-- ============================================================

-- 1. CHECKOUT ATTEMPTS ─────────────────────────────────────────

create table public.checkout_attempts (
  id                          uuid primary key default gen_random_uuid(),

  -- Client-generated checkout attempt identifier. One row per attempt;
  -- a retry with the same request_id must never create a second row.
  request_id                  uuid not null unique,

  user_id                     uuid references auth.users(id) on delete set null,

  status                      text not null default 'created'
                              check (status in (
                                'created', 'stripe_session_created',
                                'paid', 'failed', 'expired'
                              )),

  currency                    text not null default 'EUR'
                              check (currency = 'EUR'),

  -- Authoritative server-computed total (integer cents) this attempt is
  -- expected to be paid for. Set once from lib/checkoutQuote.ts and never
  -- recomputed from a later, possibly-changed catalog price.
  expected_total_gross_cents  integer not null check (expected_total_gross_cents >= 0),

  -- Authoritative per-item snapshot from the same server-side quote.
  items_snapshot              jsonb not null,

  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  paid_at                     timestamptz
);

-- A Stripe Checkout Session may back at most one checkout attempt.
create unique index checkout_attempts_stripe_session_id_key
  on public.checkout_attempts (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index idx_checkout_attempts_user on public.checkout_attempts(user_id);

-- Auto-update updated_at (reuse existing function from 001)
create trigger set_checkout_attempts_updated_at
  before update on public.checkout_attempts
  for each row execute function public.set_updated_at();

alter table public.checkout_attempts enable row level security;

-- No SELECT/INSERT/UPDATE/DELETE policies for anon or authenticated.
-- Checkout attempts are written and read exclusively by server-side code
-- using the server-only Supabase secret key, which bypasses RLS. There is
-- currently no product need for a signed-in user to read their own
-- checkout attempts, so no client SELECT policy is added (least privilege).
-- No grants to anon or authenticated.

-- 2. STRIPE WEBHOOK EVENT DEDUPLICATION ───────────────────────

create table public.stripe_webhook_events (
  stripe_event_id       text primary key,
  event_type            text not null,
  checkout_session_id   text,
  processed_at          timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;

-- No policies, no grants to anon or authenticated. Only server-side code
-- using the server-only Supabase secret key writes here, to guarantee a
-- given Stripe event id is only ever processed once even under concurrent
-- webhook delivery (the primary key is the actual race-safety guard, not
-- application-level "select then insert" logic).
