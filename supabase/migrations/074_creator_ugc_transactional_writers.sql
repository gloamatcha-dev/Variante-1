-- 074: transactional UGC expense association and Creator operations.
-- Only two new RPCs; unchanged 071 expense writers own monetary validation.
-- No tables, columns, indexes, policies, seed data or table grants.
begin;
do $$
begin
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n
    on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('admin_save_ugc_business_expense','admin_mutate_creator')) then
    raise exception '074 already applied or conflicting RPC: DO NOT APPLY';
  end if;
end;
$$;

create function public.admin_save_ugc_business_expense(
  p_actor_user_id uuid, p_expense_id uuid, p_ugc_assignment_id uuid,
  p_occurred_on date, p_category text, p_gross_cents integer,
  p_description text, p_channel text, p_payment_status text,
  p_vat_cents integer default null, p_order_id uuid default null,
  p_vendor text default null, p_note text default null,
  p_operation_id uuid default null
)
returns public.business_expenses
language plpgsql security definer set search_path = ''
as $$
declare
  v_operation uuid := coalesce(p_operation_id,pg_catalog.gen_random_uuid());
  v_action text := case when p_expense_id is null then 'expense_recorded' else 'expense_updated' end;
  v_prior public.admin_activity_log;
  v_row public.business_expenses;
  v_before uuid;
begin
  perform 1 from public.admin_users where user_id=p_actor_user_id and is_active
    and role in ('owner','admin') for share;
  if not found then raise exception 'Active writing administrator required' using errcode='42501'; end if;
  -- Same lock as 071: old and new entry points cannot race a shared operation.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('finance:'||v_action||':'||v_operation::text,0));
  select * into v_prior from public.admin_activity_log
    where module='finance' and action=v_action and operation_id=v_operation;
  if found then
    if v_prior.actor_user_id is distinct from p_actor_user_id
      or (p_expense_id is not null and v_prior.entity_id is distinct from p_expense_id::text)
      or not exists(select 1 from public.admin_activity_log l where l.module='finance'
        and l.action='expense_ugc_associated' and l.operation_id=v_operation
        and l.entity_id=v_prior.entity_id and l.actor_user_id=p_actor_user_id
        and l.metadata->'afterUgcAssignmentId' is not distinct from coalesce(pg_catalog.to_jsonb(p_ugc_assignment_id),'null'::jsonb)) then
      raise exception 'Expense operation reused for a different association' using errcode='23505';
    end if;
    select * into v_row from public.business_expenses where id=v_prior.entity_id::uuid;
    return v_row; -- never reapply a past association after a later correction
  end if;
  if p_ugc_assignment_id is null and p_expense_id is null then
    raise exception 'UGC assignment required' using errcode='22023';
  end if;
  if p_ugc_assignment_id is not null then
    perform 1 from public.ugc_assignments where id=p_ugc_assignment_id for key share;
    if not found then raise exception 'UGC assignment missing' using errcode='P0002'; end if;
  end if;
  if p_expense_id is not null then
    select ugc_assignment_id into v_before from public.business_expenses where id=p_expense_id for update;
    if not found then return null; end if;
    v_row := public.admin_update_business_expense(p_actor_user_id,p_expense_id,p_occurred_on,
      p_category,p_gross_cents,p_description,p_channel,p_payment_status,p_vat_cents,
      p_order_id,p_vendor,p_note,v_operation);
  else
    v_row := public.admin_record_business_expense(p_actor_user_id,p_occurred_on,
      p_category,p_gross_cents,p_description,p_channel,p_payment_status,p_vat_cents,
      p_order_id,p_vendor,p_note,v_operation);
  end if;
  -- Existing FK, single-source CHECK and unique obligation index remain authority.
  update public.business_expenses set ugc_assignment_id=p_ugc_assignment_id
    where id=v_row.id returning * into v_row;
  -- The original expense event describes money; this event describes association.
  -- BOTH are in this statement's transaction. Any failure rolls back all writes.
  perform public.record_admin_activity(p_actor_user_id,'finance','expense_ugc_associated',
    'business_expense',v_row.id::text,'UGC-Kosten zugeordnet',v_operation,
    pg_catalog.jsonb_build_object('beforeUgcAssignmentId',v_before,
      'afterUgcAssignmentId',p_ugc_assignment_id,'expenseAction',v_action));
  return v_row;
end;
$$;

create function public.admin_mutate_creator(
  p_actor_user_id uuid, p_action text, p_creator_id uuid,
  p_profile jsonb, p_roles text[], p_operation_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_operation uuid := coalesce(p_operation_id,pg_catalog.gen_random_uuid());
  v_action text;
  v_prior public.admin_activity_log;
  v_before public.creators;
  v_row public.creators;
  v_candidate public.creators;
  v_roles text[];
  v_old_roles text[];
  v_request jsonb;
  v_changed boolean := true;
begin
  perform 1 from public.admin_users where user_id=p_actor_user_id and is_active
    and role in ('owner','admin') for share;
  if not found then raise exception 'Active writing administrator required' using errcode='42501'; end if;
  if p_action is null or p_action not in ('create','update','add_role','set_roles')
    or p_profile is null or pg_catalog.jsonb_typeof(p_profile)<>'object'
    or exists(select 1 from pg_catalog.jsonb_each(p_profile) e where e.key not in
      ('display_name','email','instagram','tiktok','portfolio_url','country','status','notes')
      or pg_catalog.jsonb_typeof(e.value) not in ('string','null'))
    or (p_action='create' and p_creator_id is not null)
    or (p_action<>'create' and p_creator_id is null)
    or (p_action in ('add_role','set_roles') and p_profile<>'{}'::jsonb)
    or (p_action='update' and p_roles is not null)
    or (p_action in ('add_role','set_roles') and p_roles is null)
    or exists(select 1 from pg_catalog.unnest(p_roles) r where r is null or r not in ('influencer','ugc_creator','affiliate')) then
    raise exception 'Invalid Creator operation' using errcode='22023';
  end if;
  select coalesce(pg_catalog.array_agg(role order by role),'{}'::text[]) into v_roles
    from (select distinct r as role from pg_catalog.unnest(p_roles) r) roles;
  if p_action='add_role' and pg_catalog.cardinality(v_roles)<>1 then
    raise exception 'One role required' using errcode='22023';
  end if;
  v_action := case p_action when 'create' then 'creator.created' when 'update' then 'creator.updated' else 'creator.roles_updated' end;
  v_request := pg_catalog.jsonb_build_object('action',p_action,'creatorId',p_creator_id,'profile',p_profile,'roles',v_roles);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('creator:mutation:'||v_operation::text,0));
  select * into v_prior from public.admin_activity_log where module='creator'
    and action in ('creator.created','creator.updated','creator.roles_updated') and operation_id=v_operation;
  if found then
    if v_prior.actor_user_id is distinct from p_actor_user_id or v_prior.action<>v_action
      or v_prior.metadata->>'requestHash' is distinct from pg_catalog.md5(v_request::text) then
      raise exception 'Creator operation reused' using errcode='23505';
    end if;
    select * into v_row from public.creators where id=v_prior.entity_id::uuid;
    if not found then raise exception 'Creator missing' using errcode='P0002'; end if;
    return pg_catalog.jsonb_build_object('result','already_saved','creator',pg_catalog.to_jsonb(v_row));
  end if;
  if p_action<>'create' then
    select * into v_before from public.creators where id=p_creator_id for update;
    if not found then raise exception 'Creator missing' using errcode='P0002'; end if;
  end if;
  if p_action in ('create','update') then
    v_candidate := pg_catalog.jsonb_populate_record(v_before,p_profile);
    v_candidate.display_name := pg_catalog.btrim(v_candidate.display_name);
    v_candidate.email := pg_catalog.btrim(v_candidate.email);
    v_candidate.status := case when p_action='create' and not(p_profile?'status') then 'prospect' else v_candidate.status end;
    if v_candidate.display_name is null or pg_catalog.char_length(v_candidate.display_name) not between 1 and 120
      or v_candidate.email is null or v_candidate.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or v_candidate.status is null or v_candidate.status not in ('prospect','active','paused','ended','rejected') then
      raise exception 'Invalid Creator fields' using errcode='22023';
    end if;
    if p_action='create' then
      insert into public.creators(display_name,email,instagram,tiktok,portfolio_url,country,status,notes,created_by)
        values(v_candidate.display_name,v_candidate.email,v_candidate.instagram,v_candidate.tiktok,
          v_candidate.portfolio_url,v_candidate.country,v_candidate.status,v_candidate.notes,p_actor_user_id)
        returning * into v_row;
      insert into public.creator_roles(creator_id,role) select v_row.id,r from pg_catalog.unnest(v_roles) r;
    else
      update public.creators set display_name=v_candidate.display_name,email=v_candidate.email,
        instagram=v_candidate.instagram,tiktok=v_candidate.tiktok,portfolio_url=v_candidate.portfolio_url,
        country=v_candidate.country,status=v_candidate.status,notes=v_candidate.notes,updated_at=pg_catalog.now()
        where id=p_creator_id returning * into v_row;
    end if;
  else
    v_row := v_before;
    select coalesce(pg_catalog.array_agg(role order by role),'{}'::text[]) into v_old_roles
      from public.creator_roles where creator_id=p_creator_id;
    if p_action='add_role' then
      if v_roles[1]=any(v_old_roles) then
        v_changed := false;
      else
        insert into public.creator_roles(creator_id,role) values(p_creator_id,v_roles[1]);
      end if;
    else
      if v_roles=v_old_roles then
        v_changed := false;
      else
        delete from public.creator_roles where creator_id=p_creator_id and not(role=any(v_roles));
        insert into public.creator_roles(creator_id,role) select p_creator_id,r from pg_catalog.unnest(v_roles) r
          on conflict (creator_id,role) do nothing;
      end if;
    end if;
  end if;
  perform public.record_admin_activity(p_actor_user_id,'creator',v_action,'creator',v_row.id::text,
    case when not v_changed then 'Creator-Rollen unverändert' when p_action='create' then 'Creator angelegt' when p_action='update' then 'Creator aktualisiert' else 'Creator-Rollen aktualisiert' end,
    -- Existing audit metadata is capped at 1 KB. Never copy contact/profile text
    -- or a 4000-character note into it. The hash also detects key misuse.
    v_operation,pg_catalog.jsonb_build_object('requestHash',pg_catalog.md5(v_request::text),
      'changed',v_changed,'beforeStatus',v_before.status,'afterStatus',v_row.status,
      'changedFields',(select coalesce(pg_catalog.jsonb_agg(k order by k),'[]'::jsonb) from pg_catalog.jsonb_object_keys(p_profile) k),
      'beforeRoles',v_old_roles,
      'afterRoles',(select coalesce(pg_catalog.jsonb_agg(role order by role),'[]'::jsonb) from public.creator_roles where creator_id=v_row.id)));
  -- Even a no-op is durably keyed: replay must not undo a later role change.
  return pg_catalog.jsonb_build_object('result',case when v_changed then 'saved' else 'unchanged' end,'creator',pg_catalog.to_jsonb(v_row));
end;
$$;

revoke all privileges on function public.admin_save_ugc_business_expense(uuid,uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_save_ugc_business_expense(uuid,uuid,uuid,date,text,integer,text,text,text,integer,uuid,text,text,uuid) to service_role;
revoke all privileges on function public.admin_mutate_creator(uuid,text,uuid,jsonb,text[],uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_mutate_creator(uuid,text,uuid,jsonb,text[],uuid) to service_role;
commit;
