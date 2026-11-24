begin;

create table public.creator_payout_months (
  payout_id uuid primary key references public.creator_payouts(id),
  creator_id uuid not null references public.creators(id),
  month date not null check (extract(day from month)=1),
  unique (creator_id,month)
);

create table public.creator_payout_positions (
  payout_id uuid not null references public.creator_payout_months(payout_id),
  commission_id uuid not null references public.creator_commissions(id),
  cents integer not null check (cents<>0),
  released boolean not null default false,
  primary key(payout_id,commission_id)
);
create unique index creator_payout_position_claim on public.creator_payout_positions(commission_id) where not released;

create table public.creator_payout_events (
  operation_id uuid primary key,
  payout_id uuid not null references public.creator_payout_months(payout_id),
  action text not null check(action in ('create','approve','reject','paid')),
  actor uuid not null,
  evidence text,
  evidence_document_id uuid unique references public.documents(id),
  check ((action='paid')=(evidence_document_id is not null)),
  occurred_at timestamptz not null default clock_timestamp()
);
create index creator_payout_events_by_payout on public.creator_payout_events(payout_id,occurred_at);
create unique index creator_payout_external_evidence_once on public.creator_payout_events(lower(evidence)) where action='paid';

alter table public.creator_payout_months enable row level security;
alter table public.creator_payout_positions enable row level security;
alter table public.creator_payout_events enable row level security;
revoke all on public.creator_payout_months,public.creator_payout_positions,public.creator_payout_events
  from public,anon,authenticated,service_role;

-- Existing payout rows remain writable through their original paths. Only rows
-- linked to this release's monthly workflow require the activation key.
create function public.guard_creator_monthly_payout_release_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.creator_payout_months where payout_id=old.id) then
    perform public.require_creator_b2b_release_writes_v1();
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function public.guard_creator_monthly_payout_release_v1() from public,anon,authenticated,service_role;
create trigger creator_monthly_payout_release_required before update or delete on public.creator_payouts
  for each row execute function public.guard_creator_monthly_payout_release_v1();

create function public.guard_creator_payment_document_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.creator_payout_events where evidence_document_id=old.id)
    then raise exception 'creator_payout_evidence_protected' using errcode='55000'; end if;
  return new;
end $$;
revoke all on function public.guard_creator_payment_document_v1() from public,anon,authenticated,service_role;
create trigger creator_payment_document_protected before update of cleanup_operation_id,storage_path,file_sha256
on public.documents for each row execute function public.guard_creator_payment_document_v1();

-- An order refund can be visible before its separate commission reversal.
-- Apply the existing refund writer's half-up rule to detect that gap.
create function public.creator_payout_refund_reconciled_v1(
  p_commission uuid,p_cents integer,p_gross integer,p_refunded integer,p_payment text
) returns boolean language sql stable set search_path='' as $$
  select case
    when p_payment='paid' and coalesce(p_refunded,0)=0 then true
    when p_payment='partially_refunded' and p_gross>0 and p_refunded between 1 and p_gross-1 then
      (select coalesce(sum(c.amount_cents),0) from public.creator_commissions c
       where c.kind='reversal' and c.reverses_commission_id=p_commission)
      = (2*p_cents::bigint*p_refunded+p_gross)/(2*p_gross::bigint)
    else false end
$$;
revoke all on function public.creator_payout_refund_reconciled_v1(uuid,integer,integer,integer,text)
  from public,anon,authenticated,service_role;

-- Private projection over existing commissions and confirmed deliveries.
-- Rejected claims are carried into later months; paid rows stay claimed.
create function public.creator_payout_candidates_v1(p_creator uuid,p_month date)
returns table(commission_id uuid,kind text,order_id uuid,cents integer)
language sql stable set search_path='' as $$
  with cutoff as (
    select ((p_month+interval '1 month') at time zone 'Europe/Berlin') as end_at
  ), eligible as (
    select c.id,c.order_id from public.creator_commissions c
    join public.orders o on o.id=c.order_id cross join cutoff
    where c.creator_id=p_creator and c.kind='earned' and c.payout_state in ('pending','eligible')
      and c.payout_id is null and o.delivered_at+interval '720 hours'<cutoff.end_at
      and o.cancelled_at is null and o.status not in ('cancelled','refunded')
      and public.creator_payout_refund_reconciled_v1(c.id,c.amount_cents,o.total_gross_cents,
        o.refunded_total_cents,o.payment_status)
      and not exists(select 1 from public.creator_payout_positions x where x.commission_id=c.id and not x.released)
      and c.amount_cents>(select coalesce(sum(r.amount_cents),0) from public.creator_commissions r
          where r.reverses_commission_id=c.id and r.kind='reversal')
  )
  select c.id,c.kind,c.order_id,case when c.kind='earned' then c.amount_cents else -c.amount_cents end
  from public.creator_commissions c cross join cutoff
  where c.creator_id=p_creator and not exists(select 1 from public.creator_payout_positions x
    where x.commission_id=c.id and not x.released)
  and (
    c.id in (select e.id from eligible e)
    or (c.kind='reversal' and (
      c.reverses_commission_id in (select e.id from eligible e)
      or (c.created_at<cutoff.end_at and exists(select 1 from public.creator_commissions paid
        join public.creator_payout_months m on m.payout_id=paid.payout_id
        where paid.id=c.reverses_commission_id and paid.payout_state='paid'))
    ))
  )
$$;
revoke all on function public.creator_payout_candidates_v1(uuid,date) from public,anon,authenticated,service_role;

create function public.creator_payout_snapshot_current_v1(p_payout uuid,p_paid_at timestamptz)
returns boolean language sql stable set search_path='' as $$
  select not exists(
    select 1 from public.creator_payout_positions x join public.creator_commissions c on c.id=x.commission_id
    join public.orders o on o.id=c.order_id
    where x.payout_id=p_payout and c.kind='earned' and (
      c.payout_state not in ('pending','eligible') or c.payout_id is not null or
      o.delivered_at is null or o.delivered_at+interval '720 hours'>statement_timestamp() or
      o.cancelled_at is not null or o.status in ('cancelled','refunded') or
      not public.creator_payout_refund_reconciled_v1(c.id,c.amount_cents,o.total_gross_cents,
        o.refunded_total_cents,o.payment_status) or
      exists(select 1 from public.creator_commissions r where r.reverses_commission_id=c.id
        and r.kind='reversal' and (p_paid_at is null or r.created_at<=p_paid_at)
        and not exists(select 1 from public.creator_payout_positions y
          where y.payout_id=p_payout and y.commission_id=r.id))
    )
  )
$$;
revoke all on function public.creator_payout_snapshot_current_v1(uuid,timestamptz)
  from public,anon,authenticated,service_role;

create function public.admin_creator_payout_v1(
  p_actor uuid,p_creator uuid,p_month date,p_action text,p_operation uuid default null,p_evidence text default null,
  p_paid_at timestamptz default null,p_document uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_payout public.creator_payouts; v_prior public.creator_payout_events; v_id uuid;
  v_candidates jsonb; v_total bigint; v_evidence text:=nullif(btrim(p_evidence),'');
begin
  if not exists(select 1 from public.admin_users where user_id=p_actor and role='owner' and is_active)
    then raise exception 'creator_payout_forbidden' using errcode='42501'; end if;
  if p_creator is null or p_month is null or p_month<>date_trunc('month',p_month)::date
    or p_month>=(date_trunc('month',clock_timestamp() at time zone 'Europe/Berlin'))::date
    or p_action is null or p_action not in ('read','export','create','approve','reject','paid')
    or not exists(select 1 from public.creators where id=p_creator)
    then raise exception 'creator_payout_invalid' using errcode='22023'; end if;

  if p_action not in ('read','export') then
    perform public.require_creator_b2b_release_writes_v1();
    if p_operation is null or (p_action in ('reject','paid') and
       (v_evidence is null or length(v_evidence)>255)) or
       (p_action not in ('reject','paid') and v_evidence is not null) or
       (p_action='paid') is distinct from (p_paid_at is not null) or
       (p_action='paid') is distinct from (p_document is not null)
      then raise exception 'creator_payout_invalid' using errcode='22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('creator:payout:'||p_creator::text,0));
  end if;

  select p.* into v_payout from public.creator_payout_months m
    join public.creator_payouts p on p.id=m.payout_id where m.creator_id=p_creator and m.month=p_month;

  if p_action in ('read','export') then
    if p_action='export' and v_payout.id is null then raise exception 'creator_payout_missing'; end if;
    return jsonb_build_object('month',p_month,'creatorId',p_creator,
      'taxDocumentAvailable',false,'payout',to_jsonb(v_payout),
      'needsReview',coalesce(v_payout.state in ('draft','approved') and
        not public.creator_payout_snapshot_current_v1(v_payout.id,null),false),
      'candidates',case when v_payout.id is null then coalesce((
        select jsonb_agg(to_jsonb(c) order by c.commission_id)
        from public.creator_payout_candidates_v1(p_creator,p_month) c),'[]') else '[]'::jsonb end,
      'positions',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('kind',c.kind,'order_id',c.order_id)
        order by x.commission_id) from public.creator_payout_positions x join public.creator_commissions c on c.id=x.commission_id
        where x.payout_id=v_payout.id),'[]'),
      'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.operation_id)
        from public.creator_payout_events e where e.payout_id=v_payout.id),'[]'),
      'history',coalesce((select jsonb_agg(q order by q.month desc) from (
        select m.month,p.id,p.state,p.total_cents,p.paid_at from public.creator_payout_months m
        join public.creator_payouts p on p.id=m.payout_id where m.creator_id=p_creator order by m.month desc limit 36
      ) q),'[]'));
  end if;

  select * into v_prior from public.creator_payout_events where operation_id=p_operation;
  if found then
    if (v_prior.payout_id,v_prior.action,v_prior.actor,v_prior.evidence)
      is distinct from (v_payout.id,p_action,p_actor,v_evidence) or
      (p_action='paid' and (p_paid_at is distinct from v_payout.paid_at or
        p_document is distinct from v_prior.evidence_document_id))
      then raise exception 'creator_payout_conflict'; end if;
    return jsonb_build_object('id',v_payout.id,'state',v_payout.state);
  end if;

  if p_action='create' then
    if v_payout.id is not null then return jsonb_build_object('id',v_payout.id,'state',v_payout.state); end if;
    perform 1 from public.orders o where exists(select 1 from public.creator_commissions c
      where c.creator_id=p_creator and c.kind='earned' and c.order_id=o.id) order by o.id for update;
    perform 1 from public.creator_commissions where creator_id=p_creator and kind='earned' order by id for update;
    select jsonb_agg(to_jsonb(c)),sum(c.cents) into v_candidates,v_total
      from public.creator_payout_candidates_v1(p_creator,p_month) c;
    if v_total is null or v_total<=0 or v_total>2147483647 then raise exception 'creator_payout_no_positive_balance'; end if;
    insert into public.creator_payouts(creator_id,total_cents,created_by)
      values(p_creator,v_total::integer,p_actor) returning id into v_id;
    insert into public.creator_payout_months values(v_id,p_creator,p_month);
    insert into public.creator_payout_positions(payout_id,commission_id,cents)
      select v_id,c.commission_id,c.cents from jsonb_to_recordset(v_candidates) as c(commission_id uuid,cents integer);
  else
    v_id:=v_payout.id;
    if v_id is null then raise exception 'creator_payout_missing'; end if;
    if (p_action='approve' and v_payout.state<>'draft') or
       (p_action='reject' and v_payout.state not in ('draft','approved')) or
       (p_action='paid' and v_payout.state<>'approved') then raise exception 'creator_payout_conflict'; end if;
    if p_action='paid' and (p_paid_at>clock_timestamp() or p_paid_at<v_payout.updated_at) then
      raise exception 'creator_payout_invalid' using errcode='22023';
    end if;

    if p_action in ('approve','paid') then
      -- Locks match the existing refund writer's earning lock.
      perform 1 from public.orders o where exists(
        select 1 from public.creator_payout_positions x join public.creator_commissions c on c.id=x.commission_id
        where x.payout_id=v_id and c.order_id=o.id
      ) order by o.id for update;
      perform 1 from public.creator_commissions c where c.kind='earned' and exists(
        select 1 from public.creator_payout_positions x join public.creator_commissions source on source.id=x.commission_id
        where x.payout_id=v_id and c.id=coalesce(source.reverses_commission_id,source.id)
      ) order by c.id for update;
      if not public.creator_payout_snapshot_current_v1(v_id,p_paid_at) then
        raise exception 'creator_payout_changed';
      end if;
    end if;

    if p_action='reject' then
      update public.creator_payout_positions set released=true where payout_id=v_id;
      update public.creator_payouts set state='cancelled',updated_at=clock_timestamp() where id=v_id;
    elsif p_action='approve' then
      update public.creator_payouts set state='approved',approved_by=p_actor,updated_at=clock_timestamp() where id=v_id;
    else
      perform 1 from public.documents d where d.id=p_document and d.kind='other'
        and d.storage_path is not null and d.file_sha256 is not null and d.cleanup_operation_id is null
        and exists(select 1 from storage.objects o where o.bucket_id='gloa-finance-documents' and o.name=d.storage_path)
        for update;
      if not found then raise exception 'creator_payout_evidence_missing'; end if;
      if exists(select 1 from public.creator_payouts where state='paid' and lower(reference)=lower(v_evidence))
        then raise exception 'creator_payout_conflict'; end if;
      update public.creator_payouts set state='paid',reference=v_evidence,paid_at=p_paid_at,
        updated_at=clock_timestamp() where id=v_id;
      update public.creator_commissions c set payout_state='paid',payout_id=v_id
        where c.kind='earned' and exists(select 1 from public.creator_payout_positions x
          where x.payout_id=v_id and x.commission_id=c.id);
    end if;
  end if;
  insert into public.creator_payout_events(operation_id,payout_id,action,actor,evidence,evidence_document_id)
    values(p_operation,v_id,p_action,p_actor,v_evidence,p_document);
  return (select jsonb_build_object('id',id,'state',state) from public.creator_payouts where id=v_id);
end $$;
revoke all on function public.admin_creator_payout_v1(uuid,uuid,date,text,uuid,text,timestamptz,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_creator_payout_v1(uuid,uuid,date,text,uuid,text,timestamptz,uuid) to service_role;

commit;
