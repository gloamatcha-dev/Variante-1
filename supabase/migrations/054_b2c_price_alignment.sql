-- ══════════════════════════════════════════════════════════════
-- 054 — THE B2C CATALOG PRICES BECOME THE ONES GLOA CHARGES
--
-- Migration 008 seeded the three Matcha variants at 19.99 / 29.99 /
-- 54.99. The prices GLOA has decided to sell at are:
--
--   30 g   14.99   1499 cents
--   50 g   22.99   2299 cents
--   100 g  39.99   3999 cents
--
-- Every one of the seeded prices is HIGHER than the intended one - by
-- 5.00, 7.00 and 15.00. So this is not a rounding tidy-up: with
-- SHOP_STATUS flipped to "live" and nothing else changed, the first real
-- customer would have been overcharged by up to fifteen euros, and the
-- overcharge would have been frozen into their order snapshot, their
-- confirmation email and their Stripe payment.
--
-- It has not happened, because the prelaunch gate in
-- app/api/checkout/session/route.ts refuses to create a checkout attempt
-- or a Stripe session while the shop is not live. This migration is what
-- has to be true BEFORE that gate is ever opened.
--
-- ── WHY A MIGRATION AND NOT A HAND-EDIT ───────────────────────
--
-- 047 already set the pattern: a catalog correction is a numbered
-- migration full of guarded UPDATEs, not an UPDATE somebody types into
-- the SQL editor and nobody can find again. That matters here more than
-- usual, because product_variants.price_gross_cents is the SINGLE source
-- every paying path reads - the public page, the cart, the authoritative
-- server quote, the Stripe line items, the order snapshot, the
-- subscription price and the annual plan all descend from this column.
-- A price that exists only in production is a price no test can pin.
--
-- 008 IS NOT EDITED. It is applied and it is history: it records what
-- was seeded, and rewriting it would make the repository disagree with
-- what every existing order was actually priced against.
--
-- ── COMPARE-AND-SET, NOT BLIND OVERWRITE ──────────────────────
--
-- Each statement names the SKU *and* the value it expects to replace.
-- If somebody has already corrected a row by hand, or changed a price
-- for a reason this migration does not know about, that statement
-- matches nothing and changes nothing rather than silently reverting
-- their work. The check at the end then refuses to commit, so a partial
-- correction cannot be mistaken for a complete one.
--
-- SKU is the key because it is the stable commercial identity: unique,
-- enforced by 007, and the same string lib/tax.ts classifies on. Not the
-- label, not the gram weight, not the product id.
--
-- ── WHAT THIS DOES NOT TOUCH ──────────────────────────────────
--
--   GLOA-CASE-01   the Metal Case keeps 9.99 and stays inactive (047).
--   is_active, size_grams, label, sort_order, currency, product_id
--   orders, order_items, checkout_attempts   history, frozen on purpose
--   subscriptions                            existing Stripe prices are
--                                            a separate decision
--   tax, shipping, discounts                 nothing here touches them
--
-- A catalog price governs FUTURE quotes. It has never governed a past
-- one: every order carries its own unit_price_gross_cents, and every
-- checkout attempt its own frozen snapshot. That is why this migration
-- can be a three-line correction instead of a data migration.
-- ══════════════════════════════════════════════════════════════

begin;

-- ── 1. THE THREE CORRECTIONS ──────────────────────────────────

update public.product_variants
   set price_gross_cents = 1499
 where sku = 'GLOA-MATCHA-30G'
   and price_gross_cents = 1999;

update public.product_variants
   set price_gross_cents = 2299
 where sku = 'GLOA-MATCHA-50G'
   and price_gross_cents = 2999;

update public.product_variants
   set price_gross_cents = 3999
 where sku = 'GLOA-MATCHA-100G'
   and price_gross_cents = 5499;

-- ── 2. AND THE END STATE IS PROVEN BEFORE COMMIT ──────────────
--
-- Asserting the RESULT rather than counting the updates, so the
-- migration is idempotent: a second run updates nothing and still
-- passes, because the three rows already hold the intended values.
-- A drifted row - anything other than these three numbers - aborts the
-- transaction and leaves the catalog exactly as it was.

do $$
declare
  v_wrong integer;
begin
  select count(*) into v_wrong
  from public.product_variants
  where (sku = 'GLOA-MATCHA-30G'  and price_gross_cents <> 1499)
     or (sku = 'GLOA-MATCHA-50G'  and price_gross_cents <> 2299)
     or (sku = 'GLOA-MATCHA-100G' and price_gross_cents <> 3999);

  if v_wrong > 0 then
    raise exception
      '054: % B2C variant(s) do not hold the intended price - the catalog drifted and was NOT overwritten', v_wrong;
  end if;

  -- All three must exist. A missing SKU would satisfy the check above
  -- vacuously, and a catalog with two variants is not the catalog this
  -- migration was written against.
  select count(*) into v_wrong
  from public.product_variants
  where sku in ('GLOA-MATCHA-30G', 'GLOA-MATCHA-50G', 'GLOA-MATCHA-100G');

  if v_wrong <> 3 then
    raise exception '054: expected 3 B2C matcha variants, found %', v_wrong;
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. The three B2C prices are the decided ones:
--        select sku, label, size_grams, price_gross_cents, is_active
--        from public.product_variants
--        where sku like 'GLOA-MATCHA-%'
--        order by sort_order;
--      -> GLOA-MATCHA-30G  | 30 g  |  30 | 1499 | true
--      -> GLOA-MATCHA-50G  | 50 g  |  50 | 2299 | true
--      -> GLOA-MATCHA-100G | 100 g | 100 | 3999 | true
--
--   2. The Metal Case is untouched and still withheld:
--        select sku, price_gross_cents, is_active
--        from public.product_variants where sku = 'GLOA-CASE-01';
--      -> GLOA-CASE-01 | 999 | false
--
--   3. Nothing but the price moved:
--        select count(*) from public.product_variants;          -> 4
--        select count(*) from public.products;                  -> 2
--
--   4. HISTORY IS UNCHANGED. A catalog price governs future quotes
--      only, and these counts must be exactly what they were before:
--        select count(*) from public.orders;                    -> unchanged
--        select count(*) from public.order_items;               -> unchanged
--        select count(*) from public.checkout_attempts;         -> unchanged
--        select count(*) from public.subscriptions;             -> unchanged
--      And no past line was repriced:
--        select distinct unit_price_gross_cents
--        from public.order_items order by 1;
--      -> still contains the old values. That is correct: an order
--         records what was charged, not what the shop charges today.
-- ══════════════════════════════════════════════════════════════
