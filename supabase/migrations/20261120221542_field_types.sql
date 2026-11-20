-- YouNMeSign Phase 4 slice 3: more field types (part of AT4.4, D-78).
-- New types: checkbox, radio (choose one), dropdown, number, note (shown, never filled), hyperlink (shown, never filled),
-- attachment (the signer uploads a file). Text, company and title fields can carry a check (digits, letters, email,
-- phone, or a custom pattern) with the sender's own message.
-- * Options live in fields.options; their shape is checked on every write (allowed keys, size), and their completeness
--   when the document is sent (a draft may be half set up; a sent document never is).
-- * Every value a signer gives is checked here by type before it is stored, whatever the browser did.
-- * Attachments: one row per field in field_attachments; included in document deletion (D-71).
-- * The layout fingerprint now includes a field's options when it has any (existing fingerprints are unchanged).
-- The same rules exist in src/lib/fields.ts (fieldOptionsProblem / checkFieldValue) for the editor and signer page.
-- Down script at the bottom (commented).

alter table public.fields drop constraint fields_type_check;
alter table public.fields add constraint fields_type_check check (type in (
  'signature', 'initials', 'date_signed', 'name', 'email', 'company', 'title', 'text',
  'checkbox', 'radio', 'dropdown', 'number', 'note', 'hyperlink', 'attachment'));

-- ---------- options: shape on every write ----------
create function app_private.fields_options_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.options is null or jsonb_typeof(new.options) <> 'object' or octet_length(new.options::text) > 4000
     or exists (select 1 from jsonb_object_keys(new.options) k
                 where k not in ('choices', 'min', 'max', 'decimals', 'text', 'url', 'label', 'check', 'pattern', 'message')) then
    raise exception 'ES_FIELD_OPTIONS: a field has settings that are not allowed' using errcode = '22023';
  end if;
  return new;
end
$$;
create trigger fields_options_guard before insert or update of options on public.fields
  for each row execute function app_private.fields_options_guard();

-- ---------- options: complete enough to send? (null = fine) ----------
create function app_private.field_options_problem(p_type text, o jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_choices text[];
begin
  o := coalesce(o, '{}'::jsonb);
  if p_type in ('radio', 'dropdown') then
    if jsonb_typeof(o -> 'choices') is distinct from 'array' then return 'give at least two choices'; end if;
    select array_agg(btrim(c)) into v_choices from jsonb_array_elements_text(o -> 'choices') c where btrim(c) <> '';
    if coalesce(array_length(v_choices, 1), 0) < 2 then return 'give at least two choices'; end if;
    if array_length(v_choices, 1) > 20 then return 'up to 20 choices'; end if;
    if (select count(distinct c) from unnest(v_choices) c) <> array_length(v_choices, 1) then return 'each choice must be different'; end if;
    if exists (select 1 from unnest(v_choices) c where char_length(c) > 60) then return 'choices can be up to 60 characters'; end if;
  elsif p_type = 'number' then
    if (o ? 'min' and jsonb_typeof(o -> 'min') <> 'number') or (o ? 'max' and jsonb_typeof(o -> 'max') <> 'number')
       or (o ? 'decimals' and (jsonb_typeof(o -> 'decimals') <> 'number' or (o ->> 'decimals')::numeric not in (0, 1, 2))) then
      return 'the number limits are not valid';
    end if;
    if o ? 'min' and o ? 'max' and (o ->> 'min')::numeric > (o ->> 'max')::numeric then return 'the smallest number is bigger than the largest'; end if;
  elsif p_type = 'note' then
    if btrim(coalesce(o ->> 'text', '')) = '' or char_length(o ->> 'text') > 500 then return 'type the note (up to 500 characters)'; end if;
  elsif p_type = 'hyperlink' then
    if coalesce(o ->> 'url', '') !~* '^https?://[^\s/$.?#][^\s]*$' or char_length(o ->> 'url') > 500 then
      return 'give the full web address, starting with https://';
    end if;
  elsif p_type in ('text', 'company', 'title') and o ? 'check' then
    if (o ->> 'check') not in ('digits', 'letters', 'email', 'phone', 'custom') then return 'unknown check'; end if;
    if (o ->> 'check') = 'custom' then
      if coalesce(o ->> 'pattern', '') = '' or char_length(o ->> 'pattern') > 100 then return 'type the pattern (up to 100 characters)'; end if;
      begin
        perform '' ~ (o ->> 'pattern');
      exception when others then
        return 'that pattern is not valid';
      end;
    end if;
  end if;
  return null;
end
$$;

-- ---------- is a signer's value acceptable? (null = fine; '' is handled by the caller as "clear") ----------
create function app_private.field_value_problem(p_type text, o jsonb, v text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_dec int;
  v_num numeric;
  v_ok boolean;
begin
  o := coalesce(o, '{}'::jsonb);
  if p_type = 'checkbox' then
    return case when v = 'true' then null else 'tick the box or leave it empty' end;
  elsif p_type in ('radio', 'dropdown') then
    return case when exists (select 1 from jsonb_array_elements_text(coalesce(o -> 'choices', '[]'::jsonb)) c where c = v) then null
                else 'choose one of the options' end;
  elsif p_type = 'number' then
    if v !~ '^-?[0-9]+(\.[0-9]+)?$' or char_length(v) > 40 then return 'enter a number, like 12 or 12.50'; end if;
    v_dec := coalesce((o ->> 'decimals')::int, 2);
    if position('.' in v) > 0 and char_length(split_part(v, '.', 2)) > v_dec then
      return case when v_dec = 0 then 'use a whole number' else 'use at most ' || v_dec || ' decimal place' || case when v_dec = 1 then '' else 's' end end;
    end if;
    v_num := v::numeric;
    if o ? 'min' and v_num < (o ->> 'min')::numeric then return 'the smallest allowed is ' || (o ->> 'min'); end if;
    if o ? 'max' and v_num > (o ->> 'max')::numeric then return 'the largest allowed is ' || (o ->> 'max'); end if;
    return null;
  elsif p_type in ('text', 'company', 'title') then
    if not o ? 'check' then return null; end if;
    begin
      v_ok := case o ->> 'check'
                when 'digits' then v ~ '^[0-9]+$'
                when 'letters' then v ~ '^[[:alpha:] .''-]+$'
                when 'email' then v ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
                when 'phone' then v ~ '^\+?[0-9 ()-]{6,20}$'
                when 'custom' then v ~ (o ->> 'pattern')
              end;
    exception when others then
      return 'this field is set up wrongly. Tell the sender';
    end;
    if v_ok then return null; end if;
    return coalesce(nullif(btrim(o ->> 'message'), ''),
      case o ->> 'check'
        when 'digits' then 'use digits only (0 to 9)'
        when 'letters' then 'use letters only'
        when 'email' then 'enter an email address, like name@example.com'
        when 'phone' then 'enter a phone number: digits, spaces, brackets or a dash, 6 to 20 characters'
        else 'this does not have the expected format' end);
  end if;
  return null;
end
$$;
revoke all on function app_private.field_options_problem(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function app_private.field_value_problem(text, jsonb, text) from public, anon, authenticated, service_role;

-- ---------- a sent document never has a half set-up field ----------
create function app_private.envelopes_field_setup_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  f record;
  v_problem text;
begin
  if old.status = 'draft' and new.status <> 'draft' then
    for f in select x.type, x.page, x.options from public.fields x where x.envelope_id = new.id order by x.page, x.y, x.x loop
      v_problem := app_private.field_options_problem(f.type, f.options);
      if v_problem is not null then
        raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: %', replace(f.type, '_', ' '), f.page, v_problem using errcode = '22023';
      end if;
    end loop;
  end if;
  return new;
end
$$;
create trigger envelopes_field_setup_check before update of status on public.envelopes
  for each row execute function app_private.envelopes_field_setup_check();

-- ---------- the layout fingerprint covers options (only when a field has any, so older fingerprints are unchanged) ----------
create or replace function app_private.field_layout_hash(p_envelope_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(string_agg(
           f.document_id::text || '|' || f.recipient_id::text || '|' || f.type || '|' || f.page::text || '|' ||
           f.x::text || '|' || f.y::text || '|' || f.w::text || '|' || f.h::text || '|' || f.required::text ||
           case when f.options is not null and f.options <> '{}'::jsonb then '|' || f.options::text else '' end,
           E'\n' order by f.page, f.y, f.x, f.type, f.recipient_id), ''), 'UTF8')), 'hex')
    from public.fields f where f.envelope_id = p_envelope_id
$$;

-- ---------- filling a field: checked by type ----------
create or replace function public.signer_fill_field(p_token_id uuid, p_field_id uuid, p_value text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_type text;
  v_options jsonb;
  v_value text := left(btrim(coalesce(p_value, '')), 500);
  v_problem text;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  select f.type, f.options into v_type, v_options from public.fields f where f.id = p_field_id and f.recipient_id = v_rcp.id;
  if v_type is null or v_type not in ('company', 'title', 'text', 'checkbox', 'radio', 'dropdown', 'number') then
    raise exception 'ES_FIELD_INVALID: that field cannot be filled in' using errcode = '42501';
  end if;
  if v_value <> '' then
    v_problem := app_private.field_value_problem(v_type, v_options, v_value);
    if v_problem is not null then
      raise exception 'ES_VALUE_INVALID: %', v_problem using errcode = '22023';
    end if;
  end if;
  if coalesce((select v.value_text from public.field_values v where v.field_id = p_field_id), '') = v_value then
    return; -- unchanged: nothing to store, nothing to log
  end if;
  if v_value = '' then
    delete from public.field_values v where v.field_id = p_field_id;
  else
    insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, value_text)
      values (p_field_id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, v_value)
      on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();
  end if;
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'field_filled',
    jsonb_build_object('field_id', p_field_id, 'type', v_type, 'value_sha256', encode(sha256(convert_to(v_value, 'UTF8')), 'hex')), p_ip, p_user_agent);
end
$$;

-- ---------- attachments ----------
create table public.field_attachments (
  field_id uuid primary key references public.fields (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  storage_backend text not null check (storage_backend in ('supabase', 'disk')),
  storage_path text not null,
  file_name text not null check (char_length(file_name) between 1 and 200),
  kind text not null check (kind in ('pdf', 'png', 'jpeg')),
  size_bytes bigint not null check (size_bytes between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index field_attachments_envelope_idx on public.field_attachments (envelope_id);
alter table public.field_attachments enable row level security;
-- the sender's side reads attachments of documents it may see (same rule as every other part of a document)
create policy field_attachments_select on public.field_attachments for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = field_attachments.envelope_id));
revoke all on public.field_attachments from anon, authenticated;
grant select (field_id, org_id, envelope_id, recipient_id, file_name, kind, size_bytes, sha256, created_at) on public.field_attachments to authenticated;
grant select, insert, update, delete on public.field_attachments to service_role;

-- The server stored the file at <org>/<envelope>/att-<random>.<ext> in the attachments store; returns the path of the
-- file it replaces (to be removed), or null.
create function public.signer_attach(p_token_id uuid, p_field_id uuid, p_storage_backend text, p_storage_path text, p_file_name text,
                                     p_kind text, p_size_bytes bigint, p_sha256 text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_type text;
  v_old text;
  v_name text := left(btrim(regexp_replace(coalesce(p_file_name, ''), '[\x00-\x1f\x7f/\\]', '', 'g')), 200);
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  select f.type into v_type from public.fields f where f.id = p_field_id and f.recipient_id = v_rcp.id;
  if v_type is distinct from 'attachment' then
    raise exception 'ES_FIELD_INVALID: that field cannot take a file' using errcode = '42501';
  end if;
  if p_storage_path !~ ('^' || v_rcp.org_id::text || '/' || v_rcp.envelope_id::text || '/att-[0-9a-f-]{36}\.(pdf|png|jpg)$')
     or p_kind not in ('pdf', 'png', 'jpeg') or p_size_bytes not between 1 and 5242880 or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid attachment' using errcode = '22023';
  end if;
  if v_name = '' then v_name := 'attachment.' || case p_kind when 'jpeg' then 'jpg' else p_kind end; end if;
  select a.storage_path into v_old from public.field_attachments a where a.field_id = p_field_id;
  insert into public.field_attachments as a (field_id, org_id, envelope_id, recipient_id, storage_backend, storage_path, file_name, kind, size_bytes, sha256)
  values (p_field_id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, p_storage_backend, p_storage_path, v_name, p_kind, p_size_bytes, p_sha256)
  on conflict (field_id) do update set storage_backend = excluded.storage_backend, storage_path = excluded.storage_path, file_name = excluded.file_name,
    kind = excluded.kind, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, created_at = now();
  -- what the document shows and the seal prints: the name and the start of the file's fingerprint
  insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, value_text)
    values (p_field_id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, left(v_name, 120) || ' · SHA-256 ' || left(p_sha256, 16))
    on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'field_filled',
    jsonb_build_object('field_id', p_field_id, 'type', 'attachment', 'file_sha256', p_sha256, 'bytes', p_size_bytes, 'kind', p_kind), p_ip, p_user_agent);
  return case when v_old is distinct from p_storage_path then v_old end;
end
$$;
revoke all on function public.signer_attach(uuid, uuid, text, text, text, text, bigint, text, inet, text) from public, anon, authenticated;
grant execute on function public.signer_attach(uuid, uuid, text, text, text, text, bigint, text, inet, text) to service_role;

-- ---------- signing: notes and links are never "still empty" ----------
create or replace function public.signer_complete(p_token_id uuid, p_intent_text_sha256 text, p_local_date text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_sig uuid;
  v_ini uuid;
  v_n int;
  v_stamps int := 0;
  v_date date;
  f public.fields;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.role = 'approver' then
    raise exception 'ES_WRONG_ACTION: an approver approves or declines; there is nothing to sign' using errcode = '42501';
  end if;
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  if p_local_date !~ '^\d{4}-\d{2}-\d{2}$' or p_intent_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid completion data' using errcode = '22023';
  end if;
  begin
    v_date := p_local_date::date;
  exception when others then
    raise exception 'invalid completion data' using errcode = '22023';
  end;
  if abs(v_date - app_private.utc_day()) > 1 then
    raise exception 'ES_DATE: the date on your device looks wrong. Check its clock and try again' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;

  select a.id into v_sig from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'signature' order by a.created_at desc limit 1;
  select a.id into v_ini from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'initials' order by a.created_at desc limit 1;
  if v_sig is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'signature') then
    raise exception 'ES_SIGNATURE_MISSING: create your signature first' using errcode = '22023';
  end if;
  if v_ini is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'initials') then
    raise exception 'ES_INITIALS_MISSING: create your initials first' using errcode = '22023';
  end if;

  -- convenience fills for fields the signer left blank
  insert into public.field_values (field_id, org_id, envelope_id, recipient_id, value_text)
    select x.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id,
           case x.type when 'date_signed' then to_char(v_date, 'YYYY-MM-DD') when 'name' then v_rcp.name else v_rcp.email end
      from public.fields x where x.recipient_id = v_rcp.id and x.type in ('date_signed', 'name', 'email')
    on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();

  -- notes and links are shown, never filled in (D-78)
  if exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.required and x.type not in ('signature', 'initials', 'note', 'hyperlink')
             and not exists (select 1 from public.field_values v where v.field_id = x.id)) then
    raise exception 'ES_FIELDS_MISSING: some required fields are still empty' using errcode = '22023';
  end if;

  select count(*) into v_n from public.field_values v where v.envelope_id = v_rcp.envelope_id and v.signature_id is not null;
  for f in select * from public.fields x where x.recipient_id = v_rcp.id and x.type in ('signature', 'initials') order by x.page, x.y, x.x loop
    v_n := v_n + 1;
    v_stamps := v_stamps + 1;
    insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, signature_asset_id, signature_id)
      values (f.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, case f.type when 'signature' then v_sig else v_ini end, v_env.public_code || '-S' || v_n)
      on conflict (field_id) do update set signature_asset_id = excluded.signature_asset_id, signature_id = excluded.signature_id, filled_at = now();
  end loop;

  perform app_private.sanction();
  update public.recipients x set status = 'signed', completed_at = now() where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'recipient_signed',
    jsonb_build_object('stamps', v_stamps, 'intent_text_sha256', p_intent_text_sha256, 'layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1)),
    p_ip, p_user_agent);

  return app_private.routing_after_action(v_rcp.envelope_id, v_rcp.org_id);
end
$$;

-- ---------- deleting a document also removes signers' attachments (D-71) ----------
create or replace function public.begin_envelope_deletion(p_actor uuid, p_envelope_id uuid, p_ip inet, p_user_agent text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_until timestamptz;
  v_files jsonb;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  perform app_private.require_owner(p_actor, v_env.org_id);
  if v_env.deleted_at is not null then
    raise exception 'ES_DELETED: this document has already been deleted' using errcode = '42501';
  end if;
  if v_env.status not in ('completed', 'declined', 'voided', 'expired') then
    raise exception 'ES_NOT_FINISHED: only finished documents can be deleted (cancel it first, or delete the draft)' using errcode = '42501';
  end if;
  if v_env.legal_hold then
    raise exception 'ES_LEGAL_HOLD: this document is under a legal hold and cannot be deleted' using errcode = '42501';
  end if;
  v_until := app_private.retained_until(v_env);
  if v_until > now() then
    raise exception 'ES_RETENTION: this document must be kept until % (the workspace retention period)', to_char(v_until at time zone 'utc', 'YYYY-MM-DD')
      using errcode = '42501';
  end if;
  if exists (select 1 from public.seal_jobs j where j.envelope_id = p_envelope_id and j.status in ('queued', 'running')) then
    raise exception 'ES_SEALING: the final document is still being prepared' using errcode = '42501';
  end if;

  if v_env.deletion_started_at is null then
    perform app_private.sanction();
    update public.envelopes e set deletion_started_at = now(), deletion_started_by = p_actor where e.id = p_envelope_id;
    perform set_config('easysign.sanctioned', '', true);
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'deletion_started', '{}'::jsonb, p_ip, p_user_agent);
  end if;

  select coalesce(jsonb_agg(f), '[]'::jsonb) into v_files from (
    select jsonb_build_object('bucket', 'originals', 'backend', d.storage_backend, 'path', d.storage_path) f
      from public.envelope_documents d where d.envelope_id = p_envelope_id
    union all
    select jsonb_build_object('bucket', 'sealed', 'backend', v_env.sealed_storage_backend, 'path', p) from unnest(array[v_env.sealed_storage_path, v_env.certificate_storage_path]) p where p is not null
    union all
    select jsonb_build_object('bucket', 'signatures', 'backend', a.storage_backend, 'path', a.storage_path)
      from public.signature_assets a where a.recipient_id in (select x.id from public.recipients x where x.envelope_id = p_envelope_id)
    union all
    select jsonb_build_object('bucket', 'attachments', 'backend', t.storage_backend, 'path', t.storage_path)
      from public.field_attachments t where t.envelope_id = p_envelope_id
  ) q;
  return v_files;
end
$$;

-- down:
-- restore begin_envelope_deletion, signer_complete, signer_fill_field and field_layout_hash from migrations 25, 8 and earlier;
-- drop function public.signer_attach(uuid, uuid, text, text, text, text, bigint, text, inet, text); drop table public.field_attachments;
-- drop trigger envelopes_field_setup_check on public.envelopes; drop function app_private.envelopes_field_setup_check();
-- drop function app_private.field_value_problem(text, jsonb, text); drop function app_private.field_options_problem(text, jsonb);
-- drop trigger fields_options_guard on public.fields; drop function app_private.fields_options_guard();
-- alter table public.fields drop constraint fields_type_check; add it back with the first eight types (after removing rows of the new types).
