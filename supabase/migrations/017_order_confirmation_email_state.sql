-- ============================================================
-- GLOA – Order Confirmation Email Delivery State
-- Run in Supabase SQL Editor AFTER 016
--
-- NOT the Task 21 tax/VAT/OSS migration - that work remains paused and
-- has never created a migration file, so 017 was free to use here.
-- This migration is unrelated to tax: it adds durable state for
-- tracking paid-order confirmation email delivery (Task 24A), so a
-- redelivered Stripe webhook event, or a manually-resent event with a
-- different event id, can never send a duplicate confirmation email -
-- while a genuine send failure still leaves the door open for a later
-- retry to succeed exactly once.
--
-- 'pending' (default): not yet attempted.
-- 'sending': a delivery has claimed the right to send (atomic guard
--   against two concurrent webhook deliveries both sending).
-- 'sent': Resend confirmed the message was accepted.
-- 'failed': the attempt failed - eligible for a future retry, since a
--   provider outage must never permanently block delivery.
--
-- Email delivery state is completely independent of payment/order
-- state - an email failure must never change status, payment_status,
-- or any money field on the order.
-- ============================================================

alter table public.orders
  add column confirmation_email_status text not null default 'pending'
    check (confirmation_email_status in ('pending', 'sending', 'sent', 'failed')),
  add column confirmation_email_sent_at timestamptz;

-- service_role (lib/supabaseAdmin.ts) has only ever had SELECT on
-- public.orders (migration 011) - every other order mutation so far
-- has gone through the SECURITY DEFINER create_order_from_paid_checkout
-- function, which bypasses grants entirely by running as its owner.
-- This is the first feature that needs service_role to update an
-- orders row directly, so it needs its own grant - scoped to exactly
-- these two new columns (not a blanket table UPDATE) so the email
-- delivery state machine can never touch payment/money/status fields,
-- even in the presence of a bug in that code path.
grant update (confirmation_email_status, confirmation_email_sent_at) on public.orders to service_role;
