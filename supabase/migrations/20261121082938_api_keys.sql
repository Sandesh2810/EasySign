-- D-90 (Phase 5 slice 1, AT5.1): API keys and the core API. A key belongs to a workspace and acts as the person who
-- created it (their role, their daily caps). It is shown once; only its SHA-256 is stored. It stops working when
-- revoked, when its creator leaves the workspace, or when the creator or workspace is suspended. Idempotency keys make
-- every write safe to retry. New objects only.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  prefix text not null check (prefix ~ '^ynms_[A-Za-z0-9_-]{7}$'),
  key_sha256 text not null unique check (key_sha256 ~ '^[0-9a-f]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 3 and scopes <@ array['documents:read', 'documents:write', 'documents:send']),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null
);
create index api_keys_org_idx on public.api_keys (org_id) where revoked_at is null;

create table public.api_idempotency (
  key_id uuid not null references public.api_keys (id) on delete cascade,
  idem_key text not null check (char_length(idem_key) between 1 and 200),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  status_code int check (status_code between 100 and 599),
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (key_id, idem_key)
);

do $$
declare t text;
begin
  foreach t in array array['api_keys', 'api_idempotency'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end
$$;

-- owners and administrators manage a workspace's keys (true or false, never NULL)
create function app_private.api_key_admin(p_actor uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_actor is not null and app_private.member_role(p_actor, p_org) in ('owner', 'admin'), false)
$$;
revoke all on function app_private.api_key_admin(uuid, uuid) from public, anon, authenticated, service_role;

create function public.create_api_key(p_actor uuid, p_org uuid, p_name text, p_scopes text[], p_prefix text, p_key_sha256 text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_scopes text[];
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, p_org);
  if p_name is null or btrim(p_name) = '' or char_length(btrim(p_name)) > 80 then
    raise exception 'ES_NAME: give the key a name of up to 80 characters' using errcode = '22023';
  end if;
  select array_agg(distinct s order by s) into v_scopes from unnest(coalesce(p_scopes, '{}')) s;
  if v_scopes is null or not (v_scopes <@ array['documents:read', 'documents:write', 'documents:send']) then
    raise exception 'ES_SCOPES: choose what the key may do' using errcode = '22023';
  end if;
  if (select count(*) from public.api_keys k where k.org_id = p_org and k.revoked_at is null) >= 10 then
    raise exception 'ES_TOO_MANY: a workspace can have up to 10 active API keys; revoke one first' using errcode = '22023';
  end if;
  insert into public.api_keys (org_id, created_by, name, prefix, key_sha256, scopes)
    values (p_org, p_actor, btrim(p_name), p_prefix, p_key_sha256, v_scopes) returning id into v_id;
  perform app_private.audit_append('org:' || p_org::text, p_org, null, null, 'user', p_actor, 'api_key_created',
    jsonb_build_object('key_id', v_id, 'name', btrim(p_name), 'prefix', p_prefix, 'scopes', to_jsonb(v_scopes)));
  return v_id;
end
$$;

create function public.revoke_api_key(p_actor uuid, p_key_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k public.api_keys;
begin
  select * into k from public.api_keys x where x.id = p_key_id for update;
  if not found or not app_private.api_key_admin(p_actor, k.org_id) then
    raise exception 'ES_NOT_FOUND: key not found' using errcode = '42501';
  end if;
  if k.revoked_at is not null then return; end if;
  update public.api_keys x set revoked_at = now(), revoked_by = p_actor where x.id = k.id;
  perform app_private.audit_append('org:' || k.org_id::text, k.org_id, null, null, 'user', p_actor, 'api_key_revoked',
    jsonb_build_object('key_id', k.id, 'name', k.name, 'prefix', k.prefix));
end
$$;

create function public.api_key_list(p_actor uuid, p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app_private.api_key_admin(p_actor, p_org) then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix, 'scopes', to_jsonb(k.scopes), 'created_at', k.created_at,
             'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
             'created_by_name', (select coalesce(nullif(btrim(p.display_name), ''), 'Unknown') from public.profiles p where p.id = k.created_by))
           order by k.revoked_at nulls first, k.created_at desc)
      from public.api_keys k where k.org_id = p_org), '[]'::jsonb);
end
$$;

-- who is calling: a live key whose creator is still an active member and neither they nor the workspace is suspended
create function public.api_key_resolve(p_key_sha256 text)
returns table (key_id uuid, org_id uuid, user_id uuid, scopes text[], role text)
language plpgsql security definer set search_path = '' as $$
declare
  k public.api_keys;
  v_role text;
begin
  if p_key_sha256 !~ '^[0-9a-f]{64}$' then return; end if;
  select * into k from public.api_keys x where x.key_sha256 = p_key_sha256 and x.revoked_at is null;
  if not found then return; end if;
  v_role := app_private.member_role(k.created_by, k.org_id);
  if v_role is null
     or exists (select 1 from public.account_controls c where c.user_id = k.created_by and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = k.org_id and o.status = 'suspended') then
    return;
  end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys x set last_used_at = now() where x.id = k.id;
  end if;
  return query select k.id, k.org_id, k.created_by, k.scopes, v_role;
end
$$;

-- idempotency: 'new' (go ahead), 'done' (replay the stored answer), 'in_progress', or 'mismatch' (same key, other request)
create function public.api_idem_begin(p_key_id uuid, p_idem text, p_request_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.api_idempotency;
begin
  delete from public.api_idempotency x where x.key_id = p_key_id and x.created_at < now() - interval '24 hours';
  insert into public.api_idempotency (key_id, idem_key, request_sha256) values (p_key_id, p_idem, p_request_sha256)
    on conflict (key_id, idem_key) do nothing;
  if found then return jsonb_build_object('state', 'new'); end if;
  select * into r from public.api_idempotency x where x.key_id = p_key_id and x.idem_key = p_idem for update;
  if r.request_sha256 <> p_request_sha256 then return jsonb_build_object('state', 'mismatch'); end if;
  if r.status_code is not null then return jsonb_build_object('state', 'done', 'status', r.status_code, 'body', r.response); end if;
  if r.created_at > now() - interval '5 minutes' then return jsonb_build_object('state', 'in_progress'); end if;
  update public.api_idempotency x set created_at = now() where x.key_id = p_key_id and x.idem_key = p_idem;   -- a crashed attempt: take over
  return jsonb_build_object('state', 'new');
end
$$;

create function public.api_idem_finish(p_key_id uuid, p_idem text, p_status int, p_body jsonb) returns void
language sql security definer set search_path = '' as $$
  update public.api_idempotency x set status_code = p_status, response = p_body where x.key_id = p_key_id and x.idem_key = p_idem
$$;

-- a document as the API shows it, to someone who may handle it in this workspace
create function public.api_document_view(p_actor uuid, p_org uuid, p_envelope_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  e public.envelopes;
begin
  select * into e from public.envelopes x where x.id = p_envelope_id;
  if not found or e.org_id <> p_org or e.deleted_at is not null or not app_private.may_handle_envelope(p_actor, e.org_id, e.sender_id, 'viewer') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  return jsonb_build_object('id', e.id, 'title', e.title, 'status', e.status, 'delivery', e.delivery, 'verification_code', e.public_code,
    'created_at', e.created_at, 'sent_at', e.sent_at, 'completed_at', e.completed_at, 'expires_at', e.expires_at,
    'sealed', e.sealed_storage_path is not null,
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'email', r.email, 'role', r.role, 'order', r.routing_order,
                         'status', r.status, 'completed_at', r.completed_at) order by r.routing_order, r.created_at)
                        from public.recipients r where r.envelope_id = e.id), '[]'::jsonb));
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.create_api_key(uuid, uuid, text, text[], text, text)',
    'public.revoke_api_key(uuid, uuid)',
    'public.api_key_list(uuid, uuid)',
    'public.api_key_resolve(text)',
    'public.api_idem_begin(uuid, text, text)',
    'public.api_idem_finish(uuid, text, int, jsonb)',
    'public.api_document_view(uuid, uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- drop function public.api_document_view(uuid, uuid, uuid); drop function public.api_idem_finish(uuid, text, int, jsonb);
-- drop function public.api_idem_begin(uuid, text, text); drop function public.api_key_resolve(text);
-- drop function public.api_key_list(uuid, uuid); drop function public.revoke_api_key(uuid, uuid);
-- drop function public.create_api_key(uuid, uuid, text, text[], text, text); drop function app_private.api_key_admin(uuid, uuid);
-- drop table public.api_idempotency; drop table public.api_keys;
