-- YouNMeSign (EasySign) Phase 3 / migration 23: two-step sign-in (slice 4, AT3.4, D-69).
-- The authenticator-app codes themselves are Supabase Auth's (free, on by default). This adds what Supabase does
-- not provide: recovery codes (only their fingerprints are kept, each works once), an audit trail of set-up,
-- use, failure, recovery and reset, and the admin's reset of someone else's authenticator.
-- Policy (Sandesh, 2026-11-19): required for the platform admin, optional for everyone else; enforced by the app
-- (src/lib/auth/mfa-policy.ts). Account events go on the person's own workspace chain ('org:<id>'), as approvals do.
-- All functions are server-only (service role).

create table public.mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code_sha256 text not null check (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (user_id, code_sha256)
);
create index mfa_recovery_codes_user_idx on public.mfa_recovery_codes (user_id) where used_at is null;
alter table public.mfa_recovery_codes enable row level security;

create function app_private.has_verified_authenticator(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.factor_type = 'totp' and f.status = 'verified')
$$;

create function app_private.own_org(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.org_id from public.memberships m where m.user_id = p_user and m.role = 'owner' order by m.created_at limit 1
$$;

create function app_private.mfa_audit(p_user uuid, p_actor_type text, p_actor uuid, p_event text, p_payload jsonb, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app_private.own_org(p_user);
begin
  if v_org is null then
    raise exception 'ES_ACCOUNT: this account has no workspace' using errcode = '42501';
  end if;
  perform app_private.audit_append('org:' || v_org::text, v_org, null, null, p_actor_type, p_actor, p_event,
    p_payload || jsonb_build_object('user_id', p_user), p_ip, left(p_user_agent, 500));
end
$$;

-- What the account page needs to know.
create function public.mfa_status(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enrolled', app_private.has_verified_authenticator(p_actor),
    'codes_left', (select count(*) from public.mfa_recovery_codes c where c.user_id = p_actor and c.used_at is null),
    'admin', coalesce((select c.is_platform_admin from public.account_controls c where c.user_id = p_actor), false))
$$;

-- After the authenticator is set up: replaces any earlier codes with the new set (fingerprints only).
create function public.mfa_store_recovery_codes(p_actor uuid, p_hashes text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  if not app_private.has_verified_authenticator(p_actor) then
    raise exception 'ES_MFA_REQUIRED: set up your authenticator app first' using errcode = '42501';
  end if;
  v_n := coalesce(array_length(p_hashes, 1), 0);
  if v_n <> 10 or exists (select 1 from unnest(p_hashes) h where h is null or h !~ '^[0-9a-f]{64}$')
     or (select count(distinct h) from unnest(p_hashes) h) <> 10 then
    raise exception 'ES_INVALID: ten different recovery codes are needed' using errcode = '22023';
  end if;
  delete from public.mfa_recovery_codes c where c.user_id = p_actor;
  insert into public.mfa_recovery_codes (user_id, code_sha256) select p_actor, h from unnest(p_hashes) h;
  perform app_private.mfa_audit(p_actor, 'user', p_actor, 'mfa_recovery_codes_issued', jsonb_build_object('count', v_n), null, null);
  return v_n;
end
$$;

-- Set-up, use and failure as reported by the app after Supabase Auth answered. Checked against the
-- authenticator records, so the trail cannot claim a set-up that did not happen.
create function public.mfa_record_event(p_actor uuid, p_event text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_has boolean := app_private.has_verified_authenticator(p_actor);
begin
  if p_event not in ('mfa_enrolled', 'mfa_verified', 'mfa_failed', 'mfa_removed') then
    raise exception 'ES_INVALID: unknown event' using errcode = '22023';
  end if;
  if (p_event in ('mfa_enrolled', 'mfa_verified') and not v_has) or (p_event = 'mfa_removed' and v_has) then
    raise exception 'ES_INVALID: the authenticator records do not match that event' using errcode = '22023';
  end if;
  if p_event = 'mfa_removed' then
    delete from public.mfa_recovery_codes c where c.user_id = p_actor;
  end if;
  perform app_private.mfa_audit(p_actor, 'user', p_actor, p_event, '{}'::jsonb, p_ip, p_user_agent);
end
$$;

-- A lost authenticator: one unused recovery code removes the authenticator (and every other code), so the
-- person can sign in with their password and set it up again. 5 tries per 15 minutes.
create function public.mfa_use_recovery_code(p_actor uuid, p_code_sha256 text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_removed int;
begin
  if not public.rate_limit_hit('mfa_recovery', p_actor::text, 5, 900) then
    return 'limited';
  end if;
  update public.mfa_recovery_codes c set used_at = now()
   where c.user_id = p_actor and c.code_sha256 = p_code_sha256 and c.used_at is null
   returning c.id into v_id;
  if v_id is null then
    perform app_private.mfa_audit(p_actor, 'user', p_actor, 'mfa_failed', jsonb_build_object('method', 'recovery_code'), p_ip, p_user_agent);
    return 'wrong';
  end if;
  delete from auth.mfa_factors f where f.user_id = p_actor;
  get diagnostics v_removed = row_count;
  delete from public.mfa_recovery_codes c where c.user_id = p_actor;
  perform app_private.mfa_audit(p_actor, 'user', p_actor, 'mfa_recovery_used', jsonb_build_object('authenticators_removed', v_removed), p_ip, p_user_agent);
  return 'ok';
end
$$;

-- The admin removes someone else's authenticator (they lost it and their codes), after checking who they are.
create function public.admin_reset_mfa(p_actor uuid, p_user uuid, p_ip inet, p_user_agent text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_removed int;
begin
  perform app_private.require_admin(p_actor);
  if p_user = p_actor then
    raise exception 'ES_SELF: use one of your own recovery codes instead' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'ES_NOT_FOUND: account not found' using errcode = '42501';
  end if;
  delete from auth.mfa_factors f where f.user_id = p_user;
  get diagnostics v_removed = row_count;
  delete from public.mfa_recovery_codes c where c.user_id = p_user;
  perform app_private.mfa_audit(p_user, 'admin', p_actor, 'mfa_reset', jsonb_build_object('authenticators_removed', v_removed), p_ip, p_user_agent);
  insert into public.notifications (org_id, user_id, kind, payload)
    values (app_private.own_org(p_user), p_user, 'mfa_reset', '{}'::jsonb);
  return v_removed;
end
$$;

revoke all on function app_private.has_verified_authenticator(uuid), app_private.own_org(uuid),
  app_private.mfa_audit(uuid, text, uuid, text, jsonb, inet, text) from public, anon, authenticated, service_role;
revoke all on function public.mfa_status(uuid), public.mfa_store_recovery_codes(uuid, text[]), public.mfa_record_event(uuid, text, inet, text),
  public.mfa_use_recovery_code(uuid, text, inet, text), public.admin_reset_mfa(uuid, uuid, inet, text) from public, anon, authenticated;
grant execute on function public.mfa_status(uuid), public.mfa_store_recovery_codes(uuid, text[]), public.mfa_record_event(uuid, text, inet, text),
  public.mfa_use_recovery_code(uuid, text, inet, text), public.admin_reset_mfa(uuid, uuid, inet, text) to service_role;

-- down (manual):
-- drop function public.admin_reset_mfa(uuid, uuid, inet, text); drop function public.mfa_use_recovery_code(uuid, text, inet, text);
-- drop function public.mfa_record_event(uuid, text, inet, text); drop function public.mfa_store_recovery_codes(uuid, text[]);
-- drop function public.mfa_status(uuid); drop function app_private.mfa_audit(uuid, text, uuid, text, jsonb, inet, text);
-- drop function app_private.own_org(uuid); drop function app_private.has_verified_authenticator(uuid);
-- drop table public.mfa_recovery_codes;
