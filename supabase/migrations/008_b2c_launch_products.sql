-- ============================================================
-- GLOA – B2C Launch Product Seed
-- Run in Supabase SQL Editor AFTER 001–007
-- ============================================================

-- Insert product + 3 variants in a single statement via CTE
with new_product as (
  insert into public.products (slug, name, is_active, sort_order)
  values ('matcha', 'GLOA Matcha', true, 0)
  returning id
)
insert into public.product_variants (product_id, sku, label, size_grams, price_gross_cents, currency, is_active, sort_order)
select
  new_product.id,
  v.sku,
  v.label,
  v.size_grams,
  v.price_gross_cents,
  'EUR',
  true,
  v.sort_order
from new_product,
(values
  ('GLOA-MATCHA-30G',  '30 g',   30, 1999, 10),
  ('GLOA-MATCHA-50G',  '50 g',   50, 2999, 20),
  ('GLOA-MATCHA-100G', '100 g', 100, 5499, 30)
) as v(sku, label, size_grams, price_gross_cents, sort_order);
