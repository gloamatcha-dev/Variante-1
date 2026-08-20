-- ============================================================
-- GLOA – Checkout Attempt Shipping Snapshot (foundation)
-- Run in Supabase SQL Editor AFTER 009–014
--
-- Schema-only preparation for Task 20B (concrete shipping prices), once
-- shipping_address_collection lets a customer pick a country before a
-- Checkout Session is created and a zone-priced shipping_options entry
-- is computed server-side for it. No pricing logic or values are added
-- here - all three columns stay NULL until Task 20B actually computes
-- and writes them.
--
-- Why this lives on checkout_attempts (not just orders):
-- - The attempt needs to remember which country/zone/price were priced
--   BEFORE payment, so the correct single Stripe shipping_options entry
--   can be reconstructed for that specific attempt.
-- - The webhook can then cross-check that Stripe's actual confirmed
--   session data still matches what was priced, instead of trusting
--   that nothing changed between attempt creation and payment.
-- - shipping_zone is stored explicitly (not just re-derived from
--   shipping_country via lib/shipping.ts's getShippingZone() at read
--   time) so a later change to the zone configuration can never alter
--   what an already-created attempt was actually priced under.
-- ============================================================

alter table public.checkout_attempts
  add column shipping_country     text,
  add column shipping_zone        text
                                   check (shipping_zone is null or shipping_zone in (
                                     'germany', 'eu', 'nonEuCore', 'restOfEurope'
                                   )),
  add column shipping_gross_cents integer
                                   check (shipping_gross_cents is null or shipping_gross_cents >= 0);
