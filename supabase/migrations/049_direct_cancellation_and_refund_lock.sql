-- ══════════════════════════════════════════════════════════════
-- 049  DIRECT CANCELLATION CONFIRMATION + REFUND OPERATION LOCK
-- ══════════════════════════════════════════════════════════════
--
-- Two gaps found reviewing Paket 4A.1B, both about things the admin
-- screen can now do that nothing in the database was prepared for.
--
-- ── 1. A DIRECT CANCELLATION HAD NO CUSTOMER EMAIL ────────────
--
-- Migration 031 gave the order cancellation_outcome_email_status: the
-- answer to a cancellation the CUSTOMER ASKED FOR. An operator
-- cancelling an order on their own initiative is a different event -
-- nobody asked a question, so there is no outcome to report - and
-- reusing 031's columns for it would collapse two facts the operator
-- needs to tell apart into one. It would also make a reply arrive for a
-- question the customer never posed.
--
-- So this adds its own pair, in exactly the shape 017, 026, 031 and 033
-- already established: a status word, a sent timestamp, a grant of those
-- two columns and nothing else to service_role. Two columns, because
-- that is what the sibling senders use and this one is not special.
--
-- ── 2. TWO REFUNDS COULD START AT ONCE ────────────────────────
--
-- The Stripe idempotency key introduced in 4A.1B is derived from the
-- order, the amount already refunded and the amount being sent, so it
-- collapses a double click, a lost response and a network retry into ONE
-- economic refund. It cannot help with a genuinely different intent:
-- two operators, or two tabs, asking for 10,00 EUR and 20,00 EUR at the
-- same moment produce two different keys and Stripe would honour both.
--
-- A JavaScript variable cannot prevent that. Neither can a disabled
-- button or an in-memory mutex: the screen can be reloaded, and the
-- server runs as several instances that share no memory. The invariant
-- has to be durable, and durable here means a row in this database.
--
-- claim_order_refund is that lock. It is the same shape migration 045
-- uses for the welcome mail - a claim id, a claimed-at, and a stale
-- takeover in the same statement - because that shape has already been
-- reasoned about once and a second design would be a second set of
-- mistakes.
--
-- ── NOTHING ELSE CHANGES ──────────────────────────────────────
--
-- No existing column is altered or dropped. No existing function is
-- replaced. No RLS policy is added, removed or widened, and no anon or
-- authenticated grant is created: everything below is reachable only by
-- service_role, which is the server. The refund claim columns are NOT
-- granted to service_role at all - only the two functions write them,
-- and they are security definer - so even the server cannot set the lock
-- except through the code path that respects it.

begin;

-- ── 1. DIRECT CANCELLATION CONFIRMATION STATE ─────────────────
--
-- 'sending' / 'sent' / 'failed', the same three words every other order
-- email state machine uses, with NULL meaning "never attempted". The
-- sender claims by moving NULL or 'failed' to 'sending' in one
-- conditional UPDATE; a second caller finds no row to update and reports
-- already-sent rather than mailing twice.

alter table public.orders
  add column if not exists cancellation_confirmation_email_status text
    check (cancellation_confirmation_email_status in ('sending', 'sent', 'failed')),
  add column if not exists cancellation_confirmation_email_sent_at timestamptz;

-- The narrowest grant that lets the sender work: these two columns, on
-- this table, to the server role. service_role still holds no UPDATE on
-- status, fulfillment_status, payment_status, any money column or any
-- other lifecycle column - which is why an email failure still cannot
-- un-cancel anything.
grant update (cancellation_confirmation_email_status, cancellation_confirmation_email_sent_at)
  on public.orders to service_role;

-- ── 2. REFUND OPERATION LOCK ──────────────────────────────────
--
-- Deliberately NOT granted to service_role. The only writers are the two
-- functions below, both security definer, so the lock cannot be set or
-- cleared by a stray UPDATE that forgot what it was for.

alter table public.orders
  add column if not exists refund_operation_claim_id uuid,
  add column if not exists refund_operation_claimed_at timestamptz;

/**
 * Takes the refund lock for one order, or reports that somebody else
 * holds it.
 *
 * TWO STATEMENTS, ONE TRANSACTION, and the order matters. The first
 * expires a claim whose holder has plainly gone away; the second takes
 * the lock only if it is free. A caller that loses the race sees
 * claimed = false and its route answers 409.
 *
 * ── WHY A STALE TAKEOVER IS SAFE HERE ─────────────────────────
 *
 * A claim can only be stranded by a process dying between taking the
 * lock and releasing it. Two cases:
 *
 *   it never reached Stripe    nothing happened; the takeover is free.
 *   it reached Stripe and died before the sync ran. refunded_total_cents
 *                              is therefore UNCHANGED, so the retry
 *                              computes the SAME idempotency key, and
 *                              Stripe returns the refund it already made
 *                              instead of making a second one.
 *
 * The third case - Stripe succeeded AND the sync ran - cannot strand a
 * claim, because the release happens in the same code path as the sync.
 * And if the webhook has meanwhile moved refunded_total_cents, the next
 * attempt sees a smaller remaining amount and a different key, which is
 * the correct behaviour rather than a duplicate: the operator is then
 * deliberately refunding what is still outstanding.
 *
 * So the stale path releases rather than quarantines. There is nothing
 * for a human to review and no cron to build.
 *
 * p_stale_seconds is floored at 30 so a caller cannot pass a value small
 * enough to make the lock meaningless.
 */
create or replace function public.claim_order_refund(
  p_order_id uuid,
  p_claim_id uuid,
  p_stale_seconds integer default 180
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
  v_stale integer;
begin
  if p_order_id is null or p_claim_id is null then
    raise exception 'refund claim: an order id and a claim id are required';
  end if;

  v_stale := greatest(coalesce(p_stale_seconds, 180), 30);

  -- Expire a claim whose holder is plainly gone. Bounded by claimed_at
  -- rather than by any guess about what the holder was doing.
  update public.orders
     set refund_operation_claim_id   = null,
         refund_operation_claimed_at = null
   where id = p_order_id
     and refund_operation_claim_id is not null
     and refund_operation_claimed_at < now() - make_interval(secs => v_stale);

  -- Take it, if and only if it is free. UPDATE takes a row lock, so two
  -- concurrent callers serialize here and exactly one sees row_count 1.
  update public.orders
     set refund_operation_claim_id   = p_claim_id,
         refund_operation_claimed_at = now()
   where id = p_order_id
     and refund_operation_claim_id is null;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

/**
 * Gives the lock back.
 *
 * CONDITIONAL ON HOLDING IT. A caller whose claim already expired and
 * was taken over by somebody else must not be able to release the new
 * holder's lock on its way out, so the claim id has to match.
 *
 * Returns whether this call actually released something, which is
 * information the caller may log and must not act on: the refund has
 * either happened or not by then, and that is decided elsewhere.
 */
create or replace function public.release_order_refund(
  p_order_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_order_id is null or p_claim_id is null then
    raise exception 'refund release: an order id and a claim id are required';
  end if;

  update public.orders
     set refund_operation_claim_id   = null,
         refund_operation_claimed_at = null
   where id = p_order_id
     and refund_operation_claim_id = p_claim_id;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.claim_order_refund(uuid, uuid, integer) from public;
revoke all on function public.claim_order_refund(uuid, uuid, integer) from anon;
revoke all on function public.claim_order_refund(uuid, uuid, integer) from authenticated;
grant execute on function public.claim_order_refund(uuid, uuid, integer) to service_role;

revoke all on function public.release_order_refund(uuid, uuid) from public;
revoke all on function public.release_order_refund(uuid, uuid) from anon;
revoke all on function public.release_order_refund(uuid, uuid) from authenticated;
grant execute on function public.release_order_refund(uuid, uuid) to service_role;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFICATION (read-only, run by hand after applying)
-- ══════════════════════════════════════════════════════════════
--
--   1. The four columns exist and nothing else was touched:
--
--      select column_name, data_type
--        from information_schema.columns
--       where table_schema = 'public' and table_name = 'orders'
--         and column_name in ('cancellation_confirmation_email_status',
--                             'cancellation_confirmation_email_sent_at',
--                             'refund_operation_claim_id',
--                             'refund_operation_claimed_at')
--       order by column_name;
--
--      Expected: 4 rows.
--
--   2. The status CHECK is the same three words as its siblings:
--
--      select pg_get_constraintdef(oid)
--        from pg_constraint
--       where conrelid = 'public.orders'::regclass
--         and pg_get_constraintdef(oid) like '%cancellation_confirmation_email_status%';
--
--   3. The two functions exist and only service_role may run them:
--
--      select p.proname, p.prosecdef,
--             has_function_privilege('service_role', p.oid, 'execute') as service_role,
--             has_function_privilege('anon',         p.oid, 'execute') as anon,
--             has_function_privilege('authenticated',p.oid, 'execute') as authenticated
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and p.proname in ('claim_order_refund', 'release_order_refund');
--
--      Expected: prosecdef true, service_role true, anon false,
--                authenticated false, for both.
--
--   4. The lock columns are NOT writable by service_role directly:
--
--      select has_column_privilege('service_role', 'public.orders',
--                                  'refund_operation_claim_id', 'update');
--
--      Expected: false.
--
--   5. Nothing was lost:
--
--      select count(*) from public.orders;
--
--      Expected: unchanged.
--
--   6. RLS is untouched:
--
--      select relrowsecurity from pg_class
--       where oid = 'public.orders'::regclass;
--
--      Expected: true, as before.
