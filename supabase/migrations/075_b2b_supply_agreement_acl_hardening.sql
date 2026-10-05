-- Security prerequisite for 076; preserve 006/048 SELECT, original RLS and trusted RPCs.
-- Historical default privileges are not authorization for destructive table operations.
-- No tables, policies, functions, default privileges or business rows are changed.
begin;
do $hardening$
begin
 if not exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.b2b_supply_agreements') and relkind='r' and relrowsecurity) then
  raise exception '075: missing agreement/RLS baseline';
 end if;
 if not exists(select 1 from (values('anon'),('authenticated'),('service_role')) r(name) where pg_catalog.has_table_privilege(r.name,'public.b2b_supply_agreements','TRUNCATE')) then
  raise exception '075: already hardened; DO NOT REAPPLY';
 end if;
 if exists(select 1 from (values('anon'),('authenticated'),('service_role')) r(name)
 where pg_catalog.has_table_privilege(r.name,'public.b2b_supply_agreements','INSERT,UPDATE,DELETE')
 or pg_catalog.has_any_column_privilege(r.name,'public.b2b_supply_agreements','INSERT,UPDATE')) then
  raise exception '075: unexpected direct CRUD baseline; review before hardening';
 end if;
end;
$hardening$;

revoke insert, update, delete, truncate, references, trigger
 on table public.b2b_supply_agreements from public, anon, authenticated, service_role;

do $posture$
begin
 if exists(select 1 from (values('anon'),('authenticated'),('service_role')) r(name)
 where pg_catalog.has_table_privilege(r.name,'public.b2b_supply_agreements','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 or pg_catalog.has_any_column_privilege(r.name,'public.b2b_supply_agreements','INSERT,UPDATE,REFERENCES')) then
  raise exception '075: effective inherited/column write authority remains; hardening rolled back';
 end if;
 if pg_catalog.has_table_privilege('anon','public.b2b_supply_agreements','SELECT')
 or not pg_catalog.has_table_privilege('authenticated','public.b2b_supply_agreements','SELECT')
 or not pg_catalog.has_table_privilege('service_role','public.b2b_supply_agreements','SELECT') then
  raise exception '075: unexpected SELECT baseline; hardening rolled back';
 end if;
end;
$posture$;
commit;
