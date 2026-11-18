-- EasySign Phase 1 / migration 6: server-only functions for preparing a draft envelope
-- (attach the uploaded document, edit details, recipients and fields, delete a draft).
-- Every function takes p_actor (the user id the server verified from the session) and re-checks that
-- actor's membership and status itself (D-35). Down script at the bottom (commented).

-- Shared guard: the actor must be an active member of the envelope's workspace and the envelope a draft.
create function app_private.require_draft(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql stable security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or not app_private.is_member_of(p_actor, v_env.org_id, 'member') then
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

-- Attach the validated upload to a draft. v1: one document per envelope.
create function public.add_envelope_document(
  p_actor uuid, p_envelope_id uuid, p_filename text, p_storage_backend text, p_storage_path text,
  p_sha256 text, p_page_count int, p_size_bytes bigint, p_page_boxes jsonb, p_source_kind text
) returns public.envelope_documents
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_doc public.envelope_documents;
  v_used bigint;
  v_quota bigint;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if p_source_kind not in ('pdf', 'png', 'jpeg') then
    raise exception 'unsupported source kind' using errcode = '22023';
  end if;
  if p_storage_path not like v_env.org_id::text || '/' || v_env.id::text || '/%' then
    raise exception 'storage path does not belong to this envelope' using errcode = '42501';
  end if;
  if exists (select 1 from public.envelope_documents d where d.envelope_id = p_envelope_id) then
    raise exception 'ES_HAS_DOCUMENT: this envelope already has a document' using errcode = '23505';
  end if;

  -- per-user storage allowance: everything this user has uploaded as sender
  select coalesce(sum(d.size_bytes), 0) into v_used
    from public.envelope_documents d join public.envelopes e on e.id = d.envelope_id
   where e.sender_id = p_actor;
  select c.storage_quota_bytes into v_quota from public.account_controls c where c.user_id = p_actor;
  if v_used + p_size_bytes > coalesce(v_quota, 0) then
    raise exception 'ES_QUOTA: this upload would go over your storage allowance' using errcode = '53100';
  end if;

  insert into public.envelope_documents (org_id, envelope_id, position, filename, storage_backend, storage_path,
      sha256, page_count, size_bytes, page_boxes)
    values (v_env.org_id, p_envelope_id, 1, left(btrim(p_filename), 255), p_storage_backend, p_storage_path,
      p_sha256, p_page_count, p_size_bytes, p_page_boxes)
    returning * into v_doc;

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor,
    'document_uploaded', jsonb_build_object('document_id', v_doc.id, 'sha256', p_sha256, 'pages', p_page_count,
      'bytes', p_size_bytes, 'source', p_source_kind));
  return v_doc;
end
$$;

create function public.update_envelope_draft(
  p_actor uuid, p_envelope_id uuid, p_title text, p_message text, p_folder_id uuid
) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  update public.envelopes e
     set title = btrim(p_title), message = coalesce(p_message, ''), folder_id = p_folder_id
   where e.id = p_envelope_id
   returning * into v_env;   -- the folder guard checks the folder belongs to this workspace
  return v_env;
end
$$;

-- Replace the recipient list of a draft. p_recipients: [{id?, name, email, role, routing_order, is_sender}]
-- Rows with a known id are updated in place (their fields survive); rows left out are removed.
create function public.save_recipients(p_actor uuid, p_envelope_id uuid, p_recipients jsonb) returns setof public.recipients
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
  delete from public.recipients x where x.envelope_id = p_envelope_id and not (x.id = any (v_ids));
  return query select * from public.recipients x where x.envelope_id = p_envelope_id order by x.routing_order, x.created_at;
end
$$;

-- Hash of the field layout: what every signer will be shown. Recorded at send and in signer events (D-26).
create function app_private.field_layout_hash(p_envelope_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(string_agg(
           f.document_id::text || '|' || f.recipient_id::text || '|' || f.type || '|' || f.page::text || '|' ||
           f.x::text || '|' || f.y::text || '|' || f.w::text || '|' || f.h::text || '|' || f.required::text,
           E'\n' order by f.page, f.y, f.x, f.type, f.recipient_id), ''), 'UTF8')), 'hex')
    from public.fields f where f.envelope_id = p_envelope_id
$$;

-- Replace all fields of a draft. p_fields: [{document_id, recipient_id, type, page, x, y, w, h, required, options}]
-- One compact audit event per real change (the layout hash), not one per drag.
create function public.save_fields(p_actor uuid, p_envelope_id uuid, p_fields jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  f jsonb;
  v_pages int;
  v_hash text;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 500 then
    raise exception 'invalid field list' using errcode = '22023';
  end if;
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

-- Delete a draft. Returns the storage objects the server must remove afterwards.
create function public.delete_draft_envelope(p_actor uuid, p_envelope_id uuid)
returns table (storage_backend text, storage_path text)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_backends text[];
  v_paths text[];
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  select array_agg(d.storage_backend), array_agg(d.storage_path) into v_backends, v_paths
    from public.envelope_documents d where d.envelope_id = p_envelope_id;
  delete from public.envelopes e where e.id = p_envelope_id;
  perform app_private.audit_append('org:' || v_env.org_id::text, v_env.org_id, null, null, 'user', p_actor, 'draft_deleted',
    jsonb_build_object('envelope_id', p_envelope_id, 'public_code', v_env.public_code));
  return query select t.b, t.p from unnest(coalesce(v_backends, '{}'::text[]), coalesce(v_paths, '{}'::text[])) as t(b, p);
end
$$;

revoke all on function public.add_envelope_document(uuid, uuid, text, text, text, text, int, bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.update_envelope_draft(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.save_recipients(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.save_fields(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.delete_draft_envelope(uuid, uuid) from public, anon, authenticated;
grant execute on function public.add_envelope_document(uuid, uuid, text, text, text, text, int, bigint, jsonb, text) to service_role;
grant execute on function public.update_envelope_draft(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.save_recipients(uuid, uuid, jsonb) to service_role;
grant execute on function public.save_fields(uuid, uuid, jsonb) to service_role;
grant execute on function public.delete_draft_envelope(uuid, uuid) to service_role;

-- down (manual):
-- drop function if exists public.delete_draft_envelope(uuid, uuid), public.save_fields(uuid, uuid, jsonb),
--   public.save_recipients(uuid, uuid, jsonb), public.update_envelope_draft(uuid, uuid, text, text, uuid),
--   public.add_envelope_document(uuid, uuid, text, text, text, text, int, bigint, jsonb, text),
--   app_private.field_layout_hash(uuid), app_private.require_draft(uuid, uuid);
