-- ============================================================
-- GLOA – Customer Withdrawal Requests (§ 356a BGB electronic
-- withdrawal function, in force since 19 June 2026)
-- Run in Supabase SQL Editor AFTER 017
--
-- NOT related to Task 21 tax/VAT/OSS (still paused) and NOT related to
-- Task 24A order confirmation email state (migration 017, untouched).
--
-- Durable record for a customer's electronic withdrawal declaration
-- (Task 25A). Deliberately minimal and deliberately NOT a foreign key
-- to public.orders: the submission endpoint must remain a one-way
-- "record this legal declaration" write, never an order-lookup API -
-- it never reads orders, never validates order_reference against real
-- order data, and never returns order details to the caller. Order
-- matching (if any) is a manual/back-office step outside this task's
-- website-only scope.
--
-- Guest-accessible by design: no user_id, no login requirement. A
-- signed-in customer withdrawing an order is recorded the same way as
-- a guest - the law requires the function to work for both.
-- ============================================================

create table public.withdrawal_requests (
  id                uuid primary key default gen_random_uuid(),

  -- Customer-supplied identification (§ 356a Abs. 2 Nr. 1 BGB) - never
  -- an internal id, never validated against auth.users.
  customer_name     text not null check (char_length(customer_name) between 1 and 200),

  -- Customer-supplied contract identification (§ 356a Abs. 2 Nr. 2
  -- BGB), e.g. an order number - free text, never joined against
  -- public.orders by this table.
  order_reference   text not null check (char_length(order_reference) between 1 and 200),

  -- Communication method for the required prompt confirmation
  -- (§ 356a Abs. 2 Nr. 3, Abs. 4 BGB).
  contact_email     text not null check (char_length(contact_email) between 3 and 254),

  scope             text not null check (scope in ('whole_order', 'partial')),

  -- Required and validated at the application layer when scope is
  -- 'partial' (which part is being withdrawn); optional free-text note
  -- otherwise.
  scope_note        text check (scope <> 'partial' or char_length(coalesce(scope_note, '')) > 0),

  customer_note     text check (customer_note is null or char_length(customer_note) <= 2000),

  submitted_at      timestamptz not null default now(),

  -- Confirmation-on-a-durable-medium delivery state (§ 356a Abs. 4
  -- BGB) - mirrors the pending/sending/sent/failed convention from
  -- migration 017, but as a single-attempt send (no concurrent-claim
  -- race to guard against here: each row is one customer submission,
  -- not a redelivered webhook), so no separate 'sending' state is
  -- needed.
  confirmation_status text not null default 'pending'
                      check (confirmation_status in ('pending', 'sent', 'failed')),
  confirmed_at        timestamptz
);

create index idx_withdrawal_requests_submitted_at on public.withdrawal_requests(submitted_at);

alter table public.withdrawal_requests enable row level security;

-- No SELECT/INSERT/UPDATE/DELETE policies for anon or authenticated -
-- submissions are written exclusively by the server-side withdrawal
-- API route (lib/supabaseAdmin.ts, service_role), matching the
-- checkout_attempts pattern (migration 009/010). No product need for a
-- client to read withdrawal_requests directly.

-- service_role needs SELECT too: the API route's insert(...).select()
-- call (to return id/submitted_at to build the confirmation email)
-- requires read privilege on the row it just wrote, same as the
-- existing checkout_attempts grant (migration 010). Afterward, it may
-- update only the confirmation-tracking columns - never the customer's
-- original declaration content - mirroring migration 017's
-- column-scoped grant.
grant select, insert on public.withdrawal_requests to service_role;
grant update (confirmation_status, confirmed_at) on public.withdrawal_requests to service_role;
