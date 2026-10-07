-- READ ONLY. Canonical reviewed bodies, exact signatures, ACL and installed authority.
with expected(signature,body_md5,return_type,service_execute) as (values
 ('public.withdrawal_refund_review_basis_v1(uuid)','0f9dc0da65c67f0416b690ef45e6630f','jsonb',true),
 ('public.withdrawal_refund_lock_v1(uuid)','63e4e2d093de585e09cf52406fedfce1','void',false),
 ('public.admin_review_withdrawal_v1(uuid,uuid,text,text,text,integer,text,text)','83ded52b8cadfc89134b4c6e12e3d3ff','jsonb',true),
 ('public.admin_approve_withdrawal_refund_v1(uuid,uuid,integer)','5be02ab2b6fe5052ae57a4e2c9f94091','jsonb',true),
 ('public.admin_validate_withdrawal_payout_v1(uuid)','67b1dc9bd213fb6e99264ff20787067b','jsonb',true),
 ('public.admin_record_withdrawal_subscription_stop_v1(uuid,uuid,boolean,timestamptz,text)','b8a3df11ca0e75c3d143e546bc5acd90','jsonb',true),
 ('public.admin_record_withdrawal_return_v1(uuid,uuid,text,timestamptz)','06808c6392a0dc5c75c0b71401738ac0','jsonb',true)
), legacy(signature,body_md5,return_type) as (values
 ('public.admin_approve_withdrawal_refund(uuid,uuid)','4edc631fbc09e86487811aff7e588d6a','jsonb'),
 ('public.admin_confirm_withdrawal_value_loss(uuid,uuid,integer)','0eb48608568b647b2b61693e22359e7a','jsonb'),
 ('public.admin_record_withdrawal_refund_execution(uuid,uuid,text,integer)','178aa1d03b163d298b9028de67cd0b64','jsonb'),
 ('public.admin_record_withdrawal_refund_failure(uuid,uuid,text)','a4be7fb628042dbc35fb0d644b1f61a3','jsonb'),
 ('public.admin_record_withdrawal_return(uuid,uuid,text,timestamp with time zone)','cc7552ae30bb2d5d3079c6eed8a37e7d','jsonb'),
 ('public.admin_set_withdrawal_seal_state(uuid,uuid,text)','36b857d02cdc693cc2fcccd8c7aaf218','jsonb'),
 ('public.annual_plan_delivery_freeze_active(uuid)','345fc02e30b392b2085f20704d4876b8','boolean'),
 ('public.apply_annual_plan_refund_state(text,integer)','fdd712af1568f008a4fea3cf63464a9b','text'),
 ('public.apply_order_refund_state(text,integer,boolean)','23a2650dab1143ff868fde36a1086812','text'),
 ('public.apply_order_refund_state_by_invoice(text,integer,boolean)','371e09e3734c5864bf5c427695784aff','text'),
 ('public.claim_withdrawal_refund_completed_email(uuid)','f9238ff8065ef1ed2cc38cbe6bd47daf','jsonb'),
 ('public.freeze_annual_deliveries_for_withdrawal(uuid)','ddf5ed93c2791c03d53d1a5968d86e9a','jsonb'),
 ('public.mark_subscription_cancelled(text,timestamp with time zone)','83e17985eb02d490f75715e2ec223969','jsonb'),
 ('public.record_admin_activity(uuid,text,text,text,text,text,uuid,jsonb)','6429d913d27802ab73b2af2b3d741122','uuid'),
 ('public.record_annual_plan_refund_event(uuid,integer,text,uuid)','40a470a5eb0456ce818e72ccfca5048c','jsonb'),
 ('public.record_order_refund_event(uuid,integer,text,uuid)','2fa675cb4040ece30066d7a3c4f99844','jsonb'),
 ('public.reverse_creator_commission_for_refund(uuid,integer,uuid)','1d85392c04a4e793b0f94f25689ab117','jsonb')
), checks(name,ok) as (
 select '077 exact signatures, normalized bodies and security',not exists(select 1 from expected e where not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(e.signature) and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)=e.return_type and (
 -- BEGIN 077 TOKEN FINGERPRINT V1
with recursive lex(pos,mode,depth,clean) as (
  select 1,'code'::text collate pg_catalog."C",0,''::text collate pg_catalog."C"
  union all
  select pos+case
    when mode='code' and pair in ('--','/*') then 2
    when mode='single' and pair=$q$''$q$ then 2
    when mode='double' and pair='""' then 2
    when mode='block' and pair in ('/*','*/') then 2 else 1 end,
   case
    when mode='code' and pair='--' then 'line'
    when mode='code' and pair='/*' then 'block'
    when mode='code' and c=$q$'$q$ then 'single'
    when mode='code' and c='"' then 'double'
    when mode='single' and c=$q$'$q$ and pair<>$q$''$q$ then 'code'
    when mode='double' and c='"' and pair<>'""' then 'code'
    when mode='line' and c in (pg_catalog.chr(10),pg_catalog.chr(13)) then 'code'
    when mode='block' and pair='*/' and depth=1 then 'code' else mode end,
   case when mode='code' and pair='/*' then 1
    when mode='block' and pair='/*' then depth+1
    when mode='block' and pair='*/' then depth-1 else depth end,
   clean||case
    when mode='code' and pair in ('--','/*') then ' '
    when mode in ('line','block') then ''
    when mode='single' and pair=$q$''$q$ then pair
    when mode='double' and pair='""' then pair else c end
  from lex cross join lateral (select pg_catalog.substr(p.prosrc,pos,1) c,pg_catalog.substr(p.prosrc,pos,2) pair) ch
  where pos<=pg_catalog.length(p.prosrc)
 ), cleaned as(select clean from lex where pos>pg_catalog.length(p.prosrc) and mode in ('code','line') and depth=0),
 tokens as(select m[1] token,ord from cleaned cross join lateral pg_catalog.regexp_matches(clean,
  $tokens$'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|->>|->|::|:=|<>|>=|<=|!=|\|\||\s+|.$tokens$,'g') with ordinality r(m,ord))
 select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.octet_length(token)::text||':'||token,'' order by ord))
 from tokens where token !~ $space$^\s+$$space$
 -- END 077 TOKEN FINGERPRINT V1
)=e.body_md5 and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')=e.service_execute and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE') and not exists(select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')))
 union all select '070/072 protected function bodies unchanged',not exists(select 1 from legacy e where not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(e.signature) and (case when e.signature in ('public.apply_order_refund_state(text,integer,boolean)','public.apply_order_refund_state_by_invoice(text,integer,boolean)') then (
 -- BEGIN REFUND TOKEN FINGERPRINT V1
 with recursive lex(pos,mode,depth,clean) as (
  select 1,'code'::text collate pg_catalog."C",0,''::text collate pg_catalog."C"
  union all
  select pos+case
    when mode='code' and pair in ('--','/*') then 2
    when mode='single' and pair=$q$''$q$ then 2
    when mode='double' and pair='""' then 2
    when mode='block' and pair in ('/*','*/') then 2 else 1 end,
   case
    when mode='code' and pair='--' then 'line'
    when mode='code' and pair='/*' then 'block'
    when mode='code' and c=$q$'$q$ then 'single'
    when mode='code' and c='"' then 'double'
    when mode='single' and c=$q$'$q$ and pair<>$q$''$q$ then 'code'
    when mode='double' and c='"' and pair<>'""' then 'code'
    when mode='line' and c in (pg_catalog.chr(10),pg_catalog.chr(13)) then 'code'
    when mode='block' and pair='*/' and depth=1 then 'code' else mode end,
   case when mode='code' and pair='/*' then 1
    when mode='block' and pair='/*' then depth+1
    when mode='block' and pair='*/' then depth-1 else depth end,
   clean||case
    when mode='code' and pair in ('--','/*') then ' '
    when mode in ('line','block') then ''
    when mode='single' and pair=$q$''$q$ then pair
    when mode='double' and pair='""' then pair else c end
  from lex cross join lateral (select pg_catalog.substr(p.prosrc,pos,1) c,pg_catalog.substr(p.prosrc,pos,2) pair) ch
  where pos<=pg_catalog.length(p.prosrc)
 ), cleaned as(select clean from lex where pos>pg_catalog.length(p.prosrc) and mode in ('code','line') and depth=0),
 tokens as(select m[1] token,ord from cleaned cross join lateral pg_catalog.regexp_matches(clean,
  $tokens$'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9$]*|[0-9]+(?:\.[0-9]+)?|:=|<>|>=|<=|!=|\|\||\s+|.$tokens$,'g') with ordinality r(m,ord))
 select pg_catalog.md5(pg_catalog.string_agg(pg_catalog.octet_length(token)::text||':'||token,'' order by ord))
 from tokens where token !~ $space$^\s+$$space$
 -- END REFUND TOKEN FINGERPRINT V1
) else pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13),'')) end)=e.body_md5 and pg_catalog.format_type(p.prorettype,null)=e.return_type and p.prosecdef and 'search_path=""'=any(p.proconfig) and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')=(e.signature<>'public.admin_approve_withdrawal_refund(uuid,uuid)') and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')))
 union all select '077 no unexpected overloads',(select count(*)=7 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('withdrawal_refund_review_basis_v1','withdrawal_refund_lock_v1','admin_review_withdrawal_v1','admin_approve_withdrawal_refund_v1','admin_validate_withdrawal_payout_v1','admin_record_withdrawal_subscription_stop_v1','admin_record_withdrawal_return_v1'))
 union all select 'Legacy approval bypass retired',not pg_catalog.has_function_privilege('service_role','public.admin_approve_withdrawal_refund(uuid,uuid)','EXECUTE')
 union all select 'Four nullable factual fields installed', (select count(*)=4 and bool_and(not attnotnull and atttypid='text'::regtype) from pg_catalog.pg_attribute where attrelid='public.withdrawal_requests'::regclass and attname in ('goods_status','return_status','return_reference','value_loss_reason') and not attisdropped)
 union all select 'Validated goods, return and length constraints',(select count(*)=4 and bool_and(convalidated) from pg_catalog.pg_constraint where conrelid='public.withdrawal_requests'::regclass and conname in ('withdrawal_goods_status_check','withdrawal_return_status_check','withdrawal_return_reference_check','withdrawal_value_loss_reason_check'))
 union all select 'Withdrawal RLS preserved',(select relrowsecurity from pg_catalog.pg_class where oid='public.withdrawal_requests'::regclass) and not exists(select 1 from (values('anon'),('authenticated')) r(role) where pg_catalog.has_table_privilege(r.role,'public.withdrawal_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') or pg_catalog.has_any_column_privilege(r.role,'public.withdrawal_requests','INSERT,UPDATE'))
 union all select 'Finance, Affiliate and Inventory browser writes denied',not exists(select 1 from (values('financial_events'),('creator_commissions'),('admin_activity_log'),('inventory_items'),('inventory_movements')) t(tbl) cross join (values('anon'),('authenticated')) r(role) where pg_catalog.has_table_privilege(r.role,'public.'||t.tbl,'INSERT,UPDATE,DELETE,TRUNCATE') or pg_catalog.has_any_column_privilege(r.role,'public.'||t.tbl,'INSERT,UPDATE'))
 union all select 'No Inventory trigger introduced',not exists(select 1 from pg_catalog.pg_trigger where tgrelid in ('public.inventory_items'::regclass,'public.inventory_movements'::regclass) and not tgisinternal and tgname like '%withdrawal%')
), result as(select name,case when ok then 'PASS' else 'FAIL' end status from checks)
select status,name from result union all select case when count(*) filter(where status='FAIL')=0 then 'PASS' else 'FAIL' end,count(*) filter(where status='FAIL')||' FAIL / '||count(*) filter(where status='PASS')||' PASS / 0 INFO ? '||case when count(*) filter(where status='FAIL')=0 then 'APPLIED CLEANLY' else 'DO NOT ACCEPT' end from result;
