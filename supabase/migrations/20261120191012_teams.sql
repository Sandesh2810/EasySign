-- YouNMeSign Phase 4 slice 1: teams (D-75). Several people per workspace with four roles:
--   owner  - everything; admin - invites and manages members/viewers, sees and handles every document;
--   member - sends documents and handles only the documents they sent; viewer - reads every document, changes nothing.
-- * memberships can be deactivated (kept for the record; the person loses all access to that workspace at once).
-- * One rule decides who may handle a document: app_private.may_handle_envelope(user, org, sender, minimum role).
--   It is used by the read rules (RLS) and by every server function that acts on a document.
-- * Invitations: a one-time link (only its SHA-256 is stored), 7 days, only for the email address it names.
-- Down script at the bottom (commented).

-- ---------- memberships: deactivation and who invited ----------
alter table public.memberships
  add column deactivated_at timestamptz,
  add column deactivated_by uuid references auth.users (id) on delete set null,
  add column invited_by uuid references auth.users (id) on delete set null;

-- ---------- membership checks ignore deactivated people ----------
create or replace function app_private.is_member_of(p_user uuid, p_org uuid, p_min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = p_user and m.deactivated_at is null
      and app_private.role_rank(m.role) >= app_private.role_rank(p_min_role)
  )
$$;

create or replace function app_private.is_org_member(p_org uuid, p_min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
      and m.deactivated_at is null
      and app_private.role_rank(m.role) >= app_private.role_rank(p_min_role)
  )
$$;

-- The person's active role in a workspace, or null.
create function app_private.member_role(p_user uuid, p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
   where m.org_id = p_org and m.user_id = p_user and m.deactivated_at is null
$$;

-- May this person handle a document of this workspace sent by p_sender? Owner, admin and viewer: any document
-- (the minimum role still applies, so a viewer never passes 'member'); member: only documents they sent.
create function app_private.may_handle_envelope(p_user uuid, p_org uuid, p_sender uuid, p_min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select app_private.role_rank(r.role) >= app_private.role_rank(p_min_role)
           and (r.role <> 'member' or p_sender = p_user)
      from (select app_private.member_role(p_user, p_org) as role) r
     where r.role is not null), false)
$$;

-- For the read rules (signed-in user = auth.uid()).
create function app_private.can_see_envelope(p_org uuid, p_sender uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app_private.may_handle_envelope((select auth.uid()), p_org, p_sender, 'viewer')
$$;

create function app_private.can_see_envelope_id(p_envelope uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select app_private.may_handle_envelope((select auth.uid()), e.org_id, e.sender_id, 'viewer')
                     from public.envelopes e where e.id = p_envelope), false)
$$;

-- Workspace-wide records (events not tied to one document): owner, admin and viewer only.
create function app_private.sees_whole_org(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.member_role((select auth.uid()), p_org) in ('owner', 'admin', 'viewer'), false)
$$;

revoke all on function app_private.member_role(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function app_private.may_handle_envelope(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function app_private.can_see_envelope(uuid, uuid) from public, anon, service_role;
revoke all on function app_private.can_see_envelope_id(uuid) from public, anon, service_role;
revoke all on function app_private.sees_whole_org(uuid) from public, anon, service_role;
grant execute on function app_private.can_see_envelope(uuid, uuid) to authenticated;
grant execute on function app_private.can_see_envelope_id(uuid) to authenticated;
grant execute on function app_private.sees_whole_org(uuid) to authenticated;

-- ---------- read rules: a member sees only the documents they sent ----------
drop policy envelopes_select on public.envelopes;
create policy envelopes_select on public.envelopes for select to authenticated
  using (app_private.can_see_envelope(org_id, sender_id));
drop policy envelope_documents_select on public.envelope_documents;
create policy envelope_documents_select on public.envelope_documents for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy recipients_select on public.recipients;
create policy recipients_select on public.recipients for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy fields_select on public.fields;
create policy fields_select on public.fields for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy field_values_select on public.field_values;
create policy field_values_select on public.field_values for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy consents_select on public.consents;
create policy consents_select on public.consents for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy seal_jobs_select on public.seal_jobs;
create policy seal_jobs_select on public.seal_jobs for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy sender_tasks_select on public.sender_tasks;
create policy sender_tasks_select on public.sender_tasks for select to authenticated
  using (app_private.can_see_envelope_id(envelope_id));
drop policy audit_events_select on public.audit_events;
create policy audit_events_select on public.audit_events for select to authenticated
  using (org_id is not null and case when envelope_id is null then app_private.sees_whole_org(org_id)
                                     else app_private.can_see_envelope_id(envelope_id) end);
drop policy audit_archives_select on public.audit_archives;
create policy audit_archives_select on public.audit_archives for select to authenticated
  using (org_id is not null and case when envelope_id is null then app_private.sees_whole_org(org_id)
                                     else app_private.can_see_envelope_id(envelope_id) end);
drop policy signature_assets_select on public.signature_assets;
create policy signature_assets_select on public.signature_assets for select to authenticated
  using (owner_user_id = (select auth.uid())
         or (org_id is not null and app_private.sees_whole_org(org_id))
         or exists (select 1 from public.field_values v
                     where v.signature_asset_id = signature_assets.id and app_private.can_see_envelope_id(v.envelope_id)));

-- ---------- server functions: the same rule ----------
create or replace function app_private.require_draft(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    -- same answer for "does not exist" and "not yours": no probing for ids
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status <> 'draft' then
    raise exception 'ES_NOT_DRAFT: this document has already been sent and can no longer be edited' using errcode = '42501';
  end if;
  return v_env;
end
$$;

create or replace function app_private.require_open_envelope(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status = 'completed' then
    raise exception 'ES_COMPLETED: this document is complete and can no longer be changed' using errcode = '42501';
  end if;
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open, so there is nothing to change' using errcode = '42501';
  end if;
  if exists (select 1 from public.seal_jobs j where j.envelope_id = p_envelope_id) then
    raise exception 'ES_SEALING: everyone has finished and the final document is being prepared. It can no longer be changed' using errcode = '42501';
  end if;
  return v_env;
end
$$;

create or replace function public.complete_sender_task(p_actor uuid, p_task_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.sender_tasks;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_task from public.sender_tasks t where t.id = p_task_id for update;
  if not found or not app_private.may_handle_envelope(p_actor, v_task.org_id,
       (select e.sender_id from public.envelopes e where e.id = v_task.envelope_id), 'member') then
    raise exception 'ES_NOT_FOUND: task not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_task.done_at is not null then
    return 'already_done';
  end if;
  update public.sender_tasks t set done_at = now(), done_by = p_actor where t.id = p_task_id;
  perform app_private.audit_append('env:' || v_task.envelope_id::text, v_task.org_id, v_task.envelope_id, v_task.recipient_id, 'user', p_actor,
    'sender_task_done', jsonb_build_object('task_id', v_task.id, 'kind', v_task.kind));
  return 'done';
end
$$;

create or replace function public.move_to_folder(p_actor uuid, p_envelope_id uuid, p_folder_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or p_actor is null or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if p_folder_id is not null and not exists (select 1 from public.folders f where f.id = p_folder_id and f.org_id = v_env.org_id) then
    raise exception 'ES_NOT_FOUND: folder not found' using errcode = '42501';
  end if;
  if v_env.folder_id is not distinct from p_folder_id then
    return false;
  end if;
  update public.envelopes e set folder_id = p_folder_id where e.id = p_envelope_id;
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'user', p_actor, 'envelope_moved',
    jsonb_build_object('folder_id', p_folder_id));
  return true;
end
$$;

create or replace function public.record_audit_export(p_actor uuid, p_envelope_id uuid, p_format text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_format not in ('json', 'pdf') then
    raise exception 'ES_INVALID: unknown format' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or v_env.status = 'draft' or p_actor is null or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'viewer') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'audit_exported',
    jsonb_build_object('format', p_format), p_ip, left(p_user_agent, 500));
end
$$;

create or replace function public.record_download(p_actor uuid, p_token_id uuid, p_envelope_id uuid, p_part text, p_ip inet, p_user_agent text) returns void
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
    if not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'viewer') then
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

create or replace function public.reveal_signing_links(p_actor uuid, p_envelope_id uuid)
returns table (token_id uuid, nonce_hex text, recipient_name text, recipient_role text, recipient_order integer, recipient_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open for signing' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'link_revealed',
    jsonb_build_object('recipients', (select coalesce(jsonb_agg(k.recipient_id order by k.created_at), '[]'::jsonb)
                                        from public.recipient_tokens k where k.envelope_id = p_envelope_id and k.revoked_at is null)));
  return query
    select k.id, encode(k.nonce, 'hex'), x.name, x.role, x.routing_order, x.status
      from public.recipient_tokens k join public.recipients x on x.id = k.recipient_id
     where k.envelope_id = p_envelope_id and k.revoked_at is null
     order by x.routing_order, x.created_at;
end
$$;

-- Search now looks in ONE workspace (the one the person is working in) and applies the same rule.
drop function public.search_envelopes(uuid, text, text, uuid, integer, integer);
create function public.search_envelopes(p_actor uuid, p_org_id uuid, p_query text, p_view text, p_folder_id uuid, p_limit integer default 50, p_offset integer default 0)
returns table (id uuid, title text, status text, public_code text, created_at timestamptz, completed_at timestamptz, expires_at timestamptz,
               folder_id uuid, folder_name text, people text, total_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_like text;
  v_email text;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not app_private.is_member_of(p_actor, p_org_id, 'viewer') then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  if coalesce(p_view, 'all') not in ('all', 'action', 'waiting', 'expiring', 'draft', 'completed', 'closed') then
    raise exception 'unknown view' using errcode = '22023';
  end if;
  if char_length(v_q) > 100 then
    v_q := left(v_q, 100);
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_email := coalesce(app_private.user_email(p_actor), '');
  return query
    with mine as (
      select e.* from public.envelopes e
       where e.org_id = p_org_id
         and app_private.may_handle_envelope(p_actor, e.org_id, e.sender_id, 'viewer')
         and (p_folder_id is null or e.folder_id = p_folder_id)
         and case coalesce(p_view, 'all')
               when 'all' then true
               when 'draft' then e.status = 'draft'
               when 'completed' then e.status = 'completed'
               when 'closed' then e.status in ('declined', 'voided', 'expired')
               when 'waiting' then e.status in ('sent', 'in_progress')
               when 'expiring' then e.status in ('sent', 'in_progress') and e.expires_at is not null and e.expires_at <= now() + interval '3 days'
               when 'action' then e.status in ('sent', 'in_progress') and exists (
                 select 1 from public.recipients x where x.envelope_id = e.id and lower(x.email) = v_email
                    and x.role in ('signer', 'in_person', 'approver') and x.status in ('sent', 'viewed', 'consented'))
             end
         and (v_q = ''
              or lower(e.title) like v_like
              or e.public_code ilike v_like
              or exists (select 1 from public.recipients x where x.envelope_id = e.id and (lower(x.name) like v_like or lower(x.email) like v_like)))
    )
    select e.id, e.title, e.status, e.public_code, e.created_at, e.completed_at, e.expires_at, e.folder_id, f.name,
           (select string_agg(x.name, ', ' order by x.routing_order, x.created_at) from public.recipients x where x.envelope_id = e.id and x.role <> 'cc'),
           count(*) over ()
      from mine e left join public.folders f on f.id = e.folder_id
     order by e.created_at desc, e.id
     limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0));
end
$$;
revoke all on function public.search_envelopes(uuid, uuid, text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.search_envelopes(uuid, uuid, text, text, uuid, integer, integer) to service_role;

-- ---------- invitations ----------
create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  role text not null check (role in ('admin', 'member', 'viewer')),
  token_sha256 bytea not null unique check (octet_length(token_sha256) = 32),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);
create unique index team_invitations_open_idx on public.team_invitations (org_id, email) where accepted_at is null and revoked_at is null;
alter table public.team_invitations enable row level security;
create policy team_invitations_deny_all on public.team_invitations for all to anon, authenticated using (false) with check (false);
revoke all on public.team_invitations from anon, authenticated;
grant select, insert, update, delete on public.team_invitations to service_role;

create function app_private.email_fingerprint(p_email text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') $$;
revoke all on function app_private.email_fingerprint(text) from public, anon, authenticated, service_role;

-- Owner or admin; refuses suspended accounts and workspaces.
create function app_private.require_team_manager(p_actor uuid, p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := app_private.member_role(p_actor, p_org);
begin
  if p_actor is null or v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'ES_NOT_ALLOWED: only the workspace owner or an administrator can manage the team' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = p_org and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  return v_role;
end
$$;
revoke all on function app_private.require_team_manager(uuid, uuid) from public, anon, authenticated, service_role;

create function public.team_invite(p_actor uuid, p_org uuid, p_email text, p_role text, p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := app_private.require_team_manager(p_actor, p_org);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if p_role is null or p_role not in ('admin', 'member', 'viewer') then
    raise exception 'ES_INVALID: unknown role' using errcode = '22023';
  end if;
  if p_role = 'admin' and v_role <> 'owner' then
    raise exception 'ES_NOT_ALLOWED: only the workspace owner can invite an administrator' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'ES_INVALID: that does not look like an email address' using errcode = '22023';
  end if;
  if p_token_sha256 is null or octet_length(p_token_sha256) <> 32 then
    raise exception 'invalid token' using errcode = '22023';
  end if;
  if exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
              where m.org_id = p_org and lower(u.email) = v_email) then
    raise exception 'ES_ALREADY_MEMBER: this person is already in the team (if they were deactivated, reactivate them instead)' using errcode = '23505';
  end if;
  -- a new invitation replaces an open one for the same address
  update public.team_invitations i set revoked_at = now(), revoked_by = p_actor
   where i.org_id = p_org and i.email = v_email and i.accepted_at is null and i.revoked_at is null;
  if (select count(*) from public.memberships m where m.org_id = p_org and m.deactivated_at is null)
     + (select count(*) from public.team_invitations i where i.org_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) >= 25 then
    raise exception 'ES_TEAM_FULL: a team can have up to 25 people, counting open invitations' using errcode = '54000';
  end if;
  insert into public.team_invitations (org_id, email, role, token_sha256, invited_by, expires_at)
  values (p_org, v_email, p_role, p_token_sha256, p_actor, now() + interval '7 days')
  returning id into v_id;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'member_invited',
    jsonb_build_object('invitation_id', v_id, 'role', p_role, 'email_sha256', app_private.email_fingerprint(v_email)));
  return v_id;
end
$$;

create function public.team_accept(p_actor uuid, p_token_sha256 bytea) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.team_invitations;
  v_email text;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_inv from public.team_invitations i where i.token_sha256 = p_token_sha256 for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'ES_INVITE_INVALID: this invitation is not valid any more. Ask for a new one' using errcode = '42501';
  end if;
  v_email := lower(coalesce(app_private.user_email(p_actor), ''));
  if v_email <> v_inv.email then
    raise exception 'ES_INVITE_OTHER_EMAIL: this invitation is for a different email address. Sign in with the address it was sent to' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if exists (select 1 from public.memberships m where m.org_id = v_inv.org_id and m.user_id = p_actor) then
    raise exception 'ES_ALREADY_MEMBER: you are already in this team, or were deactivated there (ask the owner)' using errcode = '23505';
  end if;
  insert into public.memberships (org_id, user_id, role, invited_by) values (v_inv.org_id, p_actor, v_inv.role, v_inv.invited_by);
  update public.team_invitations i set accepted_at = now(), accepted_by = p_actor where i.id = v_inv.id;
  perform app_private.audit_append('org:' || v_inv.org_id::text, v_inv.org_id, null, null, 'user', p_actor, 'member_joined',
    jsonb_build_object('invitation_id', v_inv.id, 'role', v_inv.role));
  return v_inv.org_id;
end
$$;

create function public.team_revoke_invite(p_actor uuid, p_invitation_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.team_invitations;
  v_role text;
begin
  select * into v_inv from public.team_invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: invitation not found' using errcode = '42501';
  end if;
  v_role := app_private.require_team_manager(p_actor, v_inv.org_id);
  if v_inv.role = 'admin' and v_role <> 'owner' then
    raise exception 'ES_NOT_ALLOWED: only the workspace owner can withdraw an administrator invitation' using errcode = '42501';
  end if;
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    return false;
  end if;
  update public.team_invitations i set revoked_at = now(), revoked_by = p_actor where i.id = v_inv.id;
  perform app_private.audit_append('org:' || v_inv.org_id::text, v_inv.org_id, null, null, 'user', p_actor, 'invitation_withdrawn',
    jsonb_build_object('invitation_id', v_inv.id));
  return true;
end
$$;

-- Shared checks for changing another person: not yourself, never the owner, and only the owner touches administrators.
create function app_private.require_manage_member(p_actor uuid, p_org uuid, p_user uuid) returns public.memberships
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := app_private.require_team_manager(p_actor, p_org);
  v_m public.memberships;
begin
  if p_user = p_actor then
    raise exception 'ES_NOT_ALLOWED: you cannot change your own role or access' using errcode = '42501';
  end if;
  select * into v_m from public.memberships m where m.org_id = p_org and m.user_id = p_user for update;
  if not found then
    raise exception 'ES_NOT_FOUND: person not found in this team' using errcode = '42501';
  end if;
  if v_m.role = 'owner' then
    raise exception 'ES_NOT_ALLOWED: the workspace owner cannot be changed' using errcode = '42501';
  end if;
  if v_m.role = 'admin' and v_role <> 'owner' then
    raise exception 'ES_NOT_ALLOWED: only the workspace owner can change an administrator' using errcode = '42501';
  end if;
  return v_m;
end
$$;
revoke all on function app_private.require_manage_member(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create function public.team_set_role(p_actor uuid, p_org uuid, p_user uuid, p_role text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_m public.memberships := app_private.require_manage_member(p_actor, p_org, p_user);
begin
  if p_role is null or p_role not in ('admin', 'member', 'viewer') then
    raise exception 'ES_INVALID: unknown role' using errcode = '22023';
  end if;
  if p_role = 'admin' and app_private.member_role(p_actor, p_org) <> 'owner' then
    raise exception 'ES_NOT_ALLOWED: only the workspace owner can make someone an administrator' using errcode = '42501';
  end if;
  if v_m.deactivated_at is not null then
    raise exception 'ES_NOT_ALLOWED: reactivate this person before changing their role' using errcode = '42501';
  end if;
  if v_m.role = p_role then
    return false;
  end if;
  update public.memberships m set role = p_role where m.org_id = p_org and m.user_id = p_user;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'member_role_changed',
    jsonb_build_object('user_id', p_user, 'from', v_m.role, 'to', p_role));
  return true;
end
$$;

create function public.team_set_active(p_actor uuid, p_org uuid, p_user uuid, p_active boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_m public.memberships := app_private.require_manage_member(p_actor, p_org, p_user);
begin
  if p_active is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  if p_active = (v_m.deactivated_at is null) then
    return false;
  end if;
  if p_active then
    update public.memberships m set deactivated_at = null, deactivated_by = null where m.org_id = p_org and m.user_id = p_user;
  else
    update public.memberships m set deactivated_at = now(), deactivated_by = p_actor where m.org_id = p_org and m.user_id = p_user;
  end if;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor,
    case when p_active then 'member_reactivated' else 'member_deactivated' end, jsonb_build_object('user_id', p_user));
  return true;
end
$$;

-- Everyone active in the team may see who is in it.
create function public.team_members(p_actor uuid, p_org uuid)
returns table (user_id uuid, display_name text, email text, role text, active boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not app_private.is_member_of(p_actor, p_org, 'viewer') then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  return query
    select m.user_id, coalesce(nullif(p.display_name, ''), u.raw_user_meta_data ->> 'full_name', ''), u.email::text, m.role,
           m.deactivated_at is null, m.created_at
      from public.memberships m
      join auth.users u on u.id = m.user_id
      left join public.profiles p on p.id = m.user_id
     where m.org_id = p_org
     order by app_private.role_rank(m.role) desc, m.created_at;
end
$$;

create function public.team_open_invitations(p_actor uuid, p_org uuid)
returns table (id uuid, email text, role text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_team_manager(p_actor, p_org);
  return query
    select i.id, i.email, i.role, i.created_at, i.expires_at from public.team_invitations i
     where i.org_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
     order by i.created_at desc;
end
$$;

-- The workspaces a person can work in right now (own workspace first).
create function public.my_workspaces(p_actor uuid)
returns table (org_id uuid, name text, role text)
language sql stable security definer set search_path = '' as $$
  select m.org_id, o.name, m.role from public.memberships m join public.organizations o on o.id = m.org_id
   where m.user_id = p_actor and m.deactivated_at is null
   order by (m.role = 'owner') desc, m.created_at
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.team_invite(uuid, uuid, text, text, bytea)', 'public.team_accept(uuid, bytea)', 'public.team_revoke_invite(uuid, uuid)',
    'public.team_set_role(uuid, uuid, uuid, text)', 'public.team_set_active(uuid, uuid, uuid, boolean)',
    'public.team_members(uuid, uuid)', 'public.team_open_invitations(uuid, uuid)', 'public.my_workspaces(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- down:
-- drop function public.my_workspaces(uuid); drop function public.team_open_invitations(uuid, uuid); drop function public.team_members(uuid, uuid);
-- drop function public.team_set_active(uuid, uuid, uuid, boolean); drop function public.team_set_role(uuid, uuid, uuid, text);
-- drop function app_private.require_manage_member(uuid, uuid, uuid); drop function public.team_revoke_invite(uuid, uuid);
-- drop function public.team_accept(uuid, bytea); drop function public.team_invite(uuid, uuid, text, text, bytea);
-- drop function app_private.require_team_manager(uuid, uuid); drop function app_private.email_fingerprint(text); drop table public.team_invitations;
-- recreate search_envelopes(uuid, text, text, uuid, integer, integer), the six functions and two gatekeepers with is_member_of (migration 18 and earlier),
-- the read rules with app_private.is_org_member(org_id) (migration 3, 21, 28), is_member_of / is_org_member without the deactivated_at test;
-- drop function app_private.sees_whole_org(uuid), can_see_envelope_id(uuid), can_see_envelope(uuid, uuid), may_handle_envelope(uuid, uuid, uuid, text), member_role(uuid, uuid);
-- alter table public.memberships drop column invited_by, drop column deactivated_by, drop column deactivated_at;
