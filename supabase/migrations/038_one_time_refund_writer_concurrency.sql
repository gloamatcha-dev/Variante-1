-- ============================================================
-- GLOA - Migration 038: one-time refund writer concurrency
-- Run in Supabase SQL Editor AFTER 001-037
--
-- ONE FUNCTION REPLACED. NOTHING ELSE.
--
-- No table, no column, no index, no constraint, no trigger, no
-- policy, no table grant, no data. This migration replaces the body
-- of a single existing SECURITY DEFINER function and stops.
--
-- Migration 019 is not edited. Migration 037 is not edited. Nothing
-- calls the function during this migration.
-- ============================================================

-- 1. THE DEFECT THIS CLOSES ────────────────────────────────────
--
-- public.apply_order_refund_state (migration 019, live and immutable)
-- resolves its target order in two separate statements:
--
--   A)  select count(*) ... where stripe_payment_intent_id = $1
--   B)  select *        ... where stripe_payment_intent_id = $1
--                                 for update
--
-- Under READ COMMITTED - which is what a PostgREST RPC call runs at -
-- A and B take SEPARATE SNAPSHOTS. Whatever another transaction
-- commits in between is fully visible to B and completely invisible to
-- A. Two distinct defects follow, and they need different fixes.
--
-- DEFECT 1: THE ZERO-ROW RACE.
--
-- A counts 1, the matching row disappears or its correlation changes,
-- B returns nothing. SELECT INTO without STRICT does not raise on zero
-- rows: it sets FOUND false and sets every field of the row variable to
-- NULL. 019 has no guard there, and a NULL v_order does not stop the
-- function - it makes every test below answer NULL and fall through:
--
--   payment_status not in (...)        -> NULL, IF not true, falls through
--   p_refunded > total_gross_cents     -> NULL, falls through
--   p_refunded >= NULL and NULL > 0    -> NULL, first arm not taken, so
--                                         the ladder picks an arm from
--                                         p_refunded_total_cents ALONE
--   payment_status = v_new_status      -> NULL and false = false, so not
--                                         'unchanged'
--   update ... where id = NULL         -> matches nothing, writes nothing
--   return 'applied'
--
-- A payment fact reported durable that was never written. This is the
-- same defect that was found and closed in 037 before it went live.
--
-- DEFECT 2: THE MULTIPLE-ROW RACE, WHICH A FOUND GUARD DOES NOT FIX.
--
-- A counts 1, a second order with the same payment intent becomes
-- visible, B returns TWO rows. SELECT INTO without STRICT does not
-- detect that either: it takes the first row the query happened to
-- return, silently discards the rest, and sets FOUND TRUE. A NOT FOUND
-- guard sees a perfectly healthy result and lets the function write a
-- refund onto an order that is not the one the caller resolved.
--
-- 037 does not have this problem because both of its correlation hops
-- are backed by live unique indexes (checkout_attempts_stripe_invoice_id_key
-- from 022, orders_checkout_attempt_id_key from 011), so a second row
-- cannot appear at all. 019's column has NO index of any kind, unique
-- or otherwise, so its ambiguity check is the only thing standing
-- between a refund and the wrong order - and a count taken in a
-- separate snapshot is not a proof.

-- 2. WHY NOT A UNIQUE INDEX ────────────────────────────────────
--
-- A partial unique index on orders(stripe_payment_intent_id) would make
-- the second race structurally impossible, and it is what a reader of
-- the checkout architecture would expect to be valid: mode 'payment'
-- Checkout Sessions each own a distinct PaymentIntent, one session
-- backs one attempt (009), and one attempt backs one order (011).
--
-- IT IS NOT VALID AGAINST THIS DATABASE. A read-only verification of
-- Production found ONE duplicated non-null value already stored, shared
-- by 41 orders: 41 distinct checkout_attempt_id values, no Stripe
-- checkout session id, no user id, one distinct order total, every one
-- of them payment_status 'paid', created inside a 31-hour window, and
-- the stored value is 13 characters long - far shorter than any real
-- Stripe PaymentIntent id.
--
-- So the column does not hold what the architecture implies it holds,
-- and CREATE UNIQUE INDEX would fail outright. Those rows are NOT
-- touched here: this migration reads no row and writes no row. What it
-- does instead is make the function behave CORRECTLY in their presence,
-- which it must do whether they are ever cleaned up or not. All 41
-- share one value, so a refund naming that value counts 41, and this
-- function refuses with 'ambiguous_payment_intent' without selecting or
-- mutating any of them.
--
-- No ordinary index either. The sequential scan this function causes is
-- real and is a performance question, and performance questions do not
-- belong in a correctness migration.

-- 3. THE LOCK, AND WHY IT IS THIS EXACT MODE ───────────────────
--
-- Neither race can be closed by reordering or by guarding the existing
-- statements, because both are caused by another transaction COMMITTING
-- between them. At READ COMMITTED there is no predicate locking: FOR
-- UPDATE can lock only rows that already exist in its own snapshot, so
-- it cannot prevent a row from arriving. Only a table-level lock can
-- exclude the writes that change the answer.
--
-- REQUIRED PROPERTY: for the remainder of this short transaction, no
-- other transaction may INSERT, UPDATE or DELETE a row of public.orders,
-- while ordinary SELECT readers stay unaffected.
--
-- INSERT, UPDATE and DELETE all take ROW EXCLUSIVE on the table. So the
-- mode this function takes must conflict with ROW EXCLUSIVE.
--
-- SHARE MODE WAS EVALUATED FIRST AND IS REJECTED. It does have the
-- required property - SHARE conflicts with ROW EXCLUSIVE, so it does
-- block concurrent DML, and it does not conflict with ACCESS SHARE, so
-- plain readers are fine. It fails for a different reason: SHARE IS
-- SELF-COMPATIBLE. Two transactions may hold it at the same moment, and
-- this function goes on to run an UPDATE, which needs ROW EXCLUSIVE:
--
--   T1  lock table orders in share mode   -> granted
--   T2  lock table orders in share mode   -> granted, no conflict
--   T1  update orders ...                 -> needs ROW EXCLUSIVE, which
--                                            conflicts with T2's SHARE,
--                                            so T1 waits
--   T2  update orders ...                 -> needs ROW EXCLUSIVE, which
--                                            conflicts with T1's SHARE,
--                                            so T2 waits
--                                         -> DEADLOCK
--
-- That is the textbook lock-upgrade deadlock, and two refunds settling
-- at the same moment is exactly the concurrency this migration exists
-- to handle. PostgreSQL would detect it and abort one transaction with
-- SQLSTATE 40P01, which reaches the webhook as a 500 and a redelivery.
-- No data would be corrupted, but shipping a known deadlock inside a
-- concurrency fix is not a fix.
--
-- SHARE ROW EXCLUSIVE WAS EVALUATED SECOND AND IS ALSO REJECTED. It
-- fixes the deadlock above - it conflicts with itself, so two refund
-- calls serialise at the LOCK instead of upgrading into each other - but
-- it still ALLOWS ROW SHARE, and that is the hole. ROW SHARE is what
-- SELECT ... FOR UPDATE takes, and this database has five other live
-- functions that lock an orders row and then update it:
--
--   request_order_cancellation          019
--   cancel_order                        029
--   resolve_order_cancellation_request  031
--   mark_order_shipped                  032
--   apply_order_refund_state_by_invoice 037
--
-- Every one of them is the shape ROW SHARE + row lock, then ROW
-- EXCLUSIVE. Against a refund holding SHARE ROW EXCLUSIVE that produces a
-- genuine cross-RPC cycle, and the window is not theoretical - it is the
-- cardinality count below, which is a SEQUENTIAL SCAN because this column
-- carries no index:
--
--   T2  lock table orders in share row exclusive   -> granted
--   T1  select ... orders where order_number = X
--         for update                               -> ROW SHARE is
--                                                     COMPATIBLE with
--                                                     T2's mode, so T1
--                                                     is granted, and it
--                                                     now holds row X
--   T2  (finishes its seq scan, counts 1)
--   T2  select ... orders where stripe_payment_intent_id = ...
--         for update                               -> the same row X,
--                                                     held by T1, so T2
--                                                     waits on T1
--   T1  update public.orders ...                   -> needs ROW
--                                                     EXCLUSIVE, which
--                                                     conflicts with
--                                                     T2's SHARE ROW
--                                                     EXCLUSIVE, so T1
--                                                     waits on T2
--                                                  -> DEADLOCK
--
-- Refunding an order while its cancellation is being resolved, or while
-- it is being cancelled, is not an exotic interleaving. It is the normal
-- pairing: resolving a cancellation is exactly when a refund is issued.
--
-- EXCLUSIVE IS THE NARROWEST MODE THAT IS CORRECT. From PostgreSQL's
-- lock conflict table, a held EXCLUSIVE blocks requests for ROW SHARE,
-- ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE, SHARE ROW EXCLUSIVE,
-- EXCLUSIVE and ACCESS EXCLUSIVE, and allows ACCESS SHARE alone.
-- Therefore:
--
--   INSERT / UPDATE / DELETE   ROW EXCLUSIVE   BLOCKED  <- the property
--   SELECT ... FOR UPDATE      ROW SHARE       BLOCKED  <- closes the
--                                                          cycle above
--   another call to this fn    EXCLUSIVE       BLOCKED  <- serialised
--   plain SELECT               ACCESS SHARE    allowed  <- readers keep
--                                                          working
--
-- WHY THAT IS DEADLOCK-FREE, AND NOT JUST DEADLOCK-UNLIKELY. This
-- transaction requests exactly one table lock, on one table, as its first
-- act against that table, and it never requests a lock on anything else.
--
--   BEFORE the lock is granted it holds nothing, so no other transaction
--   can be waiting on it. A wait-for edge points away from it only.
--
--   AFTER the lock is granted, no other transaction holds ROW SHARE or
--   ROW EXCLUSIVE on public.orders - EXCLUSIVE waited them out, and a row
--   lock cannot outlive the table lock its holder needed to take it. So
--   nothing else holds a row lock here, and this function's own
--   SELECT ... FOR UPDATE and UPDATE wait for no one. A transaction never
--   conflicts with itself.
--
-- No outgoing wait-for edge in either half means this transaction cannot
-- be a member of a cycle. That is a structural argument, not a
-- probability one.
--
-- ACCESS EXCLUSIVE would also work and is deliberately not used: it would
-- additionally block plain SELECT, so the account page could not read an
-- order while any refund was being recorded. EXCLUSIVE is one step
-- narrower and gives up nothing this function needs.
--
-- THE COST, STATED PLAINLY. While this transaction holds the lock, every
-- write to public.orders waits - order creation from a paid checkout, the
-- email-state updates, and, under EXCLUSIVE, the five row-locking order
-- workflows named above as well. They WAIT; none of them fails, and none
-- of them deadlocks, which is the whole point of choosing this mode. Only
-- plain SELECT is unaffected, so nothing a customer or the account page
-- reads is blocked.
--
-- The lock is taken AFTER input validation, so a malformed call blocks
-- nothing, and it is released when the transaction ends, which for this
-- function is a few statements later. The one thing that makes that
-- window longer than it should be is the unindexed cardinality scan; an
-- ordinary index on stripe_payment_intent_id would shorten it and is
-- deliberately left to its own phase. That is the accepted price of
-- correctness on a column that carries no unique index and provably
-- carries duplicates.
--
-- PRIVILEGE NOTE. LOCK TABLE in any mode above ROW EXCLUSIVE requires
-- table-level UPDATE, DELETE or TRUNCATE privilege. This function is
-- SECURITY DEFINER and runs as its owner, which owns public.orders, so
-- the lock is available to it. service_role's own column-scoped UPDATE
-- grants are not involved and are not widened.
--
-- HONEST LIMIT OF THIS PROOF: the conflict semantics above are read from
-- the PostgreSQL specification, which has been stable across every
-- version Supabase ships. They were NOT executed against a database.
-- This migration has not been applied anywhere; the owner applies and
-- verifies it manually.

-- 4. WHAT IS DELIBERATELY UNCHANGED ────────────────────────────
--
--   * the signature (text, integer, boolean) and the return type
--   * the seven result words, exactly: 'invalid_input',
--     'order_not_found', 'ambiguous_payment_intent', 'not_applicable',
--     'invalid_amount', 'unchanged', 'applied'. No eighth word.
--   * input validation, character for character
--   * the comparison itself. 019 validates with btrim but COMPARES the
--     raw parameter, and that stays raw: this is a concurrency phase,
--     not an identifier-normalisation phase, and quietly trimming would
--     change which rows match.
--   * the whole refund transition, from the eligibility gate to
--     'applied', character for character
--   * the three writable columns, and only those three
--
-- NO ROW_COUNT ASSERTION. After the table lock, the cardinality proof
-- and the row lock, the UPDATE targets a locked row by primary key and
-- a concurrent deleter would be blocked by both locks. There is no
-- reachable zero-row case left for it to catch, and it could only report
-- one by borrowing a word that means something else. The function stays
-- simpler instead.

create or replace function public.apply_order_refund_state(
  p_payment_intent_id   text,
  p_refunded_total_cents integer,
  p_has_pending_refund  boolean
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order       public.orders;
  v_match_count integer;
  v_new_status  text;
begin
  -- 019's validation, unchanged. It runs BEFORE the lock on purpose: a
  -- caller that passes nothing usable must not stall every write to
  -- public.orders on its way to being refused.
  if p_payment_intent_id is null
     or btrim(p_payment_intent_id) = ''
     or p_refunded_total_cents is null
     or p_refunded_total_cents < 0
  then
    return 'invalid_input';
  end if;

  -- THE FIRST STATEMENT THAT TOUCHES public.orders, AND IT IS THE LOCK.
  --
  -- Everything below reads the table twice and writes it once, and all
  -- three must see the same set of matching rows. Nothing that could
  -- decide a refund is allowed to run before this line - not the count,
  -- not the select, not a status test - because a decision taken before
  -- the writers are excluded is a decision taken from a snapshot that is
  -- still moving. See section 3 for why EXCLUSIVE and not SHARE or SHARE
  -- ROW EXCLUSIVE: both of those let another order workflow hold a row
  -- lock here and deadlock against this one.
  lock table public.orders in exclusive mode;

  -- CARDINALITY, PROVEN UNDER THE LOCK.
  --
  -- Identical to 019's count. What changed is not the query, it is that
  -- no INSERT, UPDATE or DELETE can commit between this statement and
  -- the select below, so the number this returns is still true when the
  -- row is locked.
  select count(*) into v_match_count
  from public.orders
  where stripe_payment_intent_id = p_payment_intent_id;

  if v_match_count = 0 then
    -- A payment intent we have no order for is not an error: it may
    -- belong to something that was never fulfilled here.
    return 'order_not_found';
  end if;

  -- Never guess which order a refund belongs to. This is the branch the
  -- 41 Production rows sharing one value take, and it is taken BEFORE
  -- any row is selected for a business decision: no arbitrary member of
  -- an ambiguous group is ever read, let alone written.
  if v_match_count > 1 then
    return 'ambiguous_payment_intent';
  end if;

  -- EXACTLY ONE MATCH, SO THIS SELECT CANNOT BE AMBIGUOUS.
  --
  -- No ORDER BY, no LIMIT 1, and no reliance on SELECT INTO quietly
  -- keeping the first of several rows. Those would all manufacture an
  -- answer where the honest answer is a refusal. The row lock is still
  -- taken: the table lock excludes writers that would change WHICH row
  -- matches, and FOR UPDATE serialises two callers deciding about the
  -- SAME row.
  select * into v_order
  from public.orders
  where stripe_payment_intent_id = p_payment_intent_id
  for update;

  -- DEFENCE IN DEPTH, AND IT IS NOT OPTIONAL.
  --
  -- Under the lock above this cannot fire. It stays because the entire
  -- defect in 019 was that a NULL v_order does not stop the function -
  -- it silently reaches 'applied' having written nothing - so the guard
  -- that makes the lock mean something belongs here permanently, not
  -- only while someone remembers why.
  if not found then
    return 'order_not_found';
  end if;

  -- MIGRATION 019'S TRANSITION FOLLOWS, UNCHANGED ──────────────
  --
  -- Character for character from here to 'applied'. A one-time order and
  -- a subscription order must reach the same payment state from the same
  -- facts, and 037 already holds this same block; a test proves all three
  -- agree.

  -- An order that was never paid has no refund story to tell.
  if v_order.payment_status not in ('paid', 'refund_pending', 'partially_refunded', 'refunded') then
    return 'not_applicable';
  end if;

  if p_refunded_total_cents > v_order.total_gross_cents then
    return 'invalid_amount';
  end if;

  if p_refunded_total_cents >= v_order.total_gross_cents and v_order.total_gross_cents > 0 then
    v_new_status := 'refunded';
  elsif p_refunded_total_cents > 0 then
    v_new_status := 'partially_refunded';
  elsif coalesce(p_has_pending_refund, false) then
    v_new_status := 'refund_pending';
  else
    -- No settled and no pending refund: any earlier refund attempt was
    -- cancelled or failed, so the order is simply paid again.
    v_new_status := 'paid';
  end if;

  if v_order.payment_status = v_new_status
     and v_order.refunded_total_cents is not distinct from p_refunded_total_cents
  then
    return 'unchanged';
  end if;

  update public.orders
     set payment_status       = v_new_status,
         refunded_total_cents = p_refunded_total_cents,
         refund_updated_at    = now()
   where id = v_order.id;

  return 'applied';
end;
$$;

-- 5. EXECUTE PRIVILEGES ────────────────────────────────────────
--
-- CREATE OR REPLACE keeps the existing ACL, so these are a restatement
-- rather than a change. They are written out in full because this is a
-- SECURITY DEFINER writer that runs as the table owner: if its ACL ever
-- drifted, a browser role could reach the owner's privileges through it.
-- Naming every role makes the intended end state readable in one place
-- instead of inferred from 019 plus whatever happened since.
--
-- service_role is revoked and re-granted deliberately: revoking first
-- discards any privilege it may hold beyond EXECUTE.
--
-- NO TABLE GRANT IS TOUCHED. The legacy REFERENCES / TRIGGER / TRUNCATE
-- privileges that a read-only inspection found on public.orders are NOT
-- addressed here; they belong to the separate security audit.

revoke all on function public.apply_order_refund_state(text, integer, boolean) from public;
revoke all on function public.apply_order_refund_state(text, integer, boolean) from anon;
revoke all on function public.apply_order_refund_state(text, integer, boolean) from authenticated;
revoke all on function public.apply_order_refund_state(text, integer, boolean) from service_role;

grant execute on function public.apply_order_refund_state(text, integer, boolean) to service_role;

-- 6. WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
-- It calls no function, reads no row and writes no row. It creates no
-- index, unique or otherwise, and no constraint. It does not clean, move
-- or even look at the 41 duplicate orders. It does not touch migration
-- 019, migration 037, public.apply_order_refund_state_by_invoice, any
-- table grant, any policy, the refund email state, the subscription
-- lifecycle or the payment failure lifecycle.
