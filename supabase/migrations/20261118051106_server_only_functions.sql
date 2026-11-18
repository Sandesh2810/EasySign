-- EasySign Phase 1 / migration 4: make state-changing functions server-only (D-35), record explicit
-- deny policies on service-only tables (D-36), add a missing foreign-key index.
-- Down script at the bottom (commented).

create index organizations_created_by_idx on public.organizations (created_by);

-- Membership check for an explicitly named user. Server-only functions use this with the actor id
-- that the server verified from the session; RLS policies keep using is_org_member (auth.uid()).
create function app_private.is_member_of(p_user uuid, p_org uuid, p_min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = p_user
      and app_private.role_rank(m.role) >= app_private.role_rank(p_min_role)
  )
$$;

-- Replace the user-callable version: no SECURITY DEFINER function is reachable by signed-in users over the API.
drop function public.create_envelope(uuid, text, uuid);

create function public.create_envelope(p_actor uuid, p_org_id uuid, p_title text, p_folder_id uuid default null)
returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_code text;
  v_tries int := 0;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not app_private.is_member_of(p_actor, p_org_id, 'member') then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = p_org_id and o.status = 'suspended') then
    raise exception 'account suspended' using errcode = '42501';
  end if;
  if p_folder_id is not null and not exists (select 1 from public.folders f where f.id = p_folder_id and f.org_id = p_org_id) then
    raise exception 'folder not found in this workspace' using errcode = '23503';
  end if;
  loop
    v_code := app_private.gen_public_code();
    begin
      insert into public.envelopes (org_id, sender_id, folder_id, public_code, title)
        values (p_org_id, p_actor, p_folder_id, v_code, btrim(p_title))
        returning * into v_env;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then raise; end if;
    end;
  end loop;
  perform app_private.audit_append('env:' || v_env.id::text, p_org_id, v_env.id, null, 'user', p_actor, 'envelope_created',
    jsonb_build_object('title', v_env.title, 'public_code', v_env.public_code));
  return v_env;
end
$$;

revoke all on function public.create_envelope(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.create_envelope(uuid, uuid, text, uuid) to service_role;
revoke all on function app_private.is_member_of(uuid, uuid, text) from public, anon, authenticated, service_role;

-- Explicit "nobody" policies: these tables are reachable only by the service role.
do $$
declare t text;
begin
  foreach t in array array['org_controls', 'recipient_tokens', 'notification_outbox', 'abuse_reports', 'platform_settings',
    'registration_requests', 'email_budget', 'email_budget_user', 'usage_counters', 'usage_recipients', 'rate_limits',
    'system_health', 'disposable_email_domains'] loop
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
  end loop;
end
$$;

-- down (manual):
-- drop policy <table>_deny_all on public.<table>;  (for each of the thirteen tables above)
-- drop function if exists public.create_envelope(uuid, uuid, text, uuid);
-- drop function if exists app_private.is_member_of(uuid, uuid, text);
-- drop index if exists public.organizations_created_by_idx;
-- then re-create public.create_envelope(uuid, text, uuid) from migration 20261118050720_functions.sql
