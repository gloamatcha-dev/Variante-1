-- READ ONLY. Exact signatures/security; only 037/038 bodies use reviewed lexical fingerprints.
-- Comments/insignificant whitespace ignored; literal bytes, tokens and statement order preserved.
with expected(signature,body_md5,return_type) as (values
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
), cols(tbl,col,typ) as (values
 ('withdrawal_requests','refund_amount_cents','integer'),('withdrawal_requests','refund_operation_id','uuid'),
 ('withdrawal_requests','confirmed_value_loss_cents','integer'),('withdrawal_requests','return_received_at','timestamp with time zone'),
 ('withdrawal_requests','deliveries_permanently_stopped_at','timestamp with time zone'),('withdrawal_requests','resolved_order_item_id','uuid'),
 ('withdrawal_requests','partial_shipping_treatment','text'),('orders','refunded_total_cents','integer'),
 ('orders','checkout_attempt_id','uuid'),('annual_plans','refunded_total_cents','integer'),
 ('annual_plans','payment_checkout_attempt_id','uuid'),('annual_plan_deliveries','fulfilled_at','timestamp with time zone'),
 ('checkout_attempts','stripe_invoice_id','text'),('checkout_attempts','stripe_payment_intent_id','text'),
 ('checkout_attempts','subscription_id','uuid'),('subscriptions','cancelled_at','timestamp with time zone'),
 ('subscriptions','stripe_subscription_id','text'),('stripe_customers','stripe_customer_id','text')
), checks(ord,name,ok,detail) as (
 select 1,'076 installed',pg_catalog.to_regprocedure('public.record_b2b_monthly_invoice_event(uuid,text)') is not null,'076 dependency, never reapplied'
 union all select 2,'070/072 signatures, normalized bodies, security and ACL',not exists(select 1 from expected e where not exists(
  select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(e.signature) and p.prosecdef
  and 'search_path=""'=any(p.proconfig) and pg_catalog.format_type(p.prorettype,null)=e.return_type
  and (case when e.signature in ('public.apply_order_refund_state(text,integer,boolean)','public.apply_order_refund_state_by_invoice(text,integer,boolean)') then (
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
) else pg_catalog.md5(pg_catalog.replace(p.prosrc,pg_catalog.chr(13),'')) end)=e.body_md5
  and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
  and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE') and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'))), 'Exact signatures; no pg_get_functiondef fingerprint'
 union all select 3,'Required authoritative columns',not exists(select 1 from cols c where not exists(select 1 from pg_catalog.pg_attribute a
  where a.attrelid=pg_catalog.to_regclass('public.'||c.tbl) and a.attname=c.col and not a.attisdropped
  and pg_catalog.format_type(a.atttypid,a.atttypmod)=c.typ)), 'Stored payment/refund/fulfilment/provider evidence'
 union all select 4,'No partial 077 columns',not exists(select 1 from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass('public.withdrawal_requests')
  and attname in ('goods_status','return_status','return_reference','value_loss_reason') and not attisdropped),'All four additions must be absent'
 union all select 5,'No conflicting 077 RPC',not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
  ('withdrawal_refund_review_basis_v1','withdrawal_refund_lock_v1','admin_review_withdrawal_v1','admin_approve_withdrawal_refund_v1','admin_validate_withdrawal_payout_v1','admin_record_withdrawal_subscription_stop_v1','admin_record_withdrawal_return_v1')),'Reject partially installed state'
 union all select 6,'Declaration RLS and browser denial',exists(select 1 from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.withdrawal_requests') and relrowsecurity)
  and not exists(select 1 from (values('anon'),('authenticated')) r(role) where pg_catalog.has_table_privilege(r.role,'public.withdrawal_requests','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   or pg_catalog.has_any_column_privilege(r.role,'public.withdrawal_requests','INSERT,UPDATE')),'No browser declaration/table authority'
 union all select 7,'Refund execution and value decision constraints',exists(select 1 from pg_catalog.pg_constraint where conrelid=pg_catalog.to_regclass('public.withdrawal_requests') and conname='withdrawal_requests_refund_execution_shape_check' and convalidated)
  and exists(select 1 from pg_catalog.pg_constraint where conrelid=pg_catalog.to_regclass('public.withdrawal_requests') and conname='withdrawal_requests_value_loss_decision_shape_check' and convalidated)
  and exists(select 1 from pg_catalog.pg_index where indexrelid=pg_catalog.to_regclass('public.withdrawal_requests_refund_operation_key') and indisunique and indisvalid),'Existing durable evidence/idempotency preserved'
 union all select 8,'Protected history browser writes denied',not exists(select 1 from (values('financial_events'),('creator_commissions'),('admin_activity_log'),('inventory_items'),('inventory_movements')) t(tbl)
  cross join (values('anon'),('authenticated')) r(role) where pg_catalog.has_table_privilege(r.role,'public.'||t.tbl,'INSERT,UPDATE,DELETE,TRUNCATE') or pg_catalog.has_any_column_privilege(r.role,'public.'||t.tbl,'INSERT,UPDATE')),'No Finance/Inventory/Affiliate browser writes'
 union all select 9,'Applying role can extend schema',pg_catalog.has_schema_privilege(current_user,'public','CREATE') and (select pg_catalog.pg_has_role(current_user,relowner,'USAGE') from pg_catalog.pg_class where oid=pg_catalog.to_regclass('public.withdrawal_requests')),'Function creation and table ownership required'
), result as (select ord,name,case when ok then 'PASS' else 'FAIL' end status,detail from checks)
select status,name,detail from result
union all select case when count(*) filter(where status='FAIL')=0 then 'PASS' else 'FAIL' end,'SUMMARY',
 count(*) filter(where status='FAIL')||' FAIL / '||count(*) filter(where status='PASS')||' PASS / 0 INFO — '||
 case when count(*) filter(where status='FAIL')=0 then 'SAFE TO APPLY' else 'DO NOT APPLY' end from result;
