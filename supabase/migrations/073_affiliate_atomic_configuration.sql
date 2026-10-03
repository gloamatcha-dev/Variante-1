-- 073: one transactional catalogue writer. Requires the unchanged 072 baseline.
-- No table/index/policy changes, backfill, DELETE grant, or business seed data.
-- Existing attributions freeze their rule/amount; this writer never touches them.
begin;

-- Refuse reruns and overload collisions rather than replacing unknown code.
do $$
begin
  if exists (select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'admin_save_affiliate_configuration') then
    raise exception '073 already applied or conflicting RPC exists: DO NOT APPLY';
  end if;
end;
$$;

create function public.admin_save_affiliate_configuration(
  p_actor_user_id uuid,
  p_rule_mode text,
  p_relationship_type text,
  p_creator_id uuid,
  p_reference text,
  p_active boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_commission_rule_id uuid,
  p_percent_basis_points integer,
  p_fixed_cents integer,
  p_base text,
  p_rule_label text,
  p_relationship_id uuid default null,
  p_discount_code text default null
)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_creator public.creators;
  v_rule public.creator_commission_rules;
  v_old jsonb;
  v_creator_id uuid;
  v_rule_id uuid;
  v_id uuid;
  v_reference text := pg_catalog.btrim(p_reference);
  v_discount text := nullif(pg_catalog.btrim(p_discount_code), '');
  v_label text;
  v_value text;
  v_starts timestamptz;
  v_replay boolean;
  v_audit_id uuid;
begin
  -- Server supplies the authenticated actor, never browser actor metadata.
  perform 1 from public.admin_users
    where user_id = p_actor_user_id and is_active and role in ('owner', 'admin')
    for share;
  if not found then
    raise exception 'An active writing administrator is required' using errcode = '42501';
  end if;
  if p_relationship_type is null or p_relationship_type not in ('link', 'code')
    or p_active is null or v_reference is null
    or (p_relationship_type = 'link' and v_reference !~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$')
    or (p_relationship_type = 'code' and v_reference !~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,38}[A-Za-z0-9]$') then
    raise exception 'Invalid affiliate configuration' using errcode = '22023';
  end if;
  if v_discount is not null and pg_catalog.char_length(v_discount) not between 2 and 60 then
    raise exception 'Invalid discount reference' using errcode = '22023';
  end if;
  if p_starts_at is not null and not pg_catalog.isfinite(p_starts_at)
    or p_ends_at is not null and not pg_catalog.isfinite(p_ends_at) then
    raise exception 'Invalid validity window' using errcode = '22023';
  end if;
  if p_rule_mode is null or p_rule_mode not in ('inline', 'existing') then
    raise exception 'Choose inline configuration or an existing rule' using errcode = '22023';
  end if;
  if p_rule_mode = 'existing' then
    if p_percent_basis_points is not null or p_fixed_cents is not null
      or p_base is not null or p_rule_label is not null then
      raise exception 'Choose existing rule OR inline configuration' using errcode = '22023';
    end if;
  elsif p_commission_rule_id is not null or (p_percent_basis_points is null) = (p_fixed_cents is null)
    or p_percent_basis_points is not null and (p_percent_basis_points <= 0 or p_percent_basis_points > 10000)
    or p_fixed_cents is not null and p_fixed_cents <= 0
    or p_base is null or p_base not in ('merchandise_net', 'merchandise_gross', 'order_gross') then
    raise exception 'Exactly one positive commission configuration is required' using errcode = '22023';
  end if;

  -- Low-volume administrative configuration only. Serializing this writer
  -- makes rule lookup/creation and identical retries safe without a new table
  -- or a uniqueness constraint that would redesign the reusable rule catalogue.
  -- Existing unique indexes still protect collisions with other catalogue writers.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('creator:affiliate:configuration', 0));
  if p_relationship_type = 'link' then
    select pg_catalog.to_jsonb(l) || pg_catalog.jsonb_build_object('discount_reference', l.customer_discount_code)
      into v_old from public.affiliate_links l
      where (p_relationship_id is not null and l.id = p_relationship_id)
         or (p_relationship_id is null and l.slug = v_reference)
      for update;
  else
    select pg_catalog.to_jsonb(c) || pg_catalog.jsonb_build_object('discount_reference', c.discount_code)
      into v_old from public.affiliate_codes c
      where (p_relationship_id is not null and c.id = p_relationship_id)
         or (p_relationship_id is null and pg_catalog.upper(pg_catalog.btrim(c.code)) = pg_catalog.upper(v_reference))
      for update;
  end if;
  if p_relationship_id is not null and v_old is null then
    raise exception 'Affiliate relationship not found' using errcode = 'P0002';
  end if;
  -- The current edit form does not edit discount references. Omission must
  -- preserve that existing configuration, as the previous adapter did.
  if p_relationship_id is not null and p_discount_code is null then
    v_discount := v_old->>'discount_reference';
  end if;
  v_creator_id := case when p_relationship_id is not null then (v_old->>'creator_id')::uuid else p_creator_id end;
  if p_relationship_id is not null and p_creator_id is not null and p_creator_id <> v_creator_id then
    raise exception 'An existing relationship cannot change creator' using errcode = '22023';
  end if;
  select * into v_creator from public.creators where id = v_creator_id for share;
  if not found then
    raise exception 'Creator not found' using errcode = '22023';
  end if;
  -- 072 allows configuration before activation and multiple roles. No new
  -- role/status prerequisite is invented here; resolve_affiliate_* continues
  -- to require an active creator before any order can earn commission.
  v_starts := coalesce(p_starts_at, (v_old->>'starts_at')::timestamptz, pg_catalog.now());
  if p_ends_at is not null and p_ends_at <= v_starts then
    raise exception 'End must be after start' using errcode = '22023';
  end if;
  if p_rule_mode = 'existing' then
    -- An explicitly selected "Keine Provisionsregel" preserves 072's
    -- supported attribution-without-commission state, not a zero amount.
    if p_commission_rule_id is not null then
      select * into v_rule from public.creator_commission_rules where id = p_commission_rule_id for share;
      if not found then
        raise exception 'Commission rule not found' using errcode = '22023';
      end if;
      v_rule_id := v_rule.id;
    end if;
  else
    if p_percent_basis_points is not null then
      v_value := pg_catalog.replace(pg_catalog.rtrim(pg_catalog.rtrim(
        pg_catalog.to_char(p_percent_basis_points::numeric / 100, 'FM990.00'), '0'), '.'), '.', ',') || ' %';
    else
      v_value := pg_catalog.replace(pg_catalog.to_char(p_fixed_cents::numeric / 100, 'FM9999999990.00'), '.', ',') || ' € pro Bestellung';
    end if;
    v_label := nullif(pg_catalog.btrim(p_rule_label), '');
    if v_label is null then
      v_label := pg_catalog.left(v_creator.display_name || ' · ' || v_value, 120);
    elsif pg_catalog.char_length(v_label) > 120 then
      raise exception 'Rule name is too long' using errcode = '22023';
    end if;
    select id into v_rule_id from public.creator_commission_rules
      where label = v_label and base = p_base and reverse_on_refund
        and percent_basis_points is not distinct from p_percent_basis_points
        and fixed_cents is not distinct from p_fixed_cents
      order by created_at, id limit 1;
    if v_rule_id is null then
      insert into public.creator_commission_rules(label, percent_basis_points, fixed_cents, base, reverse_on_refund, created_by)
        values(v_label, p_percent_basis_points, p_fixed_cents, p_base, true, p_actor_user_id)
        returning id into v_rule_id;
    end if;
  end if;

  v_replay := v_old is not null
    and (v_old->>'creator_id')::uuid = v_creator_id
    and (v_old->>'commission_rule_id')::uuid is not distinct from v_rule_id
    and (v_old->>'active')::boolean = p_active
    and (v_old->>'starts_at')::timestamptz = v_starts
    and (v_old->>'ends_at')::timestamptz is not distinct from p_ends_at
    and (v_old->>'discount_reference') is not distinct from v_discount
    and case when p_relationship_type = 'link' then v_old->>'slug' = v_reference
             else pg_catalog.upper(v_old->>'code') = pg_catalog.upper(v_reference) end;
  if v_replay then
    return pg_catalog.jsonb_build_object('result', 'already_saved', 'id', v_old->>'id', 'commission_rule_id', v_rule_id);
  end if;
  if p_relationship_id is null and v_old is not null then
    -- This exception rolls back a newly inserted rule too. No cleanup DELETE.
    raise exception 'Affiliate slug or code already exists' using errcode = '23505';
  end if;

  if p_relationship_type = 'link' then
    if p_relationship_id is null then
      insert into public.affiliate_links(creator_id, slug, active, starts_at, ends_at, commission_rule_id, customer_discount_code, created_by)
        values(v_creator_id, v_reference, p_active, v_starts, p_ends_at, v_rule_id, v_discount, p_actor_user_id) returning id into v_id;
    else
      update public.affiliate_links set slug = v_reference, active = p_active, starts_at = v_starts,
        ends_at = p_ends_at, commission_rule_id = v_rule_id, customer_discount_code = v_discount, updated_at = pg_catalog.now()
        where id = p_relationship_id returning id into v_id;
    end if;
  else
    if p_relationship_id is null then
      insert into public.affiliate_codes(creator_id, code, active, starts_at, ends_at, commission_rule_id, discount_code, created_by)
        values(v_creator_id, v_reference, p_active, v_starts, p_ends_at, v_rule_id, v_discount, p_actor_user_id) returning id into v_id;
    else
      update public.affiliate_codes set code = v_reference, active = p_active, starts_at = v_starts,
        ends_at = p_ends_at, commission_rule_id = v_rule_id, discount_code = v_discount, updated_at = pg_catalog.now()
        where id = p_relationship_id returning id into v_id;
    end if;
  end if;
  -- Failure of audit is failure of the entire configuration write as in 052.
  v_audit_id := public.record_admin_activity(p_actor_user_id, 'creator',
    case when p_relationship_id is null then 'affiliate.created' else 'affiliate.configuration_updated' end,
    'affiliate_' || p_relationship_type, v_id::text,
    case when p_relationship_id is null then 'Affiliate-Beziehung angelegt: ' else 'Affiliate-Konfiguration aktualisiert: ' end || v_reference,
    pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object('creator_id', v_creator_id, 'commission_rule_id', v_rule_id, 'active', p_active));
  return pg_catalog.jsonb_build_object('result', 'saved', 'id', v_id, 'commission_rule_id', v_rule_id, 'audit_id', v_audit_id);
end;
$$;

revoke all privileges on function public.admin_save_affiliate_configuration(uuid, text, text, uuid, text, boolean, timestamptz, timestamptz, uuid, integer, integer, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_save_affiliate_configuration(uuid, text, text, uuid, text, boolean, timestamptz, timestamptz, uuid, integer, integer, text, text, uuid, text)
  to service_role;

commit;
