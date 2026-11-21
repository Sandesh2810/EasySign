-- YouNMeSign Phase 4 slice 4: formulas and conditions (rest of AT4.4, D-79).
-- * New field type 'formula' (shown to the signer as a calculated value, never filled in, never required).
-- * New option keys: name (what formulas and conditions call a field), formula, show_if (a condition for showing a field).
-- * Shape checks here (key whitelist, name pattern, lengths, no condition on signatures and initials, names unique per
--   document when it is sent). Full checks of the formula language (syntax, unknown names, same signer only, no circles)
--   run in the server before sending (src/lib/form-logic.ts); the database cannot parse the language.
-- * Completing: the server works out which of the signer's fields are hidden by their conditions and passes them in
--   p_hidden. Only the signer's own fields that have a condition are accepted there; hidden fields and calculated fields are
--   never "still empty". The list is recorded in the audit event. The worker works it out again when sealing and leaves
--   hidden fields out of the PDF.
-- Down script at the bottom (commented).

alter table public.fields drop constraint fields_type_check;
alter table public.fields add constraint fields_type_check check (type in (
  'signature', 'initials', 'date_signed', 'name', 'email', 'company', 'title', 'text',
  'checkbox', 'radio', 'dropdown', 'number', 'note', 'hyperlink', 'attachment', 'formula'));

-- ---------- options: shape on every write ----------
create or replace function app_private.fields_options_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.options is null or jsonb_typeof(new.options) <> 'object' or octet_length(new.options::text) > 4000
     or exists (select 1 from jsonb_object_keys(new.options) k
                 where k not in ('choices', 'min', 'max', 'decimals', 'text', 'url', 'label', 'check', 'pattern', 'message',
                                 'name', 'formula', 'show_if')) then
    raise exception 'ES_FIELD_OPTIONS: a field has settings that are not allowed' using errcode = '22023';
  end if;
  return new;
end
$$;

-- ---------- options: complete enough to send? (null = fine) ----------
create or replace function app_private.field_options_problem(p_type text, o jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_choices text[];
begin
  o := coalesce(o, '{}'::jsonb);
  -- D-79: name, condition (any type but signature and initials), formula
  if o ? 'name' then
    if jsonb_typeof(o -> 'name') <> 'string' or (o ->> 'name') !~ '^[a-z][a-z0-9_]{0,30}$' then
      return 'a name starts with a small letter and uses only small letters, digits and _ (up to 31)';
    end if;
    if p_type not in ('text', 'company', 'title', 'number', 'checkbox', 'radio', 'dropdown', 'formula') then
      return 'only fields the signer fills in, or calculated fields, can have a name';
    end if;
  end if;
  if o ? 'show_if' then
    if p_type in ('signature', 'initials') then return 'signatures and initials are always shown; they cannot have a condition'; end if;
    if jsonb_typeof(o -> 'show_if') <> 'string' or btrim(o ->> 'show_if') = '' or char_length(o ->> 'show_if') > 300 then
      return 'type the condition (up to 300 characters)';
    end if;
  end if;
  if p_type = 'formula' then
    if jsonb_typeof(o -> 'formula') is distinct from 'string' or btrim(o ->> 'formula') = '' or char_length(o ->> 'formula') > 300 then
      return 'type the formula (up to 300 characters)';
    end if;
    if o ? 'decimals' and (jsonb_typeof(o -> 'decimals') <> 'number' or (o ->> 'decimals')::numeric not in (0, 1, 2)) then
      return 'decimals must be 0, 1 or 2';
    end if;
  elsif p_type in ('radio', 'dropdown') then
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
revoke all on function app_private.field_options_problem(text, jsonb) from public, anon, authenticated, service_role;

-- ---------- a sent document never has a half set-up field, nor two fields with the same name ----------
create or replace function app_private.envelopes_field_setup_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  f record;
  v_problem text;
  v_dup text;
begin
  if old.status = 'draft' and new.status <> 'draft' then
    for f in select x.type, x.page, x.options from public.fields x where x.envelope_id = new.id order by x.page, x.y, x.x loop
      v_problem := app_private.field_options_problem(f.type, f.options);
      if v_problem is not null then
        raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: %', replace(f.type, '_', ' '), f.page, v_problem using errcode = '22023';
      end if;
    end loop;
    select x.options ->> 'name' into v_dup from public.fields x
     where x.envelope_id = new.id and x.options ? 'name'
     group by x.options ->> 'name' having count(*) > 1 limit 1;
    if v_dup is not null then
      raise exception 'ES_FIELD_SETUP: two fields are named "%"; each name must be different', v_dup using errcode = '22023';
    end if;
  end if;
  return new;
end
$$;

-- ---------- signing: hidden fields and calculated fields are never "still empty" ----------
drop function public.signer_complete(uuid, text, text, inet, text);
create function public.signer_complete(p_token_id uuid, p_intent_text_sha256 text, p_local_date text, p_ip inet, p_user_agent text,
                                       p_hidden uuid[] default '{}') returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_sig uuid;
  v_ini uuid;
  v_n int;
  v_stamps int := 0;
  v_date date;
  v_hidden uuid[] := coalesce(p_hidden, '{}');
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
  -- D-79: only this signer's own fields that carry a condition can be hidden
  if coalesce(array_length(v_hidden, 1), 0) > 500
     or exists (select 1 from unnest(v_hidden) h(id)
                 where not exists (select 1 from public.fields x
                                    where x.id = h.id and x.recipient_id = v_rcp.id and x.options ? 'show_if'
                                      and x.type not in ('signature', 'initials'))) then
    raise exception 'invalid hidden fields' using errcode = '22023';
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

  -- notes, links and calculated fields are shown, never filled in (D-78, D-79); hidden fields are not asked for (D-79)
  if exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.required
               and x.type not in ('signature', 'initials', 'note', 'hyperlink', 'formula')
               and not (x.id = any (v_hidden))
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
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1))
    || case when coalesce(array_length(v_hidden, 1), 0) > 0
            then jsonb_build_object('hidden_fields', (select to_jsonb(array_agg(distinct h order by h)) from unnest(v_hidden) h))
            else '{}'::jsonb end,
    p_ip, p_user_agent);

  return app_private.routing_after_action(v_rcp.envelope_id, v_rcp.org_id);
end
$$;
revoke all on function public.signer_complete(uuid, text, text, inet, text, uuid[]) from public, anon, authenticated;
grant execute on function public.signer_complete(uuid, text, text, inet, text, uuid[]) to service_role;

-- down:
-- drop function public.signer_complete(uuid, text, text, inet, text, uuid[]); re-run signer_complete from migration 20261120221542
--   and its grants (service_role only);
-- re-run fields_options_guard, field_options_problem and envelopes_field_setup_check from migration 20261120221542;
-- alter table public.fields drop constraint fields_type_check; add it back without 'formula' (after removing formula fields
--   and the keys name, formula and show_if from fields.options and template_fields.options).
