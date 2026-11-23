begin;

-- Read-only preview. Source rows and payout state remain owned by the
-- existing commission ledger. No transfer or settlement is performed.
create function public.creator_monthly_preview_v1(p_actor uuid, p_creator uuid, p_month date)
returns table (
  commission_id uuid, delivered_at timestamptz, eligible_at timestamptz,
  earned_cents integer, refund_reversal_cents bigint, available_cents bigint
)
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists (select 1 from public.admin_users
    where user_id=p_actor and is_active and role='owner') then
    raise exception 'creator_statement_forbidden' using errcode='42501';
  end if;
  if p_month is null or extract(day from p_month) <> 1 or p_creator is null then
    raise exception 'creator_statement_invalid' using errcode='22023';
  end if;
  return query
    select c.id, o.delivered_at, o.delivered_at + interval '720 hours', c.amount_cents,
      r.reversed, greatest(c.amount_cents::bigint - r.reversed, 0::bigint)
    from public.creator_commissions c
    join public.orders o on o.id=c.order_id
    cross join lateral (
      select coalesce(sum(x.amount_cents),0::bigint) as reversed
      from public.creator_commissions x
      where x.kind='reversal' and x.reverses_commission_id=c.id
        and x.creator_id=c.creator_id and x.currency=c.currency
    ) r
    where c.creator_id=p_creator and c.kind='earned'
      and c.payout_state in ('pending','eligible') and c.payout_id is null
      and o.delivered_at + interval '720 hours' <= statement_timestamp()
      and ((o.delivered_at + interval '720 hours') at time zone 'Europe/Berlin')::date >= p_month
      and ((o.delivered_at + interval '720 hours') at time zone 'Europe/Berlin')::date < p_month + interval '1 month'
    order by o.delivered_at,c.id;
end $$;

revoke all on function public.creator_monthly_preview_v1(uuid,uuid,date)
from public, anon, authenticated, service_role;
grant execute on function public.creator_monthly_preview_v1(uuid,uuid,date) to service_role;

commit;
