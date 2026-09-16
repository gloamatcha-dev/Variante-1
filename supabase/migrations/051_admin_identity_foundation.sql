-- ══════════════════════════════════════════════════════════════
-- 051 — ADMIN IDENTITY AND ROLES
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT.
--
-- Until now an admin was a STRING. The session cookie carried an email
-- address, ADMIN_EMAILS decided whether that address was allowed, and
-- that was the whole of identity and authorisation. Three consequences
-- followed, and this migration exists for them:
--
--   no role      everybody on the allowlist could do everything. A
--                read-only account was not expressible at all.
--   no identity  an email is not stable. Change it and the same person
--                becomes a different one; reuse it and a different
--                person becomes the same one. Nothing an audit trail
--                could ever anchor to.
--   no name      the screen could only ever show an address.
--
-- So this table is keyed on auth.users(id) - the one identifier that
-- does not move when an address does - and carries the role.
--
-- ── WHAT IS NOT HERE ──────────────────────────────────────────
--
-- No activity log, no record_admin_activity(), no actor columns on
-- orders, no changes to the inventory functions. Those are 4A.2B-2 and
-- are deliberately absent so that this foundation can be reviewed on
-- its own. No finance column, no B2B table, nothing about money.
--
-- ── THE EXISTING ADMIN MUST NOT BE LOCKED OUT ─────────────────
--
-- Section 4 below promotes the account that works TODAY, found by its
-- address in auth.users rather than by a UUID pasted into a file. If it
-- cannot be found, the migration RAISES and rolls back: a foundation
-- that shuts the only operator out of production is worse than no
-- foundation, and failing loudly is the only honest way to say so.
--
-- ── WHAT IS STILL THE OUTER GATE ──────────────────────────────
--
-- ADMIN_EMAILS stays, for now, as a second and independent barrier. It
-- is NOT the source of truth any more - admin_users.role and
-- .is_active are - but until the three real accounts exist and have
-- been tested, a bug in this table must not be able to open the admin
-- on its own. It is removed in a later package, not in this one.
-- ══════════════════════════════════════════════════════════════

begin;

-- ── 1. THE TABLE ──────────────────────────────────────────────
--
-- One row per person who may open the operations screen. Keyed on the
-- Supabase Auth user, not on the address: the address is here for
-- display and for the bootstrap below, and it is allowed to change.

create table if not exists public.admin_users (
  -- THE IDENTITY, AND IT DOES NOT DISAPPEAR QUIETLY.
  --
  -- RESTRICT, not CASCADE. An earlier draft cascaded, on the reasoning
  -- that there is no admin without an account to sign in with - which
  -- contradicted the rest of this table. Everything else here is built
  -- so an admin row is never deleted: access is withdrawn with
  -- is_active, service_role holds no DELETE grant, and 4A.2B-2 will
  -- anchor an audit trail to exactly these rows. A cascade would have
  -- let one click in the Supabase dashboard delete an auth user and
  -- silently take the record that this person was ever an
  -- administrator with it - which is precisely the record an audit
  -- trail exists to keep.
  --
  -- RESTRICT makes that deletion FAIL while the admin row exists. To
  -- remove somebody completely the row has to be dealt with first, as a
  -- deliberate act, in the open.
  user_id      uuid primary key references auth.users(id) on delete restrict,

  -- For display, for finding a person again, and for the consistency
  -- check the server makes on every request. Not the key.
  --
  -- STORED CANONICAL, not merely compared canonically. The unique index
  -- below normalises for comparison, but that alone would still let
  -- " Valmira@GloaMatcha.com " sit in the column - and the server
  -- compares the session's address against THIS VALUE on every request,
  -- so a stored variant would mean an operator who is refused for a
  -- reason nobody can see. The CHECK makes the column itself the
  -- canonical form; whoever writes the row does the trimming.
  email        text not null check (length(btrim(email)) between 3 and 200
                                    and position('@' in email) > 1
                                    and email = lower(btrim(email))),

  -- What the header shows. "Valmira Hajzeri", not an address.
  display_name text not null check (length(btrim(display_name)) between 1 and 120),

  -- THREE ROLES AND NO MORE.
  --
  --   owner   everything an admin may do, and later the management of
  --           these rows. One person, accountable.
  --   admin   every operational change: orders, inventory.
  --   viewer  reads. No mutation, refused by the server rather than by
  --           a hidden button.
  --
  -- owner and admin are deliberately IDENTICAL for operational work.
  -- Inventing a difference nobody asked for would be a permission rule
  -- to maintain forever in exchange for nothing.
  role         text not null check (role in ('owner', 'admin', 'viewer')),

  -- Revoking access without deleting history. A row that is switched
  -- off must stop working immediately, which is why the server
  -- re-reads this on every request rather than trusting the cookie.
  is_active    boolean not null default true,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ONE ADDRESS, ONE ADMIN.
--
-- The column is already canonical (the CHECK above), so this index is
-- belt to that pair of braces rather than the only defence: it keeps
-- "A@b.de" and "a@B.de" one person even if the CHECK is ever relaxed,
-- and it is the expression the server's lookups can use.
create unique index if not exists idx_admin_users_email
  on public.admin_users (lower(btrim(email)));

-- Reusing 050's trigger function rather than declaring a second one.
drop trigger if exists set_admin_users_updated_at on public.admin_users;
create trigger set_admin_users_updated_at
  before update on public.admin_users
  for each row execute function public.set_updated_at();

comment on table public.admin_users is
  'Who may open the GLOA operations screen, and in which role. Source of truth for role and active state; ADMIN_EMAILS is a transitional second gate.';

-- ── 2. NOTHING IN A BROWSER MAY SEE OR TOUCH THIS ─────────────
--
-- RLS on and NOT ONE POLICY, the same shape as every table in 050. A
-- customer is an `authenticated` Supabase user, so without this a
-- signed-in customer could read the list of administrators and their
-- roles - a ready-made target list. Grants are revoked as well, so the
-- table is closed at both layers rather than at one.

alter table public.admin_users enable row level security;

revoke all on public.admin_users from anon, authenticated;

-- THE SERVER READS IT ON EVERY ADMIN REQUEST, and may maintain it.
--
-- No DELETE: switching is_active to false is how access is withdrawn.
-- Deleting the row would delete the only record that this person was
-- ever an administrator, which is exactly what an audit trail needs in
-- the next package.
--
-- And there is no back door through auth.users either: the foreign key
-- above is RESTRICT, so deleting the auth user FAILS while this row
-- exists. Removing somebody completely is therefore a deliberate act
-- with two explicit steps, not a single click with a silent cascade.
grant select, insert on public.admin_users to service_role;
grant update (email, display_name, role, is_active, updated_at)
  on public.admin_users to service_role;

-- ── 3. AT LEAST ONE OWNER, ALWAYS ─────────────────────────────
--
-- A deployment whose every admin row is switched off or DEMOTED is one
-- nobody can repair through the product. Enforced as a trigger rather
-- than a CHECK because the condition is about the TABLE, not the row.
--
-- Both ways of losing the last owner are covered, because both are the
-- same statement to Postgres:
--
--   is_active -> false   an UPDATE, and the check below then finds no
--                        active owner.
--   role -> 'admin'      also an UPDATE, and the check finds no owner
--   or 'viewer'          at all. Demotion is not a special case.
--
-- DELETE is covered too, although service_role holds no DELETE grant
-- and the foreign key above is RESTRICT - three independent reasons the
-- last owner cannot vanish.
create or replace function public.admin_users_keep_one_owner()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.admin_users
    where role = 'owner' and is_active
  ) then
    raise exception 'admin_users must keep at least one active owner';
  end if;
  return null;
end;
$$;

drop trigger if exists admin_users_require_owner on public.admin_users;
create constraint trigger admin_users_require_owner
  after update or delete on public.admin_users
  deferrable initially deferred
  for each row execute function public.admin_users_keep_one_owner();

revoke all on function public.admin_users_keep_one_owner() from public, anon, authenticated;

-- ── 4. THE ACCOUNT THAT WORKS TODAY ───────────────────────────
--
-- gloa.matcha@gmail.com is the address in ADMIN_EMAILS that signs in
-- right now, and it already has an auth.users row - it must, because
-- the login path calls signInWithPassword and it succeeds.
--
-- It is promoted by LOOKING THE ADDRESS UP, not by pasting a UUID into
-- this file: a UUID copied by hand is a UUID that can be copied wrong,
-- and this way the migration is correct in any environment where that
-- address exists and refuses to run where it does not.
--
-- NO PASSWORD IS TOUCHED and NO AUTH USER IS CREATED. This is one row
-- in one new table.
--
-- 'owner' is TRANSITIONAL. When Valmira's personal account exists it
-- becomes the owner and this one is demoted or switched off - which is
-- a later, deliberate step, not something this migration pre-empts.

insert into public.admin_users (user_id, email, display_name, role, is_active)
select u.id, lower(btrim(u.email)), 'GLOA Admin', 'owner', true
from auth.users u
where lower(btrim(u.email)) = 'gloa.matcha@gmail.com'
on conflict (user_id) do nothing;

-- FAIL LOUDLY RATHER THAN LOCK OUT.
--
-- If the address above was not found, the table is now empty, the
-- application would refuse every admin request, and production would
-- have no way back in through the product. That must never be the
-- outcome of applying a migration, so it aborts instead.
do $$
begin
  if not exists (
    select 1 from public.admin_users where role = 'owner' and is_active
  ) then
    raise exception
      'Migration 051 aborted: no auth.users row for gloa.matcha@gmail.com, so admin_users has no active owner and the admin would be locked out. Verify the address in Supabase Auth before applying.';
  end if;
end $$;

commit;

-- ══════════════════════════════════════════════════════════════
-- VERIFYING THIS MIGRATION, read-only:
--
--   1. The row exists and is bound to a real auth user:
--        select a.user_id, a.email, a.display_name, a.role, a.is_active
--        from public.admin_users a
--        join auth.users u on u.id = a.user_id;
--      -> exactly one row, role 'owner', is_active true.
--
--   2. Nothing in a browser can read it:
--        select relrowsecurity from pg_class
--        where oid = 'public.admin_users'::regclass;          -> true
--        select count(*) from pg_policies
--        where tablename = 'admin_users';                     -> 0
--        select grantee, privilege_type from information_schema.role_table_grants
--        where table_name = 'admin_users';   -> service_role only
--
--   3. The last owner cannot be removed:
--        begin;
--          update public.admin_users set is_active = false where role = 'owner';
--        -- expected: 'admin_users must keep at least one active owner'
--        rollback;
--
--   4. Nothing from 050 moved:
--        select count(*) from public.inventory_movements;      -> unchanged
-- ══════════════════════════════════════════════════════════════
