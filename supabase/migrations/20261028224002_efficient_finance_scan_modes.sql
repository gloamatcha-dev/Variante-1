-- Forward only. No financial DML, period changes, activation or historic imports.
begin;
alter table public.finance_sync_config add column scan_read_monthly_limit integer not null default 8000 check(scan_read_monthly_limit between 1 and 1000000);
create table public.finance_sync_audits (
 id uuid primary key default gen_random_uuid(), account_id text not null references public.finance_sync_config(account_id),
 cycle_day date not null, scope_from timestamptz not null, cutoff timestamptz not null,
 scan_from timestamptz not null, scan_to timestamptz not null,
 state text not null check(state in ('running','retry','completed')), lease_token uuid not null default gen_random_uuid(),lease_until timestamptz not null,
 checkpoint jsonb not null default '{}', verified boolean not null default false,completed_at timestamptz,last_error text,
 unique(account_id,cycle_day),check(scope_from<cutoff),check(scan_from<scan_to)
);
create unique index finance_one_pending_audit on public.finance_sync_audits(account_id) where state<>'completed';
create table public.finance_sync_audit_findings(audit_id uuid references public.finance_sync_audits(id),source_id text,code text,primary key(audit_id,source_id));
create table public.finance_sync_audit_seen(audit_id uuid references public.finance_sync_audits(id),source_key text,primary key(audit_id,source_key));
create table public.finance_sync_read_usage(id uuid primary key default gen_random_uuid(),account_id text references public.finance_sync_config(account_id),month date not null,reserved integer not null check(reserved between 0 and 80),actual integer check(actual between 0 and 80),scan_mode text,job_reads jsonb,created_at timestamptz not null default now());
create index finance_read_usage_window on public.finance_sync_read_usage(account_id,created_at);
create index finance_sources_balance_lookup on public.finance_sync_sources(account_id,(payload->>'balanceTransactionId'));
alter table public.finance_sync_audits enable row level security;
alter table public.finance_sync_audit_findings enable row level security;
alter table public.finance_sync_audit_seen enable row level security;
alter table public.finance_sync_read_usage enable row level security;
revoke all on public.finance_sync_audits,public.finance_sync_audit_findings,public.finance_sync_audit_seen,public.finance_sync_read_usage from public,anon,authenticated,service_role;

-- Keep the old writer/claim implementation, but put ALL execution claims behind
-- the same account lock and check both lease domains (including old manual calls).
alter function public.finance_sync_claim_v1(text) rename to finance_sync_claim_legacy_v1;
revoke all on function public.finance_sync_claim_legacy_v1(text) from public,anon,authenticated,service_role;
create function public.finance_sync_claim_v1(p_account text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0));
 if exists(select 1 from public.finance_sync_audits where account_id=p_account and state='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 return public.finance_sync_claim_legacy_v1(p_account);
end$$;

create function public.finance_sync_audit_claim_v2(p_account text,p_resume_only boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.finance_sync_config;j public.finance_sync_audits;t timestamptz:=date_trunc('second',clock_timestamp());
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0));
 select * into c from public.finance_sync_config where account_id=p_account and enabled;
 if not found or not exists(select 1 from public.admin_users where user_id=c.owner_id and role='owner' and is_active) then raise exception 'finance_sync_not_enabled';end if;
 if exists(select 1 from public.finance_sync_jobs where account_id=p_account and state='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 select * into j from public.finance_sync_audits where account_id=p_account and state<>'completed' for update;
 if found then
  if j.lease_until>clock_timestamp() then return jsonb_build_object('status','busy');end if;
  update public.finance_sync_audits set state='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes' where id=j.id returning * into j;
 else
  if p_resume_only then return jsonb_build_object('status','already_completed');end if;
  if exists(select 1 from public.finance_sync_audits where account_id=p_account and cycle_day=(t at time zone 'UTC')::date) then return jsonb_build_object('status','already_completed');end if;
  if c.scan_from>=t then raise exception 'invalid_scan_scope';end if;
  insert into public.finance_sync_audits(account_id,cycle_day,scope_from,cutoff,scan_from,scan_to,state,lease_until)
   values(p_account,(t at time zone 'UTC')::date,c.scan_from,t,c.scan_from,least(t,c.scan_from+interval '7 days'),'running',clock_timestamp()+interval '2 minutes') returning * into j;
 end if;
 return to_jsonb(j)||jsonb_build_object('status','claimed');
end$$;

create function public.finance_sync_audit_checkpoint_v2(p_job uuid,p_token uuid,p_checkpoint jsonb,p_state text default 'running',p_error text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_audits;
begin
 if p_checkpoint is null or jsonb_typeof(p_checkpoint)<>'object' or pg_column_size(p_checkpoint)>8000000 or p_state not in ('running','retry') then raise exception 'invalid_checkpoint';end if;
 update public.finance_sync_audits set checkpoint=p_checkpoint,state=p_state,last_error=p_error,
 lease_until=case when p_state='retry' then clock_timestamp() else clock_timestamp()+interval '2 minutes' end
 where id=p_job and lease_token=p_token and state='running' and lease_until>clock_timestamp() returning * into j;
 if not found then raise exception 'stale_finance_lease';end if;return to_jsonb(j);
end$$;

create function public.finance_sync_audit_issue_v2(p_job uuid,p_token uuid,p_source text,p_code text default null) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.finance_sync_audits where id=p_job and lease_token=p_token and state='running' and lease_until>clock_timestamp() for update;
 if not found then raise exception 'stale_finance_lease';end if;
 if p_code is null then delete from public.finance_sync_audit_findings where audit_id=p_job and source_id=p_source;
 else insert into public.finance_sync_audit_findings values(p_job,p_source,p_code) on conflict(audit_id,source_id) do update set code=excluded.code;end if;
end$$;

create function public.finance_sync_verify_receipt_v2(p_job uuid,p_token uuid,p_receipt jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_audits;s public.finance_sync_sources;k text;valid boolean;
begin
 select * into j from public.finance_sync_audits where id=p_job and lease_token=p_token and state='running' and lease_until>clock_timestamp() for update;
 if not found then raise exception 'stale_finance_lease';end if;
 if p_receipt->>'accountId' is distinct from j.account_id then raise exception 'account_mismatch';end if;
 k:=j.account_id||':live:'||(p_receipt->>'kind')||':'||(p_receipt->>'sourceId');
 select * into s from public.finance_sync_sources where account_id=j.account_id and source_key=k;
 valid:=found and s.state='recorded' and s.payload=(p_receipt-'verifiedRefundTotalCents'-'verifiedRefundCount')
  and ((s.event_id is not null and exists(select 1 from public.financial_events e where e.id=s.event_id and e.gross_cents=(p_receipt->>'amountCents')::integer and e.occurred_on=s.posting_on))
    or (s.expense_id is not null and exists(select 1 from public.business_expenses e where e.id=s.expense_id and e.gross_cents=(p_receipt->>'amountCents')::integer and e.occurred_on=s.posting_on)));
 if valid and p_receipt->>'kind'='payment' then
  valid:=exists(select 1 from public.provider_fee_evidence f where f.payment_intent_id=p_receipt->>'paymentIntentId' and f.balance_transaction_id=p_receipt->>'balanceTransactionId'
   and f.capture_status='checked' and f.fee_cents=(p_receipt->>'verifiedFeeCents')::integer and f.income_event_id=s.event_id);
 end if;
 if valid then insert into public.finance_sync_audit_seen values(p_job,k) on conflict do nothing;end if;
 perform public.finance_sync_audit_issue_v2(p_job,p_token,k,case when valid then null else 'provider_ledger_evidence_mismatch' end);
 return jsonb_build_object('result',case when valid then 'already_recorded' else 'review_required' end);
end$$;

create function public.finance_sync_audit_finish_v2(p_job uuid,p_token uuid,p_checkpoint jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.finance_sync_audits;v boolean;begin
 select * into j from public.finance_sync_audits where id=p_job and lease_token=p_token and state='running' and lease_until>clock_timestamp() for update;
 if not found then raise exception 'stale_finance_lease';end if;
 if jsonb_typeof(p_checkpoint->'paymentIds') is distinct from 'array' or jsonb_typeof(p_checkpoint->'usageIds') is distinct from 'array'
 or (p_checkpoint->>'paymentIndex')::integer is distinct from jsonb_array_length(p_checkpoint->'paymentIds')
 or coalesce((p_checkpoint->>'usageIndex')::integer,0) is distinct from jsonb_array_length(p_checkpoint->'usageIds')
 or not coalesce((select bool_and(coalesce((p_checkpoint#>>array['resources',k,'done'])::boolean,false)) from unnest(array['payment_intents','charges','refunds','balance_transactions','payouts']) k),false) then raise exception 'finance_checkpoint_incomplete';end if;
 if j.scan_to<j.cutoff then
  update public.finance_sync_audits set scan_from=scan_to,scan_to=least(cutoff,scan_to+interval '7 days'),checkpoint='{}',state='retry',lease_until=clock_timestamp() where id=j.id;
  return jsonb_build_object('state','continuation_required','caughtUp',false);
 end if;
 insert into public.finance_sync_audit_findings
 select j.id,s.source_key,'local_source_not_seen_in_provider' from public.finance_sync_sources s
 where s.account_id=j.account_id and (s.payload->>'occurredAt')::timestamptz>=j.scope_from and (s.payload->>'occurredAt')::timestamptz<j.cutoff
 and not exists(select 1 from public.finance_sync_audit_seen a where a.audit_id=j.id and a.source_key=s.source_key)
 on conflict do nothing;
 insert into public.finance_sync_audit_findings
 select j.id,'ledger:'||e.id::text,'stripe_ledger_source_bridge_missing' from public.financial_events e
 where e.kind in ('order_payment','annual_prepayment','refund','payment_fee') and e.occurred_on>=(j.scope_from at time zone 'Europe/Berlin')::date and e.occurred_on<=(j.cutoff at time zone 'Europe/Berlin')::date
 and (exists(select 1 from public.orders o left join public.checkout_attempts t on t.id=o.checkout_attempt_id where o.id=e.order_id and (o.stripe_payment_intent_id is not null or t.stripe_payment_intent_id is not null or t.stripe_invoice_id is not null))
 or exists(select 1 from public.annual_plans a where a.id=e.annual_plan_id and a.stripe_payment_intent_id is not null))
 and not exists(select 1 from public.finance_sync_sources s where s.account_id=j.account_id and s.event_id=e.id and s.state='recorded') on conflict do nothing;
 v:=not exists(select 1 from public.finance_sync_audit_findings where audit_id=j.id);
 update public.finance_sync_audits set checkpoint=p_checkpoint,state='completed',verified=v,completed_at=clock_timestamp(),lease_until=clock_timestamp() where id=j.id;
 return jsonb_build_object('state',case when j.cycle_day<>(clock_timestamp() at time zone 'UTC')::date then 'continuation_required' when v then 'verified' else 'attention' end,'caughtUp',j.cycle_day=(clock_timestamp() at time zone 'UTC')::date);
end$$;

-- Skip only final money with both principal and necessary processing-fee evidence.
create function public.finance_sync_balance_known_v2(p_account text,p_id text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare s public.finance_sync_sources;fee integer;begin
 select * into s from public.finance_sync_sources where account_id=p_account and payload->>'balanceTransactionId'=p_id and payload->>'kind' in ('payment','refund','usage_fee') and state='recorded' limit 1;
 if not found then return false;end if;
 if exists(select 1 from public.finance_sync_sources where account_id=p_account and payload->>'balanceTransactionId'=p_id and state<>'recorded') then return false;end if;
 if s.event_id is not null and not exists(select 1 from public.financial_events where id=s.event_id and gross_cents=(s.payload->>'amountCents')::integer and occurred_on=s.posting_on) then return false;end if;
 if s.expense_id is not null and not exists(select 1 from public.business_expenses where id=s.expense_id and gross_cents=(s.payload->>'amountCents')::integer and occurred_on=s.posting_on) then return false;end if;
 if s.payload->>'kind'='payment' then
  fee:=(s.payload->>'verifiedFeeCents')::integer;if fee is null then return false;end if;
  if not exists(select 1 from public.provider_fee_evidence where balance_transaction_id=p_id and income_event_id=s.event_id and capture_status='checked' and fee_cents=fee) then return false;end if;
  if fee>0 and not exists(select 1 from public.finance_sync_sources f join public.financial_events e on e.id=f.event_id where f.account_id=p_account and f.state='recorded' and f.payload->>'kind'='payment_fee' and f.payload->>'sourceId'=p_id and e.gross_cents=fee and e.occurred_on=f.posting_on) then return false;end if;
 end if;
 if s.payload->>'kind'='refund' and (public.finance_sync_source_read_v1(p_account,s.source_key)->>'parentVerified')::boolean is distinct from true then return false;end if;
 return true;
end$$;
create function public.finance_sync_known_balances_v2(p_account text,p_ids text[]) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(id),'[]') from unnest(p_ids) id where public.finance_sync_balance_known_v2(p_account,id);
$$;

create function public.finance_sync_read_reserve_v2(p_account text,p_requested integer default 80) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.finance_sync_config;used bigint;n integer;r public.finance_sync_read_usage;begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:reads:'||p_account,0));
 select * into c from public.finance_sync_config where account_id=p_account and enabled;
 if not found then raise exception 'finance_sync_not_enabled';end if;
 select coalesce(sum(coalesce(actual,reserved)),0) into used from public.finance_sync_read_usage where account_id=p_account and created_at>clock_timestamp()-interval '30 days';
 n:=greatest(0,least(80,p_requested,c.scan_read_monthly_limit-used));
 insert into public.finance_sync_read_usage(account_id,month,reserved) values(p_account,date_trunc('month',clock_timestamp() at time zone 'UTC')::date,n) returning * into r;
 return jsonb_build_object('id',r.id,'granted',n);
end$$;
create function public.finance_sync_read_measure_v2(p_id uuid,p_actual integer,p_mode text default 'incremental',p_jobs jsonb default '{}') returns void language plpgsql security definer set search_path='' as $$
begin
 if p_mode not in ('incremental','daily') or jsonb_typeof(p_jobs)<>'object' then raise exception 'read_measure_invalid';end if;
 update public.finance_sync_read_usage set actual=p_actual,scan_mode=p_mode,job_reads=p_jobs where id=p_id and actual is null and p_actual between 0 and reserved;
 if not found and not exists(select 1 from public.finance_sync_read_usage where id=p_id and actual=p_actual and scan_mode=p_mode and job_reads=p_jobs) then raise exception 'read_measure_conflict';end if;
end$$;

create function public.finance_sync_modes_alert_v2(p_account text,p_code text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.finance_sync_config where account_id=p_account and enabled) then raise exception 'finance_sync_not_enabled';end if;
 insert into public.finance_sync_alerts(account_id,code) values(p_account,p_code) on conflict do nothing;
end$$;
create function public.finance_sync_modes_status_v2() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',2,'incremental_last_scan',(select max(completed_at) from public.finance_sync_jobs where state='completed'),
 'daily_last_scan',(select max(completed_at) from public.finance_sync_audits where state='completed'),
 'daily_latest_verified',(select state='completed' and verified from public.finance_sync_audits order by cutoff desc limit 1),
 'daily_last_verified',(select max(completed_at) from public.finance_sync_audits where state='completed' and verified),
 'daily_cutoff',(select max(cutoff) from public.finance_sync_audits where state='completed' and verified),
 'daily_unresolved',(select count(*) from public.finance_sync_audit_findings where audit_id=(select id from public.finance_sync_audits order by cutoff desc limit 1)));
$$;
-- Every new definer is private except explicitly granted server entry points.
do $$declare r record;begin for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'finance_sync_%_v2' or p.proname='finance_sync_claim_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',r.sig);
 execute format('grant execute on function %s to service_role',r.sig);
end loop;end$$;
commit;
