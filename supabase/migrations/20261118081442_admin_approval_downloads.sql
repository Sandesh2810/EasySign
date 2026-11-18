-- EasySign Phase 1 / migration 9: the minimum an administrator needs while registration is in
-- "approval" mode (list accounts, approve or un-approve one), and download events for the audit trail.
-- All functions are server-only (service role) and take the acting user explicitly (D-35).

-- An administrator is a platform admin whose own account is not suspended. Anyone else gets the same
-- answer as for a page that does not exist.
create function app_private.require_admin(p_actor uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (
       select 1 from public.account_controls c
        where c.user_id = p_actor and c.is_platform_admin and c.trust_level <> 'suspended') then
    raise exception 'ES_NOT_FOUND: page not found' using errcode = '42501';
  end if;
end
$$;

create function public.admin_list_accounts(p_actor uuid)
returns table (account_id uuid, account_email text, display_name text, is_approved boolean, trust text, is_admin boolean,
               email_confirmed boolean, request_status text, registered_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_admin(p_actor);
  return query
    select c.user_id, u.email::text, coalesce(p.display_name, ''), c.approved, c.trust_level, c.is_platform_admin,
           u.email_confirmed_at is not null, q.status, c.created_at
      from public.account_controls c
      join auth.users u on u.id = c.user_id
      left join public.profiles p on p.id = c.user_id
      left join public.registration_requests q on q.user_id = c.user_id
     order by c.approved, c.created_at desc
     limit 200;
end
$$;

-- Approve (or take approval away from) one account. Approval lets the account send documents to other
-- people; it does not lift the new-account daily caps.
create function public.admin_set_approval(p_actor uuid, p_user uuid, p_approved boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ctl public.account_controls;
  v_org uuid;
begin
  perform app_private.require_admin(p_actor);
  if p_approved is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into v_ctl from public.account_controls c where c.user_id = p_user for update;
  if not found then
    raise exception 'ES_NOT_FOUND: account not found' using errcode = '42501';
  end if;
  if v_ctl.is_platform_admin and not p_approved then
    raise exception 'ES_ADMIN_ACCOUNT: an administrator account cannot have its approval removed here' using errcode = '42501';
  end if;
  if p_approved and not exists (select 1 from auth.users u where u.id = p_user and u.email_confirmed_at is not null) then
    raise exception 'ES_UNCONFIRMED: this person has not confirmed their email address yet' using errcode = '42501';
  end if;
  if v_ctl.approved = p_approved then
    return;
  end if;
  update public.account_controls c set approved = p_approved where c.user_id = p_user;
  update public.registration_requests q
     set status = case when p_approved then 'approved' else 'rejected' end, decided_by = p_actor, decided_at = now()
   where q.user_id = p_user;
  select m.org_id into v_org from public.memberships m where m.user_id = p_user and m.role = 'owner' limit 1;
  if v_org is not null then
    perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'admin', p_actor,
      case when p_approved then 'account_approved' else 'account_approval_removed' end, jsonb_build_object('user_id', p_user));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_org, p_user, case when p_approved then 'account_approved' else 'account_approval_removed' end, '{}'::jsonb);
  end if;
end
$$;

-- A download of the completed file or its certificate, by a workspace member (p_actor) or by a signer
-- through their link (p_token_id). Exactly one of the two is given.
create function public.record_download(p_actor uuid, p_token_id uuid, p_envelope_id uuid, p_part text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_tok public.recipient_tokens;
begin
  if p_part not in ('sealed', 'certificate') or (p_actor is null) = (p_token_id is null) then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or v_env.status <> 'completed' then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if p_actor is not null then
    if not app_private.is_member_of(p_actor, v_env.org_id, 'viewer') then
      raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
    end if;
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'document_downloaded',
      jsonb_build_object('part', p_part), p_ip, p_user_agent);
  else
    select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
    if not found or v_tok.envelope_id <> p_envelope_id or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
      raise exception 'ES_LINK_INVALID: this link is no longer valid' using errcode = '42501';
    end if;
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, v_tok.recipient_id, 'signer', null, 'document_downloaded',
      jsonb_build_object('part', p_part), p_ip, p_user_agent);
  end if;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.admin_list_accounts(uuid)',
    'public.admin_set_approval(uuid, uuid, boolean)',
    'public.record_download(uuid, uuid, uuid, text, inet, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  revoke all on function app_private.require_admin(uuid) from public, anon, authenticated, service_role;
end
$$;

-- down (manual):
-- drop function if exists public.record_download(uuid, uuid, uuid, text, inet, text), public.admin_set_approval(uuid, uuid, boolean),
--   public.admin_list_accounts(uuid), app_private.require_admin(uuid);
