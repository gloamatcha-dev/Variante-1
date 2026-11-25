begin;
create table public.subscription_pause_windows (
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  schedule_id text primary key,
  pause_at timestamptz not null,
  resumed_at timestamptz,
  check (resumed_at > pause_at)
);
alter table public.subscription_pause_windows enable row level security;
revoke all on table public.subscription_pause_windows from public, anon, authenticated, service_role;
grant select, insert on table public.subscription_pause_windows to service_role;
create trigger sandbox_pause_window_release_required before insert or update on public.subscription_pause_windows
  for each row execute function public.guard_release_table_write_v1('sandbox_pause_release_writes_enabled');

create table public.sandbox_subscription_paid_cycles (
  subscription_id uuid not null references public.subscriptions(id) on delete restrict,
  period_start timestamptz not null,
  stripe_invoice_id text not null unique,
  primary key (subscription_id, period_start)
);
alter table public.sandbox_subscription_paid_cycles enable row level security;
revoke all on table public.sandbox_subscription_paid_cycles from public, anon, authenticated, service_role;

-- Serialize the reservation of a Stripe mutation with the guarded invoice claim.
create function public.lock_subscription_for_pause_fence() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.subscriptions where id = new.subscription_id for update;
  return new;
end;
$$;
revoke all on function public.lock_subscription_for_pause_fence() from public, anon, authenticated;
create trigger lock_subscription_for_pause_fence
before insert on public.subscription_pause_write_fences
for each row execute function public.lock_subscription_for_pause_fence();

create function public.activate_sandbox_subscription_cycle(
  p_subscription_id uuid, p_stripe_subscription_id text, p_stripe_invoice_id text,
  p_current_period_start timestamptz, p_current_period_end timestamptz,
  p_next_delivery_at timestamptz, p_paid_start timestamptz, p_paid_end timestamptz,
  p_schedule_id text, p_resumed_at timestamptz
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_attempt uuid;
  v_fence public.subscription_pause_write_fences;
begin
  perform public.require_release_writes_v1('sandbox_pause_release_writes_enabled');
  perform 1 from public.subscriptions where id = p_subscription_id for update;
  if not found then raise exception 'subscription not found'; end if;

  select id into v_attempt from public.checkout_attempts
  where subscription_id = p_subscription_id and stripe_invoice_id = p_stripe_invoice_id;
  if found then return v_attempt; end if;

  if p_paid_start is null or p_paid_end is null or p_paid_end <= p_paid_start then
    raise exception 'subscription invoice period unconfirmed';
  end if;

  select * into v_fence from public.subscription_pause_write_fences
    where subscription_id = p_subscription_id for update;
  if found then
    if v_fence.action <> 'resume' or v_fence.resume_invoice_id is null
      or v_fence.resume_invoice_id is distinct from p_stripe_invoice_id
      or p_schedule_id is not null or p_resumed_at is null
      or p_resumed_at is distinct from p_paid_start
      or p_paid_start is distinct from p_current_period_start
      or p_paid_end is distinct from p_current_period_end then
      raise exception 'subscription pause operation unresolved';
    end if;
    update public.subscription_pause_windows set resumed_at = p_resumed_at
      where subscription_id = p_subscription_id and schedule_id = v_fence.resume_schedule_id
        and resumed_at is null and p_resumed_at > pause_at;
    if not found then raise exception 'direct resume window unconfirmed'; end if;
    delete from public.subscription_pause_write_fences where subscription_id = p_subscription_id
      and operation_id = v_fence.operation_id;
  end if;

  if p_resumed_at is not null then
    update public.subscription_pause_windows set resumed_at = p_resumed_at
      where subscription_id = p_subscription_id and schedule_id = p_schedule_id
        and resumed_at is null and p_resumed_at > pause_at;
  end if;

  if exists (select 1 from public.subscription_pause_windows
      where subscription_id = p_subscription_id
        and p_paid_end > pause_at and (resumed_at is null or p_paid_start < resumed_at)) then
    raise exception 'subscription invoice overlaps pause';
  end if;

  insert into public.sandbox_subscription_paid_cycles (subscription_id, period_start, stripe_invoice_id)
    values (p_subscription_id, p_paid_start, p_stripe_invoice_id);

  return public.activate_subscription_from_invoice(
    p_subscription_id, p_stripe_subscription_id, p_stripe_invoice_id,
    p_current_period_start, p_current_period_end, p_next_delivery_at);
end;
$$;
revoke all on function public.activate_sandbox_subscription_cycle(uuid,text,text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,text,timestamptz) from public, anon, authenticated;
grant execute on function public.activate_sandbox_subscription_cycle(uuid,text,text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,text,timestamptz) to service_role;

-- A legacy caller cannot bypass the guard by using the original RPC directly.
create function public.require_guarded_subscription_cycle() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.subscription_id is null or new.stripe_invoice_id is null then return new; end if;
  perform 1 from public.subscriptions where id = new.subscription_id for update;
  if (exists (select 1 from public.subscription_pause_windows where subscription_id = new.subscription_id)
      or exists (select 1 from public.subscription_pause_write_fences where subscription_id = new.subscription_id))
    and not exists (select 1 from public.sandbox_subscription_paid_cycles
      where subscription_id = new.subscription_id and stripe_invoice_id = new.stripe_invoice_id) then
    raise exception 'guarded subscription invoice claim required';
  end if;
  return new;
end;
$$;
revoke all on function public.require_guarded_subscription_cycle() from public, anon, authenticated;
create trigger require_guarded_subscription_cycle
before insert on public.checkout_attempts
for each row execute function public.require_guarded_subscription_cycle();

commit;
