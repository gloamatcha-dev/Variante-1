BEGIN;
-- Installed blocked. Arming is a separately approved privileged SQL operation.
create table public.finance_first_scan_authorization (
 account_id text primary key check(account_id='acct_1U6B3ODI76FH9qsq'),
 job_id uuid not null check(job_id='25ccfe4a-9b70-488f-844b-ac91bbf11ba4'),
 scan_from timestamptz not null check(scan_from='2026-08-31T22:00:00Z'),
 scan_to timestamptz not null check(scan_to='2026-09-07T22:00:00Z'),
 expires_at timestamptz, max_reads integer not null default 20 check(max_reads between 1 and 20),
 consumed_at timestamptz, revoked_at timestamptz, lease_token uuid, reservation_id uuid,
 read_attempts integer not null default 0 check(read_attempts between 0 and 20),
 findings jsonb not null default '{}' check(jsonb_typeof(findings)='object' and pg_column_size(findings)<=1000000),
 check((consumed_at is null and lease_token is null and reservation_id is null and read_attempts=0)
    or(consumed_at is not null and expires_at is not null and lease_token is not null and reservation_id is not null))
);
alter table public.finance_first_scan_authorization enable row level security;
revoke all on public.finance_first_scan_authorization from public,anon,authenticated,service_role;
insert into public.finance_first_scan_authorization(account_id,job_id,scan_from,scan_to)
 values('acct_1U6B3ODI76FH9qsq','25ccfe4a-9b70-488f-844b-ac91bbf11ba4','2026-08-31T22:00:00Z','2026-09-07T22:00:00Z');
create function public.finance_first_scan_seal_v3() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='DELETE' then raise exception 'first_scan_guard_permanent';end if;
 if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then raise exception 'first_scan_revocation_permanent';end if;
 if old.consumed_at is not null and (new.account_id,new.job_id,new.scan_from,new.scan_to,new.expires_at,new.max_reads,new.consumed_at,new.lease_token,new.reservation_id)
 is distinct from (old.account_id,old.job_id,old.scan_from,old.scan_to,old.expires_at,old.max_reads,old.consumed_at,old.lease_token,old.reservation_id)
 then raise exception 'first_scan_already_consumed';end if;
 if new.read_attempts<old.read_attempts then raise exception 'first_scan_counter_rewind';end if;
 return new;
end$$;
create trigger finance_first_scan_seal before update or delete on public.finance_first_scan_authorization for each row execute function public.finance_first_scan_seal_v3();
create function public.finance_first_scan_isolated_v3() returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.finance_first_scan_authorization);
$$;

-- Existing claims/writers remain unchanged behind private wrappers. Isolation
-- survives scope removal, expiry and accidentally enabled app/database flags.
alter function public.finance_sync_claim_v1(text) rename to finance_sync_claim_before_first_v3;
create function public.finance_sync_claim_v1(p_account text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0));
 if exists(select 1 from public.finance_first_scan_authorization where account_id=p_account) then raise exception 'first_scan_isolated';end if;
 return public.finance_sync_claim_before_first_v3(p_account);
end$$;
alter function public.finance_sync_audit_claim_v2(text,boolean) rename to finance_sync_audit_claim_before_first_v3;
create function public.finance_sync_audit_claim_v2(p_account text,p_resume_only boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0));
 if exists(select 1 from public.finance_first_scan_authorization where account_id=p_account) then raise exception 'first_scan_isolated';end if;
 return public.finance_sync_audit_claim_before_first_v3(p_account,p_resume_only);
end$$;
alter function public.finance_sync_stage_v1(uuid,uuid,jsonb) rename to finance_sync_stage_before_first_v3;
create function public.finance_sync_stage_v1(p_job uuid,p_token uuid,p_receipt jsonb) returns text language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.finance_sync_jobs j join public.finance_first_scan_authorization a on a.account_id=j.account_id where j.id=p_job) then raise exception 'first_scan_money_forbidden';end if;
 return public.finance_sync_stage_before_first_v3(p_job,p_token,p_receipt);
end$$;
alter function public.finance_sync_record_v1(uuid,uuid,text) rename to finance_sync_record_before_first_v3;
create function public.finance_sync_record_v1(p_job uuid,p_token uuid,p_key text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.finance_sync_jobs j join public.finance_first_scan_authorization a on a.account_id=j.account_id where j.id=p_job) then raise exception 'first_scan_money_forbidden';end if;
 return public.finance_sync_record_before_first_v3(p_job,p_token,p_key);
end$$;
alter function public.finance_sync_failure_v1(uuid,uuid,text) rename to finance_sync_failure_before_first_v3;
create function public.finance_sync_failure_v1(p_job uuid,p_token uuid,p_key text) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.finance_sync_jobs j join public.finance_first_scan_authorization a on a.account_id=j.account_id where j.id=p_job) then raise exception 'first_scan_money_forbidden';end if;
 perform public.finance_sync_failure_before_first_v3(p_job,p_token,p_key);
end$$;

create function public.finance_first_scan_consume_v3(p_account text,p_job uuid,p_from timestamptz,p_to timestamptz,p_max integer,p_expiry timestamptz)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.finance_first_scan_authorization;c public.finance_sync_config;j public.finance_sync_jobs;used bigint;r uuid;
begin
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('finance:sync:account:'||p_account,0)) then raise exception 'first_scan_busy';end if;
 select * into a from public.finance_first_scan_authorization where account_id=p_account for update nowait;
 if not found or a.revoked_at is not null or a.consumed_at is not null or a.expires_at is null or clock_timestamp()>=a.expires_at or a.expires_at>clock_timestamp()+interval '1 hour'
 or (p_job,p_from,p_to,p_max,p_expiry) is distinct from (a.job_id,a.scan_from,a.scan_to,a.max_reads,a.expires_at) then raise exception 'first_scan_authorization_denied';end if;
 select * into c from public.finance_sync_config where account_id=p_account for update nowait;
 if not found or c.enabled or c.auto_open_current_period or c.owner_id<>'75f838b9-f393-4e52-b8b0-70c118df8ed1' or c.known_payment_intent<>'pi_3UNcyODI76FH9qsq15ToRfXY'
 or not exists(select 1 from public.admin_users where user_id=c.owner_id and role='owner' and is_active) then raise exception 'first_scan_config_denied';end if;
 if exists(select 1 from public.finance_sync_jobs where account_id=p_account and lease_until>clock_timestamp() and state='running')
 or exists(select 1 from public.finance_sync_audits where account_id=p_account and lease_until>clock_timestamp() and state='running') then raise exception 'first_scan_busy';end if;
 select * into j from public.finance_sync_jobs where id=p_job for update nowait;
 if not found or j.lease_until>clock_timestamp() or (j.account_id,j.scan_from,j.scan_to,j.state,j.attempts,j.checkpoint) is distinct from (p_account,p_from,p_to,'retry'::text,1,'{}'::jsonb) then raise exception 'first_scan_job_changed';end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('finance:reads:'||p_account,0)) then raise exception 'first_scan_busy';end if;
 if clock_timestamp()>=a.expires_at then raise exception 'first_scan_authorization_expired';end if;
 select coalesce(sum(coalesce(actual,reserved)),0) into used from public.finance_sync_read_usage where account_id=p_account and created_at>clock_timestamp()-interval '30 days';
 if c.scan_read_monthly_limit-used<p_max then raise exception 'first_scan_local_budget_denied';end if;
 insert into public.finance_sync_read_usage(account_id,month,reserved) values(p_account,date_trunc('month',clock_timestamp() at time zone 'UTC')::date,p_max) returning id into r;
 update public.finance_sync_jobs set state='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1 where id=p_job returning * into j;
 update public.finance_first_scan_authorization set consumed_at=clock_timestamp(),lease_token=j.lease_token,reservation_id=r where account_id=p_account;
 return jsonb_build_object('job',to_jsonb(j)||jsonb_build_object('status','claimed'),'reservation',jsonb_build_object('id',r,'granted',p_max),
 'config',jsonb_build_object('account_id',c.account_id,'known_payment_intent',c.known_payment_intent,'known_amount_cents',c.known_amount_cents));
end$$;
create function public.finance_first_scan_read_v3(p_job uuid,p_token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.finance_first_scan_authorization;j public.finance_sync_jobs;
begin
 select * into a from public.finance_first_scan_authorization where job_id=p_job for update nowait;
 if not found or a.revoked_at is not null or a.consumed_at is null or a.lease_token is distinct from p_token or a.expires_at<=clock_timestamp() or a.read_attempts>=a.max_reads then raise exception 'first_scan_read_denied';end if;
 select * into j from public.finance_sync_jobs where id=p_job;
 if j.lease_token is distinct from p_token or j.state<>'running' or j.lease_until<=clock_timestamp()
 or not exists(select 1 from public.finance_sync_config c join public.admin_users u on u.user_id=c.owner_id and u.role='owner' and u.is_active where c.account_id=a.account_id and not c.enabled and not c.auto_open_current_period)
 then raise exception 'first_scan_read_denied';end if;
 update public.finance_first_scan_authorization set read_attempts=read_attempts+1 where account_id=a.account_id;
 return jsonb_build_object('remainingMs',greatest(0,floor(extract(epoch from(a.expires_at-clock_timestamp()))*1000)));
end$$;
create function public.finance_first_scan_issue_v3(p_job uuid,p_token uuid,p_source text,p_code text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.finance_first_scan_authorization a join public.finance_sync_jobs j on j.id=a.job_id
 where a.job_id=p_job and a.consumed_at is not null and a.lease_token=p_token and j.lease_token=p_token and j.state='running' and j.lease_until>clock_timestamp()) then raise exception 'stale_first_scan_lease';end if;
 if p_code is null then return;end if;
 if p_source is null or length(p_source)>240 or p_code!~'^[a-z0-9_:]{1,160}$' then raise exception 'invalid_first_scan_finding';end if;
 update public.finance_first_scan_authorization set findings=jsonb_set(findings,array[p_source],jsonb_build_object('code',p_code,'at',clock_timestamp())) where job_id=p_job;
end$$;

-- Explicit allowlist. Private originals and table never exposed to service role.
revoke all on function public.finance_sync_claim_before_first_v3(text),public.finance_sync_audit_claim_before_first_v3(text,boolean),public.finance_sync_stage_before_first_v3(uuid,uuid,jsonb),public.finance_sync_record_before_first_v3(uuid,uuid,text),public.finance_sync_failure_before_first_v3(uuid,uuid,text),public.finance_first_scan_seal_v3() from public,anon,authenticated,service_role;
revoke all on function public.finance_first_scan_isolated_v3(),public.finance_first_scan_consume_v3(text,uuid,timestamptz,timestamptz,integer,timestamptz),public.finance_first_scan_read_v3(uuid,uuid),public.finance_sync_claim_v1(text),public.finance_sync_audit_claim_v2(text,boolean),public.finance_sync_stage_v1(uuid,uuid,jsonb),public.finance_sync_record_v1(uuid,uuid,text),public.finance_sync_failure_v1(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.finance_first_scan_isolated_v3(),public.finance_first_scan_consume_v3(text,uuid,timestamptz,timestamptz,integer,timestamptz),public.finance_first_scan_read_v3(uuid,uuid),public.finance_sync_claim_v1(text),public.finance_sync_audit_claim_v2(text,boolean),public.finance_sync_stage_v1(uuid,uuid,jsonb),public.finance_sync_record_v1(uuid,uuid,text),public.finance_sync_failure_v1(uuid,uuid,text) to service_role;
revoke all on function public.finance_first_scan_issue_v3(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.finance_first_scan_issue_v3(uuid,uuid,text,text) to service_role;
COMMIT;
