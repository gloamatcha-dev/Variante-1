-- Durable write fence for customer-initiated Stripe pause/resume requests.
-- An unresolved Stripe response keeps the fence until operator inspection.
create table public.subscription_pause_write_fences (
  subscription_id uuid primary key references public.subscriptions(id) on delete restrict,
  operation_id uuid not null unique,
  action text not null check (action in ('pause', 'resume')),
  created_at timestamptz not null default now()
);

alter table public.subscription_pause_write_fences enable row level security;
revoke all on table public.subscription_pause_write_fences from public, anon, authenticated, service_role;
grant select, insert, delete on table public.subscription_pause_write_fences to service_role;
