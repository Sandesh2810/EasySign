-- EasySign Phase 1 / migration 2: helper functions, audit chain, guards, account bootstrap, envelope creation.
-- All functions pin search_path = '' and are created with no EXECUTE for PUBLIC (see migration 1);
-- grants are explicit in migration 3. Down script at the bottom (commented).

-- ---------- small helpers ----------
create function app_private.role_rank(p_role text) returns int
language sql immutable set search_path = '' as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end
$$;

-- Used by RLS policies. SECURITY DEFINER so it can read memberships without recursing into RLS.
create function app_private.is_org_member(p_org uuid, p_min_role text default 'viewer') returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
      and app_private.role_rank(m.role) >= app_private.role_rank(p_min_role)
  )
$$;

-- Sanctioned functions mark their transaction; guard triggers refuse state changes that are not marked.
-- Clients cannot set this: the REST API offers no way to run SET, and no exposed function sets it from user input.
create function app_private.sanction() returns void
language sql set search_path = '' as $$ select set_config('easysign.sanctioned', 'on', true) $$;

create function app_private.is_sanctioned() returns boolean
language sql stable set search_path = '' as $$ select coalesce(current_setting('easysign.sanctioned', true), '') = 'on' $$;

-- ---------- public verification code (D-32) ----------
-- ES-YYMM-XXXX-XXXX-XXXX-CC : 60 random bits (pgcrypto CSPRNG) + 10 check bits = first 10 bits of
-- SHA-256('ES' || YYMM || payload). Must stay identical to src/lib/public-code.ts (cross-checked by a test).
create function app_private.gen_public_code(p_at timestamptz default now()) returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bits bit(64) := ('x' || encode(extensions.gen_random_bytes(8), 'hex'))::bit(64);
  yymm text := to_char(p_at at time zone 'UTC', 'YYMM');
  payload text := '';
  chk bit(16);
  cc text := '';
begin
  for i in 0..11 loop
    payload := payload || substr(alphabet, substring(bits from 1 + 5 * i for 5)::int + 1, 1);
  end loop;
  chk := ('x' || encode(substring(sha256(convert_to('ES' || yymm || payload, 'UTF8')) from 1 for 2), 'hex'))::bit(16);
  for i in 0..1 loop
    cc := cc || substr(alphabet, substring(chk from 1 + 5 * i for 5)::int + 1, 1);
  end loop;
  return 'ES-' || yymm || '-' || substr(payload, 1, 4) || '-' || substr(payload, 5, 4) || '-' || substr(payload, 9, 4) || '-' || cc;
end
$$;

-- ---------- audit chain (D-25) ----------
create function app_private.audit_canonical(
  p_chain_key text, p_chain_seq int, p_id uuid, p_org_id uuid, p_envelope_id uuid, p_recipient_id uuid,
  p_actor_type text, p_actor_id uuid, p_event_type text, p_payload jsonb, p_ip inet, p_user_agent text, p_created_at timestamptz
) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'v', 1,
    'chain_key', p_chain_key,
    'chain_seq', p_chain_seq,
    'id', p_id,
    'org_id', p_org_id,
    'envelope_id', p_envelope_id,
    'recipient_id', p_recipient_id,
    'actor_type', p_actor_type,
    'actor_id', p_actor_id,
    'event_type', p_event_type,
    'payload', coalesce(p_payload, '{}'::jsonb),
    'ip', host(p_ip),
    'user_agent', p_user_agent,
    'created_at', to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
$$;

-- The only way a row enters audit_events. Per-chain advisory lock => gapless sequence, no forks.
create function app_private.audit_append(
  p_chain_key text, p_org_id uuid, p_envelope_id uuid, p_recipient_id uuid,
  p_actor_type text, p_actor_id uuid, p_event_type text, p_payload jsonb default '{}'::jsonb,
  p_ip inet default null, p_user_agent text default null
) returns public.audit_events
language plpgsql security definer set search_path = '' as $$
declare
  v_prev bytea;
  v_seq int;
  v_prev_ts timestamptz;
  v_ts timestamptz;
  v_id uuid := gen_random_uuid();
  v_canon text;
  v_row public.audit_events;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_chain_key, 0));
  select e.event_hash, e.chain_seq, e.created_at into v_prev, v_seq, v_prev_ts
    from public.audit_events e where e.chain_key = p_chain_key order by e.chain_seq desc limit 1;
  if not found then
    v_prev := decode(repeat('00', 32), 'hex');
    v_seq := 0;
  end if;
  v_ts := clock_timestamp();
  if v_prev_ts is not null and v_ts <= v_prev_ts then
    v_ts := v_prev_ts + interval '1 microsecond';
  end if;
  v_canon := app_private.audit_canonical(p_chain_key, v_seq + 1, v_id, p_org_id, p_envelope_id, p_recipient_id,
    p_actor_type, p_actor_id, p_event_type, p_payload, p_ip, left(p_user_agent, 500), v_ts)::text;
  insert into public.audit_events (id, chain_key, chain_seq, org_id, envelope_id, recipient_id, actor_type, actor_id,
    event_type, payload, ip, user_agent, created_at, canonical, prev_hash, event_hash)
  values (v_id, p_chain_key, v_seq + 1, p_org_id, p_envelope_id, p_recipient_id, p_actor_type, p_actor_id,
    p_event_type, coalesce(p_payload, '{}'::jsonb), p_ip, left(p_user_agent, 500), v_ts, v_canon, v_prev,
    sha256(v_prev || convert_to(v_canon, 'UTF8')))
  returning * into v_row;
  return v_row;
end
$$;

-- In-database verifier (nightly job + tests). Mirrors src/lib/audit-chain.ts.
create function app_private.audit_verify(p_chain_key text)
returns table (ok boolean, events int, broken_seq int, reason text, head text)
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.audit_events;
  v_prev bytea := decode(repeat('00', 32), 'hex');
  v_n int := 0;
begin
  for r in select * from public.audit_events e where e.chain_key = p_chain_key order by e.chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_n then
      return query select false, v_n - 1, r.chain_seq, 'sequence gap'::text, encode(v_prev, 'hex'); return;
    end if;
    if r.prev_hash <> v_prev then
      return query select false, v_n - 1, r.chain_seq, 'prev link does not match the previous event'::text, encode(v_prev, 'hex'); return;
    end if;
    if sha256(v_prev || convert_to(r.canonical, 'UTF8')) <> r.event_hash then
      return query select false, v_n - 1, r.chain_seq, 'event hash does not match the stored text'::text, encode(v_prev, 'hex'); return;
    end if;
    if r.canonical::jsonb is distinct from app_private.audit_canonical(r.chain_key, r.chain_seq, r.id, r.org_id, r.envelope_id,
        r.recipient_id, r.actor_type, r.actor_id, r.event_type, r.payload, r.ip, r.user_agent, r.created_at) then
      return query select false, v_n - 1, r.chain_seq, 'a column disagrees with the hashed text'::text, encode(v_prev, 'hex'); return;
    end if;
    v_prev := r.event_hash;
  end loop;
  return query select true, v_n, null::int, null::text, encode(v_prev, 'hex');
end
$$;

create function app_private.audit_block() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end
$$;

create trigger audit_no_update_delete before update or delete on public.audit_events
  for each row execute function app_private.audit_block();
create trigger audit_no_truncate before truncate on public.audit_events
  for each statement execute function app_private.audit_block();

-- ---------- guards ----------
create function app_private.envelopes_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_allowed text[];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and not app_private.is_sanctioned() then
      raise exception 'only draft envelopes can be deleted' using errcode = '42501';
    end if;
    return old;
  end if;

  if new.id <> old.id or new.org_id <> old.org_id or new.sender_id <> old.sender_id
     or new.public_code <> old.public_code or new.created_at <> old.created_at then
    raise exception 'immutable envelope column' using errcode = '42501';
  end if;

  if old.status in ('completed', 'declined', 'voided', 'expired') then
    v_allowed := array['folder_id', 'legal_hold', 'updated_at'];   -- terminal: nothing else, ever
  elsif app_private.is_sanctioned() then
    new.updated_at := now();
    return new;
  elsif old.status = 'draft' then
    v_allowed := array['title', 'message', 'folder_id', 'expires_at', 'routing_mode', 'legal_hold', 'updated_at'];
  else
    v_allowed := array['folder_id', 'legal_hold', 'updated_at'];
  end if;

  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'envelope is % and that change is not allowed', old.status using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create trigger envelopes_guard before update or delete on public.envelopes
  for each row execute function app_private.envelopes_guard();

-- Documents, recipients and fields: tenant comes from the envelope (cannot be spoofed) and
-- everything freezes once the envelope leaves draft (D-26).
create function app_private.envelope_child_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_env uuid;
  v_org uuid;
  v_status text;
begin
  if tg_op = 'DELETE' then v_env := old.envelope_id; else v_env := new.envelope_id; end if;
  select e.org_id, e.status into v_org, v_status from public.envelopes e where e.id = v_env;
  if not found then
    if tg_op = 'DELETE' then return old; end if;   -- parent already removed by cascade
    raise exception 'envelope not found' using errcode = '23503';
  end if;
  if v_status <> 'draft' and not app_private.is_sanctioned() then
    raise exception 'documents, recipients and fields are frozen once an envelope is sent' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' and new.envelope_id <> old.envelope_id then
    raise exception 'rows cannot move between envelopes' using errcode = '42501';
  end if;
  new.org_id := v_org;
  if tg_table_name = 'fields' then
    if not exists (select 1 from public.envelope_documents d where d.id = new.document_id and d.envelope_id = new.envelope_id)
       or not exists (select 1 from public.recipients r where r.id = new.recipient_id and r.envelope_id = new.envelope_id) then
      raise exception 'field must reference a document and recipient of the same envelope' using errcode = '23503';
    end if;
  end if;
  return new;
end
$$;

create trigger envelope_documents_guard before insert or update or delete on public.envelope_documents
  for each row execute function app_private.envelope_child_guard();
create trigger recipients_guard before insert or update or delete on public.recipients
  for each row execute function app_private.envelope_child_guard();
create trigger fields_guard before insert or update or delete on public.fields
  for each row execute function app_private.envelope_child_guard();

create function app_private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;
create trigger profiles_touch before update on public.profiles for each row execute function app_private.touch_updated_at();

-- ---------- account bootstrap ----------
-- Runs for every new auth user (email, Google, Microsoft). Creates profile, controls, workspace, owner membership.
create function app_private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_mode text;
  v_name text;
  v_email text := lower(coalesce(new.email, ''));
  v_admin_email text;
  v_is_bootstrap_admin boolean := false;
begin
  select s.value #>> '{}' into v_mode from public.platform_settings s where s.key = 'registration_mode';
  v_mode := coalesce(v_mode, 'open');
  select lower(s.value #>> '{}') into v_admin_email from public.platform_settings s where s.key = 'bootstrap_admin_email';

  if exists (select 1 from public.disposable_email_domains d where d.domain = split_part(v_email, '@', 2)) then
    raise exception 'registration is not available for this email domain' using errcode = '42501';
  end if;

  -- The bootstrap admin is named in platform_settings by the operator and must arrive with a provider-verified email.
  v_is_bootstrap_admin := v_admin_email is not null and v_admin_email <> '' and v_email = v_admin_email and new.email_confirmed_at is not null;

  if v_mode = 'invite_only' and not v_is_bootstrap_admin
     and not exists (select 1 from public.registration_requests q where lower(q.email) = v_email and q.status = 'invited') then
    raise exception 'registration is by invitation only' using errcode = '42501';
  end if;

  v_name := left(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(v_email, '@', 1), ''),
    'New user'), 100);

  insert into public.profiles (id, display_name) values (new.id, v_name);
  insert into public.account_controls (user_id, approved, is_platform_admin, trust_level, admin_trusted)
    values (new.id, v_mode = 'open' or v_is_bootstrap_admin, v_is_bootstrap_admin,
            case when v_is_bootstrap_admin then 'trusted' else 'restricted' end, v_is_bootstrap_admin);
  insert into public.organizations (name, created_by) values (v_name || '''s workspace', new.id) returning id into v_org;
  insert into public.org_controls (org_id) values (v_org);
  insert into public.memberships (org_id, user_id, role) values (v_org, new.id, 'owner');
  insert into public.org_settings (org_id) values (v_org);
  insert into public.folders (org_id, name, created_by) values (v_org, 'Completed', new.id);

  if v_mode = 'approval' and not v_is_bootstrap_admin then
    insert into public.registration_requests (user_id, email, status) values (new.id, v_email, 'pending')
      on conflict (user_id) do nothing;
  elsif v_mode = 'invite_only' then
    update public.registration_requests q set user_id = new.id, status = 'approved', decided_at = now()
      where lower(q.email) = v_email and q.status = 'invited';
  end if;

  perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'user', new.id, 'account_registered',
    jsonb_build_object('provider', coalesce(new.raw_app_meta_data ->> 'provider', 'email'), 'mode', v_mode,
                       'approved', v_mode = 'open' or v_is_bootstrap_admin));
  return new;
end
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ---------- envelope creation (logged-in members) ----------
create function public.create_envelope(p_org_id uuid, p_title text, p_folder_id uuid default null)
returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_env public.envelopes;
  v_code text;
  v_tries int := 0;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not app_private.is_org_member(p_org_id, 'member') then
    raise exception 'not a member of this workspace' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = v_uid and c.trust_level = 'suspended')
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
        values (p_org_id, v_uid, p_folder_id, v_code, btrim(p_title))
        returning * into v_env;
      exit;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 5 then raise; end if;
    end;
  end loop;
  perform app_private.audit_append('env:' || v_env.id::text, p_org_id, v_env.id, null, 'user', v_uid, 'envelope_created',
    jsonb_build_object('title', v_env.title, 'public_code', v_env.public_code));
  return v_env;
end
$$;

-- down (manual):
-- drop function if exists public.create_envelope(uuid, text, uuid);
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop trigger if exists profiles_touch on public.profiles;
-- drop trigger if exists fields_guard on public.fields;
-- drop trigger if exists recipients_guard on public.recipients;
-- drop trigger if exists envelope_documents_guard on public.envelope_documents;
-- drop trigger if exists envelopes_guard on public.envelopes;
-- drop trigger if exists audit_no_truncate on public.audit_events;
-- drop trigger if exists audit_no_update_delete on public.audit_events;
-- drop function if exists app_private.handle_new_user(), app_private.touch_updated_at(), app_private.envelope_child_guard(),
--   app_private.envelopes_guard(), app_private.audit_block(), app_private.audit_verify(text),
--   app_private.audit_append(text, uuid, uuid, uuid, text, uuid, text, jsonb, inet, text),
--   app_private.audit_canonical(text, int, uuid, uuid, uuid, uuid, text, uuid, text, jsonb, inet, text, timestamptz),
--   app_private.gen_public_code(timestamptz), app_private.is_sanctioned(), app_private.sanction(),
--   app_private.is_org_member(uuid, text), app_private.role_rank(text);
