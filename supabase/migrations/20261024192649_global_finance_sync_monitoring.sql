-- REVIEW ONLY. Apply separately after approved 084/085 release gates.
-- Monitoring metadata only; no historical approvals or ledger changes.
begin;
alter table public.finance_sync_jobs
 add column last_attempt_at timestamptz,
 add column last_failure_at timestamptz,
 add column last_failure_code text;

create function public.finance_sync_monitor_job_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='INSERT' or new.lease_token is distinct from old.lease_token then
  new.last_attempt_at:=clock_timestamp();
 else new.last_attempt_at:=old.last_attempt_at;
 end if;
 if new.last_error is not null and (TG_OP='INSERT' or new.last_error is distinct from old.last_error or new.state='retry') then
  new.last_failure_at:=clock_timestamp();new.last_failure_code:=new.last_error;
 elsif TG_OP='UPDATE' then
  new.last_failure_at:=old.last_failure_at;new.last_failure_code:=old.last_failure_code;
 end if;
 return new;
end$$;
revoke all on function public.finance_sync_monitor_job_v1() from public,anon,authenticated,service_role;
create trigger finance_sync_monitor_job before insert or update on public.finance_sync_jobs
for each row execute function public.finance_sync_monitor_job_v1();

create function public.finance_sync_global_status_v1() returns jsonb
language sql stable security definer set search_path='' as $$
 select public.finance_sync_status_v1() || jsonb_build_object(
  'monitoring_version',1,
  'last_attempt_at',(select max(last_attempt_at) from public.finance_sync_jobs),
  'last_failure_at',(select max(last_failure_at) from public.finance_sync_jobs),
  'last_failure_code',(select last_failure_code from public.finance_sync_jobs where last_failure_at is not null order by last_failure_at desc limit 1),
  'progress',(select jsonb_build_object('payments_processed',checkpoint->'paymentIndex','fees_processed',checkpoint->'usageIndex','attempts',attempts)
   from public.finance_sync_jobs where state<>'completed' order by last_attempt_at desc limit 1));
$$;
revoke all on function public.finance_sync_global_status_v1() from public,anon,authenticated;
grant execute on function public.finance_sync_global_status_v1() to service_role;
commit;
