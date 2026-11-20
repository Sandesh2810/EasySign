-- YouNMeSign Phase 4 slice 2: templates (AT4.1, D-77).
-- A template is a COPY of a document's file and field layout, with roles ("Tenant", "Landlord") instead of people.
-- * Made from a document ("Save as template"); used to start a new draft, mapping each role to a person.
-- * Fields can be locked in the template; in drafts made from it, locked fields cannot be moved, resized or removed,
--   and the people holding them cannot be removed or given another role (save_fields / save_recipients refuse).
-- * Nothing is shared between a template and the documents made from it: editing or deleting a template never
--   changes a draft or a sent document.
-- * Who: the creator edits their template; a template shared with the team can be used by every member and admin and
--   edited by the owner and administrators as well; viewers neither see nor use templates (D-75).
-- Server-only tables (no access from the browser). Down script at the bottom (commented).

alter table public.fields add column locked boolean not null default false;
alter table public.recipients add column template_role_id uuid;

create table public.templates (
  id uuid primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  shared boolean not null default true,
  routing_mode text not null default 'sequential' check (routing_mode in ('sequential', 'parallel', 'mixed')),
  filename text not null,
  storage_backend text not null check (storage_backend in ('supabase', 'disk')),
  storage_path text not null,
  sha256 text not null,
  page_count int not null check (page_count between 1 and 1000),
  size_bytes bigint not null check (size_bytes > 0),
  page_boxes jsonb not null default '[]'::jsonb,
  source_kind text not null default 'pdf' check (source_kind in ('pdf', 'png', 'jpeg')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index templates_org_idx on public.templates (org_id) where deleted_at is null;

create table public.template_roles (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60 and label = btrim(label)),
  role text not null check (role in ('signer', 'approver', 'cc', 'in_person')),
  routing_order int not null check (routing_order between 1 and 25),
  position int not null,
  unique (template_id, position)
);

create table public.template_fields (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates (id) on delete cascade,
  role_id uuid not null references public.template_roles (id) on delete cascade,
  type text not null,
  page int not null,
  x numeric not null, y numeric not null, w numeric not null, h numeric not null,
  required boolean not null default true,
  options jsonb not null default '{}'::jsonb,
  locked boolean not null default false
);
create index template_fields_template_idx on public.template_fields (template_id);

do $$
declare t text;
begin
  foreach t in array array['templates', 'template_roles', 'template_fields'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end
$$;

-- 'edit', 'use' or null (not visible). Deleted templates and viewers: null.
create function app_private.template_access(p_actor uuid, p_template uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  t public.templates;
  v_role text;
begin
  select * into t from public.templates x where x.id = p_template;
  if not found or t.deleted_at is not null or p_actor is null then return null; end if;
  v_role := app_private.member_role(p_actor, t.org_id);
  if v_role is null or v_role = 'viewer' then return null; end if;
  if t.created_by = p_actor then return 'edit'; end if;
  if not t.shared then return null; end if;
  return case when v_role in ('owner', 'admin') then 'edit' else 'use' end;
end
$$;
revoke all on function app_private.template_access(uuid, uuid) from public, anon, authenticated, service_role;

create function app_private.require_not_suspended(p_actor uuid, p_org uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = p_org and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
end
$$;
revoke all on function app_private.require_not_suspended(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------- create from a document ----------
-- p_labels: [{"recipient_id": ..., "label": "Tenant"}]; people without a label become "Signer 1", "Approver 2", ...
-- The caller has already copied the document's file to p_storage_path = <org>/tpl-<template id>/document.pdf.
create function public.template_create(p_actor uuid, p_template_id uuid, p_envelope_id uuid, p_name text, p_shared boolean,
                                       p_labels jsonb, p_storage_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_doc public.envelope_documents;
  v_name text := btrim(coalesce(p_name, ''));
  v_map jsonb := '{}'::jsonb;
  v_role_id uuid;
  v_label text;
  v_n int := 0;
  r record;
  v_fields int;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') or v_env.deleted_at is not null then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.require_not_suspended(p_actor, v_env.org_id);
  if char_length(v_name) not between 1 and 120 then
    raise exception 'ES_INVALID: give the template a name (up to 120 characters)' using errcode = '22023';
  end if;
  if (select count(*) from public.templates x where x.org_id = v_env.org_id and x.deleted_at is null) >= 100 then
    raise exception 'ES_LIMIT: a workspace can keep up to 100 templates' using errcode = '54000';
  end if;
  if p_storage_path is distinct from v_env.org_id::text || '/tpl-' || p_template_id::text || '/document.pdf' then
    raise exception 'storage path does not belong to this template' using errcode = '42501';
  end if;
  select * into v_doc from public.envelope_documents d where d.envelope_id = p_envelope_id order by d.position limit 1;
  if not found then
    raise exception 'ES_INVALID: this document has no file yet' using errcode = '22023';
  end if;
  if not exists (select 1 from public.recipients x where x.envelope_id = p_envelope_id and x.role in ('signer', 'approver', 'cc', 'in_person')) then
    raise exception 'ES_INVALID: add at least one person before saving a template' using errcode = '22023';
  end if;

  insert into public.templates (id, org_id, created_by, name, shared, routing_mode, filename, storage_backend, storage_path, sha256,
                                page_count, size_bytes, page_boxes, source_kind)
  values (p_template_id, v_env.org_id, p_actor, v_name, coalesce(p_shared, true), v_env.routing_mode, v_doc.filename, v_doc.storage_backend,
          p_storage_path, v_doc.sha256, v_doc.page_count, v_doc.size_bytes, v_doc.page_boxes, 'pdf');

  for r in select x.* from public.recipients x where x.envelope_id = p_envelope_id and x.role in ('signer', 'approver', 'cc', 'in_person')
            order by x.routing_order, x.created_at, x.id loop
    v_n := v_n + 1;
    v_label := btrim(coalesce((select l.value ->> 'label' from jsonb_array_elements(coalesce(p_labels, '[]'::jsonb)) as l(value)
                               where l.value ->> 'recipient_id' = r.id::text limit 1), ''));
    if v_label = '' then
      v_label := initcap(replace(r.role, '_', ' ')) || ' ' || v_n;
    end if;
    if char_length(v_label) > 60 then
      raise exception 'ES_INVALID: role names can be up to 60 characters' using errcode = '22023';
    end if;
    insert into public.template_roles (template_id, label, role, routing_order, position)
    values (p_template_id, v_label, r.role, r.routing_order, v_n) returning id into v_role_id;
    v_map := v_map || jsonb_build_object(r.id::text, v_role_id);
  end loop;

  insert into public.template_fields (template_id, role_id, type, page, x, y, w, h, required, options, locked)
  select p_template_id, (v_map ->> f.recipient_id::text)::uuid, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.options, f.locked
    from public.fields f
   where f.envelope_id = p_envelope_id and f.document_id = v_doc.id and v_map ? f.recipient_id::text;
  get diagnostics v_fields = row_count;

  perform app_private.audit_append('org:' || v_env.org_id::text, v_env.org_id, null, null, 'user', p_actor, 'template_created',
    jsonb_build_object('template_id', p_template_id, 'from_envelope', p_envelope_id, 'roles', v_n, 'fields', v_fields));
  return p_template_id;
end
$$;

-- ---------- edit: name, sharing, role names, which fields are locked ----------
create function public.template_update(p_actor uuid, p_template_id uuid, p_name text, p_shared boolean, p_labels jsonb, p_locked_ids uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
  v_name text := btrim(coalesce(p_name, ''));
  l jsonb;
  v_label text;
begin
  if app_private.template_access(p_actor, p_template_id) is distinct from 'edit' then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  select * into t from public.templates x where x.id = p_template_id for update;
  perform app_private.require_not_suspended(p_actor, t.org_id);
  if char_length(v_name) not between 1 and 120 then
    raise exception 'ES_INVALID: give the template a name (up to 120 characters)' using errcode = '22023';
  end if;
  update public.templates x set name = v_name, shared = coalesce(p_shared, x.shared), updated_at = now() where x.id = p_template_id;
  for l in select e.value from jsonb_array_elements(coalesce(p_labels, '[]'::jsonb)) as e(value) loop
    v_label := btrim(coalesce(l ->> 'label', ''));
    if char_length(v_label) not between 1 and 60 then
      raise exception 'ES_INVALID: every role needs a name (up to 60 characters)' using errcode = '22023';
    end if;
    update public.template_roles r set label = v_label where r.id = (l ->> 'role_id')::uuid and r.template_id = p_template_id;
  end loop;
  update public.template_fields f set locked = (f.id = any (coalesce(p_locked_ids, '{}'::uuid[]))) where f.template_id = p_template_id;
  perform app_private.audit_append('org:' || t.org_id::text, t.org_id, null, null, 'user', p_actor, 'template_changed',
    jsonb_build_object('template_id', p_template_id, 'shared', coalesce(p_shared, t.shared),
                       'locked', (select count(*) from public.template_fields f where f.template_id = p_template_id and f.locked)));
end
$$;

-- Soft delete; returns the file's path so the server can remove the file. Documents made from it are not affected.
create function public.template_delete(p_actor uuid, p_template_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
begin
  if app_private.template_access(p_actor, p_template_id) is distinct from 'edit' then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  update public.templates x set deleted_at = now(), updated_at = now() where x.id = p_template_id returning * into t;
  perform app_private.audit_append('org:' || t.org_id::text, t.org_id, null, null, 'user', p_actor, 'template_deleted',
    jsonb_build_object('template_id', p_template_id));
  return t.storage_path;
end
$$;

create function public.template_list(p_actor uuid, p_org uuid)
returns table (id uuid, name text, shared boolean, mine boolean, can_edit boolean, roles text, fields int, locked int,
               created_by_name text, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not app_private.is_member_of(p_actor, p_org, 'member') then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  return query
    select t.id, t.name, t.shared, coalesce(t.created_by = p_actor, false), app_private.template_access(p_actor, t.id) = 'edit',
           (select string_agg(r.label, ', ' order by r.position) from public.template_roles r where r.template_id = t.id),
           (select count(*)::int from public.template_fields f where f.template_id = t.id),
           (select count(*)::int from public.template_fields f where f.template_id = t.id and f.locked),
           coalesce(nullif(p.display_name, ''), u.raw_user_meta_data ->> 'full_name', ''), t.updated_at
      from public.templates t
      left join auth.users u on u.id = t.created_by
      left join public.profiles p on p.id = t.created_by
     where t.org_id = p_org and app_private.template_access(p_actor, t.id) is not null
     order by t.name, t.created_at;
end
$$;

create function public.template_get(p_actor uuid, p_template_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_access text := app_private.template_access(p_actor, p_template_id);
  t public.templates;
begin
  if v_access is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  select * into t from public.templates x where x.id = p_template_id;
  return jsonb_build_object(
    'id', t.id, 'org_id', t.org_id, 'name', t.name, 'shared', t.shared, 'mine', coalesce(t.created_by = p_actor, false), 'access', v_access,
    'filename', t.filename, 'storage_backend', t.storage_backend, 'storage_path', t.storage_path, 'page_count', t.page_count,
    'routing_mode', t.routing_mode, 'updated_at', t.updated_at,
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'label', r.label, 'role', r.role, 'routing_order', r.routing_order) order by r.position), '[]'::jsonb)
                from public.template_roles r where r.template_id = t.id),
    'fields', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'role_id', f.role_id, 'type', f.type, 'page', f.page, 'x', f.x, 'y', f.y,
                                                            'w', f.w, 'h', f.h, 'required', f.required, 'locked', f.locked) order by f.page, f.y, f.x), '[]'::jsonb)
                 from public.template_fields f where f.template_id = t.id));
end
$$;

-- ---------- use: step 1 creates the draft and its people (one per role) ----------
-- p_people: [{"role_id": ..., "name": ..., "email": ...}], exactly one per role.
create function public.template_start(p_actor uuid, p_template_id uuid, p_title text, p_people jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
  v_env public.envelopes;
  r public.template_roles;
  p jsonb;
  v_name text;
  v_email text;
begin
  if app_private.template_access(p_actor, p_template_id) is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  select * into t from public.templates x where x.id = p_template_id;
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) <> (select count(*) from public.template_roles x where x.template_id = p_template_id) then
    raise exception 'ES_INVALID: name one person for every role' using errcode = '22023';
  end if;
  v_env := public.create_envelope(p_actor, t.org_id, coalesce(nullif(btrim(coalesce(p_title, '')), ''), t.name), null);
  if t.routing_mode <> 'sequential' then
    perform public.set_routing_mode(p_actor, v_env.id, t.routing_mode);
  end if;
  for r in select * from public.template_roles x where x.template_id = p_template_id order by x.position loop
    p := null;
    select e.value into p from jsonb_array_elements(p_people) as e(value) where e.value ->> 'role_id' = r.id::text limit 1;
    v_name := btrim(coalesce(p ->> 'name', ''));
    v_email := lower(btrim(coalesce(p ->> 'email', '')));
    if p is null or char_length(v_name) not between 1 and 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
      raise exception 'ES_INVALID: give a name and a valid email address for %', r.label using errcode = '22023';
    end if;
    insert into public.recipients (org_id, envelope_id, name, email, role, routing_order, is_sender, template_role_id)
    values (t.org_id, v_env.id, v_name, v_email, r.role, r.routing_order, false, r.id);
  end loop;
  perform app_private.audit_append('env:' || v_env.id::text, t.org_id, v_env.id, null, 'user', p_actor, 'created_from_template',
    jsonb_build_object('template_id', p_template_id));
  return jsonb_build_object('envelope_id', v_env.id, 'org_id', t.org_id, 'source_backend', t.storage_backend, 'source_path', t.storage_path);
end
$$;

-- ---------- use: step 2, after the server copied the file into the draft's folder: document and fields ----------
create function public.template_finish(p_actor uuid, p_envelope_id uuid, p_template_id uuid, p_storage_path text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
  v_env public.envelopes;
  v_doc public.envelope_documents;
  v_hash text;
  v_count int;
begin
  if app_private.template_access(p_actor, p_template_id) is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  select * into t from public.templates x where x.id = p_template_id;
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if v_env.org_id <> t.org_id or not exists (select 1 from public.recipients x where x.envelope_id = p_envelope_id and x.template_role_id is not null) then
    raise exception 'ES_INVALID: this draft was not started from this template' using errcode = '22023';
  end if;
  v_doc := public.add_envelope_document(p_actor, p_envelope_id, t.filename, t.storage_backend, p_storage_path, t.sha256, t.page_count,
                                        t.size_bytes, t.page_boxes, t.source_kind);
  insert into public.fields (org_id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, options, locked)
  select v_env.org_id, p_envelope_id, v_doc.id, x.id, f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.options, f.locked
    from public.template_fields f
    join public.recipients x on x.template_role_id = f.role_id and x.envelope_id = p_envelope_id
   where f.template_id = p_template_id;
  get diagnostics v_count = row_count;
  v_hash := app_private.field_layout_hash(p_envelope_id);
  perform app_private.sanction();
  update public.envelopes e set field_layout_sha256 = v_hash where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor,
    'fields_changed', jsonb_build_object('count', v_count, 'layout_sha256', v_hash, 'from_template', p_template_id));
end
$$;

-- ---------- locked fields stay put ----------
create or replace function public.save_fields(p_actor uuid, p_envelope_id uuid, p_fields jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  f jsonb;
  v_pages int;
  v_hash text;
  v_locked jsonb;
  lf record;
  v_match uuid;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 500 then
    raise exception 'invalid field list' using errcode = '22023';
  end if;
  -- fields fixed by a template: each must come back exactly as it was (the client cannot set or clear "locked")
  select coalesce(jsonb_agg(jsonb_build_object('document_id', q.document_id, 'recipient_id', q.recipient_id, 'type', q.type, 'page', q.page,
                                               'x', q.x, 'y', q.y, 'w', q.w, 'h', q.h, 'required', q.required)), '[]'::jsonb)
    into v_locked from public.fields q where q.envelope_id = p_envelope_id and q.locked;
  delete from public.fields x where x.envelope_id = p_envelope_id;
  for f in select * from jsonb_array_elements(p_fields) loop
    select d.page_count into v_pages from public.envelope_documents d
     where d.id = (f ->> 'document_id')::uuid and d.envelope_id = p_envelope_id;
    if v_pages is null or (f ->> 'page')::int > v_pages then
      raise exception 'field refers to a page that does not exist' using errcode = '22023';
    end if;
    insert into public.fields (org_id, envelope_id, document_id, recipient_id, type, page, x, y, w, h, required, options)
      values (v_env.org_id, p_envelope_id, (f ->> 'document_id')::uuid, (f ->> 'recipient_id')::uuid, f ->> 'type',
              (f ->> 'page')::int, (f ->> 'x')::numeric, (f ->> 'y')::numeric, (f ->> 'w')::numeric, (f ->> 'h')::numeric,
              coalesce((f ->> 'required')::boolean, true), coalesce(f -> 'options', '{}'::jsonb));
  end loop;
  for lf in select * from jsonb_to_recordset(v_locked) as z(document_id uuid, recipient_id uuid, type text, page int,
                                                              x numeric, y numeric, w numeric, h numeric, required boolean) loop
    select q.id into v_match from public.fields q
     where q.envelope_id = p_envelope_id and not q.locked and q.document_id = lf.document_id and q.recipient_id = lf.recipient_id
       and q.type = lf.type and q.page = lf.page and q.x = lf.x and q.y = lf.y and q.w = lf.w and q.h = lf.h and q.required = lf.required
     limit 1;
    if v_match is null then
      raise exception 'ES_LOCKED: a field fixed by the template cannot be moved, resized or removed' using errcode = '42501';
    end if;
    update public.fields q set locked = true where q.id = v_match;
  end loop;
  v_hash := app_private.field_layout_hash(p_envelope_id);
  if v_hash is distinct from v_env.field_layout_sha256 then
    perform app_private.sanction();
    update public.envelopes e set field_layout_sha256 = v_hash where e.id = p_envelope_id;
    perform set_config('easysign.sanctioned', '', true);
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor,
      'fields_changed', jsonb_build_object('count', jsonb_array_length(p_fields), 'layout_sha256', v_hash));
  end if;
  return v_hash;
end
$$;

-- ... and the people holding them cannot be removed or given another role
create or replace function public.save_recipients(p_actor uuid, p_envelope_id uuid, p_recipients jsonb) returns setof public.recipients
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  r jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if jsonb_typeof(p_recipients) <> 'array' or jsonb_array_length(p_recipients) > 25 then
    raise exception 'invalid recipient list' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_recipients) loop
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from public.recipients x where x.id = v_id and x.envelope_id = p_envelope_id) then
      if exists (select 1 from public.fields f where f.recipient_id = v_id and f.locked)
         and (select x.role from public.recipients x where x.id = v_id) is distinct from coalesce(r ->> 'role', 'signer') then
        raise exception 'ES_LOCKED: this person has fields fixed by the template, so their role cannot change' using errcode = '42501';
      end if;
      update public.recipients x
         set name = btrim(r ->> 'name'), email = lower(btrim(r ->> 'email')),
             role = coalesce(r ->> 'role', 'signer'), routing_order = coalesce((r ->> 'routing_order')::int, 1),
             is_sender = coalesce((r ->> 'is_sender')::boolean, false)
       where x.id = v_id;
    else
      insert into public.recipients (org_id, envelope_id, name, email, role, routing_order, is_sender)
        values (v_env.org_id, p_envelope_id, btrim(r ->> 'name'), lower(btrim(r ->> 'email')),
                coalesce(r ->> 'role', 'signer'), coalesce((r ->> 'routing_order')::int, 1),
                coalesce((r ->> 'is_sender')::boolean, false))
        returning id into v_id;
    end if;
    v_ids := v_ids || v_id;
  end loop;
  if exists (select 1 from public.recipients x join public.fields f on f.recipient_id = x.id and f.locked
              where x.envelope_id = p_envelope_id and not (x.id = any (v_ids))) then
    raise exception 'ES_LOCKED: a person with fields fixed by the template cannot be removed' using errcode = '42501';
  end if;
  delete from public.recipients x where x.envelope_id = p_envelope_id and not (x.id = any (v_ids));
  return query select * from public.recipients x where x.envelope_id = p_envelope_id order by x.routing_order, x.created_at;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.template_create(uuid, uuid, uuid, text, boolean, jsonb, text)', 'public.template_update(uuid, uuid, text, boolean, jsonb, uuid[])',
    'public.template_delete(uuid, uuid)', 'public.template_list(uuid, uuid)', 'public.template_get(uuid, uuid)',
    'public.template_start(uuid, uuid, text, jsonb)', 'public.template_finish(uuid, uuid, uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- down:
-- drop function public.template_finish(uuid, uuid, uuid, text); drop function public.template_start(uuid, uuid, text, jsonb);
-- drop function public.template_get(uuid, uuid); drop function public.template_list(uuid, uuid); drop function public.template_delete(uuid, uuid);
-- drop function public.template_update(uuid, uuid, text, boolean, jsonb, uuid[]); drop function public.template_create(uuid, uuid, uuid, text, boolean, jsonb, text);
-- drop function app_private.require_not_suspended(uuid, uuid); drop function app_private.template_access(uuid, uuid);
-- recreate save_fields and save_recipients without the locked checks (migration 8 and earlier);
-- drop table public.template_fields; drop table public.template_roles; drop table public.templates;
-- alter table public.recipients drop column template_role_id; alter table public.fields drop column locked;
