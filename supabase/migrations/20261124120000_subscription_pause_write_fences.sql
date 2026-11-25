-- Durable write fence for customer-initiated Stripe pause/resume requests.
-- An unresolved Stripe response keeps the fence until operator inspection.
create table public.subscription_pause_write_fences (
  subscription_id uuid primary key references public.subscriptions(id) on delete restrict,
  operation_id uuid not null unique,
  action text not null check (action in ('pause', 'resume')),
  created_at timestamptz not null default now(),
  resume_invoice_id text unique,
  resume_schedule_id text,
  check ((resume_invoice_id is null and resume_schedule_id is null) or
    (action='resume' and resume_invoice_id is not null and resume_schedule_id is not null))
);

alter table public.subscription_pause_write_fences enable row level security;
revoke all on table public.subscription_pause_write_fences from public, anon, authenticated, service_role;
grant select, insert, delete on table public.subscription_pause_write_fences to service_role;
grant update (resume_invoice_id,resume_schedule_id) on table public.subscription_pause_write_fences to service_role;
create trigger sandbox_pause_fence_release_required before insert or update on public.subscription_pause_write_fences
  for each row execute function public.guard_release_table_write_v1('sandbox_pause_release_writes_enabled');
