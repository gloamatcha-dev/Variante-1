-- Restrict the sequence-writing helper; trusted postgres-owned RPC/default chain remains.
-- Run the separate read-only 084 preflight before applying and postcheck afterward.
begin;
revoke execute on function public.generate_order_number()
  from public, anon, authenticated;
commit;
