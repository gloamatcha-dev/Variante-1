-- ══════════════════════════════════════════════════════════════
-- 065  GUEST ORDER MANAGEMENT
-- ══════════════════════════════════════════════════════════════
--
-- A one-time order can be placed without an account. The cancellation
-- REQUEST that migration 019 built could not: it is reachable only from
-- /account/orders/<id>, and its function refuses a NULL p_user_id by
-- design. So a guest could buy, and then had no way to ask us to stop
-- the parcel - the promise the order confirmation makes ("melde uns per
-- E-Mail") was the only route, and it is not a route the system can see.
--
-- This migration is the durable half of closing that gap. It adds:
--
--   1. public.order_guest_access        one opaque credential per order
--   2. attach_guest_order_manage_token  the only writer of that table
--   3. guest_order_id_for_token         the only reader of that table
--   4. apply_order_cancellation_request 019's rule, extracted verbatim
--   5. request_order_cancellation       redefined as a thin wrapper
--   6. request_order_cancellation_by_token  the guest's wrapper
--
-- ── WHY A TABLE AND NOT TWO COLUMNS ON public.orders ──────────
--
-- Two columns on public.orders was the obvious shape and it is the wrong
-- one here, for a reason that is specific to this codebase:
-- app/AccountPortal.tsx reads a customer's own order with
--
--     supabase.from("orders").select("*")
--
-- through the anon key, under the "Users read own orders" RLS policy
-- from migration 004. A column on public.orders is therefore a column
-- shipped to a browser. The stored value is a SHA-256 digest and not a
-- usable credential - the routes compare the digest of a supplied token
-- against it, so holding the digest authorizes nothing - but a
-- credential-shaped value has no business travelling to a client, and
-- the alternative (revoking the column from `authenticated`) would break
-- that select("*") outright: PostgreSQL requires SELECT on EVERY column
-- for `select *`, so a column-level revoke would turn the account order
-- page into a permission error.
--
-- A separate table has neither problem. It is granted to NOBODY - not
-- anon, not authenticated, and not service_role - and is reachable only
-- through the two SECURITY DEFINER functions below. `select *` on
-- public.orders keeps working because public.orders did not change.
--
-- ── WHAT THE TOKEN IS ─────────────────────────────────────────
--
-- The plaintext token is NEVER stored, here or anywhere. It is derived
-- in application code as
--
--     HMAC-SHA256(server secret, 'gloa:guest-order-manage:v1' || order id)
--
-- (lib/guestOrderAccess.ts), which gives three properties this migration
-- depends on and cannot itself enforce:
--
--   unguessable   256 bits of output behind a server-only secret. The
--                 order id alone buys nothing; the order NUMBER - the
--                 sequential, guessable value printed on every invoice -
--                 is not an input at all and authorizes nothing.
--   stable        a redelivered Stripe webhook derives the SAME token,
--                 so a confirmation-email retry carries the SAME link.
--                 That is why the token cannot be random: a random
--                 token would have to be stored in plaintext to survive
--                 a retry, and storing it is the one thing forbidden.
--   single-order  the order id is inside the message, so a token for
--                 order A cannot resolve order B. The UNIQUE on
--                 token_hash makes that a database guarantee too.
--
-- ── NO EXPIRY, AND WHY ────────────────────────────────────────
--
-- The waitlist's confirmation token expires after 14 days (migration
-- 043) because an unconfirmed signup is not consent and must not be
-- kept. This token is the opposite kind of thing: it opens a receipt the
-- customer was already sent, for as long as customer service might need
-- it. An expiry would mean a customer writing in about an order from
-- last month is told their own link is invalid.
--
-- It is still revocable, and revocation is a row delete - which is why
-- the writer below can also rotate: attaching a DIFFERENT digest
-- replaces the old one and stamps rotated_at, so rotating the server
-- secret invalidates every outstanding link at once.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ───────────────────────────
--
-- It adds no refund path, no shipping transition and no admin surface.
-- A guest cancellation REQUEST lands in exactly the two columns 019
-- created, is answered by exactly the function 031 created, and blocks
-- shipment through exactly the guard 032 created. Storno is still not
-- Refund. Nothing here can cancel, refund, or ship anything.
--
-- Idempotent throughout: create-if-not-exists, drop-then-add for every
-- constraint, create-or-replace for every function. Re-running it
-- changes nothing.
-- ══════════════════════════════════════════════════════════════

-- 1. THE CREDENTIAL TABLE ──────────────────────────────────────
--
-- One row per order at most - order_id is the primary key, so "one
-- token per order" is structural rather than a rule some writer has to
-- remember. ON DELETE CASCADE because a credential for a deleted order
-- is not a credential, it is litter.
create table if not exists public.order_guest_access (
  order_id   uuid primary key references public.orders (id) on delete cascade,
  -- SHA-256 hex of the derived token. Never the token.
  token_hash text        not null,
  created_at timestamptz not null default now(),
  -- NULL until the digest is replaced. Then: when it was replaced.
  rotated_at timestamptz
);

-- The shape the application produces, pinned here so a bug that tried
-- to store something else - a raw token, an email, an order number - is
-- refused by the database instead of persisted.
alter table public.order_guest_access
  drop constraint if exists order_guest_access_token_hash_format_check;

alter table public.order_guest_access
  add constraint order_guest_access_token_hash_format_check
    check (token_hash ~ '^[0-9a-f]{64}$');

-- One digest resolves at most one order. This is the database's own
-- statement of "a token for order A cannot reach order B", independent
-- of how the token was derived.
create unique index if not exists order_guest_access_token_hash_key
  on public.order_guest_access (token_hash);

-- 2. NO ROLE MAY TOUCH IT ──────────────────────────────────────
--
-- RLS with zero policies denies every role that does not bypass it, and
-- no GRANT is issued to anon, to authenticated, or to service_role. The
-- three functions below are SECURITY DEFINER, so they reach the table as
-- its owner; nothing else can reach it at all.
--
-- service_role is deliberately included in that. It bypasses RLS, so RLS
-- alone would not stop it - the absence of a GRANT is what does. That
-- means a mistake in a route cannot select the digest column even by
-- accident, and a `select("*")` typed against the wrong table returns a
-- permission error rather than a credential.
alter table public.order_guest_access enable row level security;

revoke all on table public.order_guest_access from anon;
revoke all on table public.order_guest_access from authenticated;
revoke all on table public.order_guest_access from service_role;

-- 3. THE ONLY WRITER ───────────────────────────────────────────
--
-- Attaches a digest to an order, once. Called by the order-confirmation
-- sender immediately before the mail is built, so the link in the mail
-- and the row that makes it work are created in the same breath.
--
-- IDEMPOTENT BY VALUE, NOT BY EXISTENCE. A redelivered webhook derives
-- the same token, hands over the same digest, and gets 'unchanged' - no
-- second row, no second token, and created_at is not moved, because it
-- records when the customer's link started working. A DIFFERENT digest
-- is the rotation path: the row is replaced and rotated_at is stamped.
--
-- Refuses to attach to an order that does not exist, so a bug cannot
-- park a credential on nothing.
--
-- Returns:
--   'invalid_input' - no order id, or not a SHA-256 hex digest
--   'order_not_found'
--   'unchanged'     - this exact digest is already attached
--   'rotated'       - a different digest was attached and is replaced
--   'attached'      - first digest for this order
create or replace function public.attach_guest_order_manage_token(
  p_order_id   uuid,
  p_token_hash text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_existing text;
begin
  if p_order_id is null
     or p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
  then
    return 'invalid_input';
  end if;

  if not exists (select 1 from public.orders where id = p_order_id) then
    return 'order_not_found';
  end if;

  select token_hash into v_existing
  from public.order_guest_access
  where order_id = p_order_id
  for update;

  if found then
    if v_existing = p_token_hash then
      return 'unchanged';
    end if;
    update public.order_guest_access
       set token_hash = p_token_hash,
           rotated_at = now()
     where order_id = p_order_id;
    return 'rotated';
  end if;

  insert into public.order_guest_access (order_id, token_hash)
  values (p_order_id, p_token_hash)
  on conflict (order_id) do nothing;

  return 'attached';
end;
$$;

revoke all on function public.attach_guest_order_manage_token(uuid, text) from public;
grant execute on function public.attach_guest_order_manage_token(uuid, text) to service_role;

-- 4. THE ONLY READER ───────────────────────────────────────────
--
-- Turns a digest into the one order it belongs to, or NULL. NULL is the
-- answer for a digest that was never issued, for a revoked one, and for
-- a malformed one alike - so a caller learns "this link opens nothing"
-- and never which of those three it was, and never anything about which
-- orders exist.
--
-- Returns an id and nothing else. The caller reads the order itself
-- through the SELECT grant it already holds on public.orders, so this
-- function cannot become a second, wider order-reading surface.
create or replace function public.guest_order_id_for_token(p_token_hash text)
returns uuid
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select order_id into v_order_id
  from public.order_guest_access
  where token_hash = p_token_hash;

  return v_order_id;
end;
$$;

revoke all on function public.guest_order_id_for_token(text) from public;
grant execute on function public.guest_order_id_for_token(text) to service_role;

-- 5. 019'S RULE, EXTRACTED ─────────────────────────────────────
--
-- THE ONE CANCELLATION-REQUEST RULE IN THE DATABASE.
--
-- Every line of this body is migration 019's
-- request_order_cancellation, from the locking SELECT onward, moved
-- here unchanged and in the same order:
--
--   the row lock                    select ... for update
--   the idempotency check FIRST     already_requested
--   then the state transition       not_eligible
--   then the write                  the same two columns, nothing else
--
-- The idempotency check staying AHEAD of the eligibility check matters
-- and is not an accident of 019: an order that was already asked about
-- and has since shipped answers 'already_requested', which is true,
-- rather than 'not_eligible', which would read as "we never got your
-- message".
--
-- WHY EXTRACT IT AT ALL. Because there are now two ways to be
-- authorized to ask - an account, or a link - and only one rule about
-- whether asking is possible. Copying the rule into a second function
-- would create a second rule, and the copy would be the one that drifts:
-- the next change to what "too late to stop it" means would land in one
-- of them.
--
-- NOT CALLABLE FROM A ROUTE. This function takes an order id and NO
-- authorization argument, so being able to call it would be being able
-- to open a cancellation request on any order by id. It is therefore
-- granted to nobody: the two wrappers below are SECURITY DEFINER and
-- reach it as the owner, and service_role has no EXECUTE on it. The
-- authorization decision stays in the database, which is the property
-- 019 was built around.
--
-- Returns exactly 019's vocabulary:
--   'not_found' / 'not_eligible' / 'already_requested' / 'requested'
create or replace function public.apply_order_cancellation_request(
  p_order_id uuid,
  p_note     text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order public.orders;
begin
  if p_order_id is null then
    return 'not_found';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return 'not_found';
  end if;

  -- Idempotent: a second submission is not an error and must not move
  -- the timestamp, which would misrepresent when the customer asked.
  if v_order.cancellation_requested_at is not null then
    return 'already_requested';
  end if;

  -- State transition validated server-side. Once something has shipped,
  -- fulfillment cannot be un-done and the honest answer is the statutory
  -- withdrawal route, not a cancellation request.
  if v_order.status in ('cancelled', 'refunded', 'shipped', 'delivered')
     or v_order.fulfillment_status in ('cancelled', 'shipped', 'delivered')
     or v_order.payment_status in ('refunded', 'partially_refunded')
  then
    return 'not_eligible';
  end if;

  update public.orders
     set cancellation_requested_at = now(),
         cancellation_request_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_order_id;

  return 'requested';
end;
$$;

revoke all on function public.apply_order_cancellation_request(uuid, text) from public;
-- Deliberately NO grant to service_role. See above.

-- 6. THE ACCOUNT WRAPPER ───────────────────────────────────────
--
-- 019's function, same name, same three arguments, same return
-- vocabulary, same grant - and the same authorization it always had:
-- the row must belong to the user id the route verified against
-- Supabase Auth, and a foreign order is indistinguishable from a
-- non-existent one. app/api/orders/cancellation-request/route.ts is
-- unchanged and cannot tell the difference.
--
-- What moved out of it is the rule, not the check. The ownership
-- predicate is still evaluated here, in the database, against the
-- token-verified user id and never against anything the browser
-- claimed.
--
-- The unlocked ownership read is safe: an order's user_id is written
-- once by create_order_from_paid_checkout and never reassigned by
-- anything in this repository, so it cannot change between this SELECT
-- and the lock the core takes a line later. Every decision that CAN
-- change - already-requested, shipped, cancelled, refunded - is taken
-- inside the core, under the row lock, exactly as before.
create or replace function public.request_order_cancellation(
  p_order_id uuid,
  p_user_id  uuid,
  p_note     text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  if p_order_id is null or p_user_id is null then
    return 'not_found';
  end if;

  select id into v_order_id
  from public.orders
  where id = p_order_id
    and user_id = p_user_id;

  if not found then
    return 'not_found';
  end if;

  return public.apply_order_cancellation_request(v_order_id, p_note);
end;
$$;

revoke all on function public.request_order_cancellation(uuid, uuid, text) from public;
grant execute on function public.request_order_cancellation(uuid, uuid, text) to service_role;

-- 7. THE GUEST WRAPPER ─────────────────────────────────────────
--
-- The same rule, a different proof of authorization: possession of the
-- link. It takes NO order id and NO user id - there is nothing a caller
-- can pass that names an order, so there is nothing to tamper with. The
-- order is resolved from the digest and from nothing else.
--
-- An unissued, revoked or malformed digest returns 'not_found', which is
-- also what a foreign order returns from the account wrapper - the same
-- answer for "no such thing" and "not yours", so neither surface can be
-- used to discover which orders exist.
--
-- Deliberately does NOT require user_id to be NULL. A customer with an
-- account who opens the link from their own confirmation mail reaches
-- their own order, which is correct; their account page remains the
-- primary place they manage it, and this adds no privilege they did not
-- already have over their own row.
create or replace function public.request_order_cancellation_by_token(
  p_token_hash text,
  p_note       text
)
returns text
language plpgsql
volatile
security definer set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  v_order_id := public.guest_order_id_for_token(p_token_hash);

  if v_order_id is null then
    return 'not_found';
  end if;

  return public.apply_order_cancellation_request(v_order_id, p_note);
end;
$$;

revoke all on function public.request_order_cancellation_by_token(text, text) from public;
grant execute on function public.request_order_cancellation_by_token(text, text) to service_role;

-- 8. NO NEW CLIENT PRIVILEGES ──────────────────────────────────
--
-- anon and authenticated gain nothing from this migration: no table, no
-- column, no policy and no EXECUTE. A guest reads their order through
-- POST /api/orders/guest, which runs server-side with the service-role
-- client and returns a fixed, curated payload - never a table row.
--
-- public.orders itself is untouched. No column was added, no constraint
-- changed, no policy rewritten, and no historical order was modified -
-- which is also why every order placed before this migration simply has
-- no row in order_guest_access, and its old confirmation mail carries no
-- link that could resolve. Those customers keep the account page and
-- support@gloamatcha.com, exactly as they did yesterday.
