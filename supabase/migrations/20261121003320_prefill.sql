-- YouNMeSign Phase 4 slice 5: prefill and merge fields (D-80).
-- * New option keys: prefill (a value the sender fills in before sending; up to 500 characters) and readonly (the signer
--   cannot change it). Only on fields the signer fills in: text, company, title, number, checkbox, choose-one, dropdown.
-- * Merge text: {{name}}, {{first_name}}, {{email}} (the person the field belongs to), {{sender_name}}, {{sender_email}},
--   {{document_title}}; in prefilled text, company and title values and in notes. Unknown placeholders stop sending.
-- * When a document leaves draft, app_private.envelopes_prefill writes the merged values into field_values (checked by type
--   like a signer's value), so the signer page, required checks, formulas and the seal all use them; one audit event
--   ("fields_prefilled") records how many and a SHA-256 of them. Notes with merge text get their merged text the same way.
-- * signer_fill_field refuses a change to a value the sender locked.
-- The same rules are in src/lib/merge.ts and src/lib/fields.ts; shared examples in T643.
-- Down script at the bottom (commented).

-- ---------- options: shape on every write ----------
create or replace function app_private.fields_options_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.options is null or jsonb_typeof(new.options) <> 'object' or octet_length(new.options::text) > 4000
     or exists (select 1 from jsonb_object_keys(new.options) k
                 where k not in ('choices', 'min', 'max', 'decimals', 'text', 'url', 'label', 'check', 'pattern', 'message',
                                 'name', 'formula', 'show_if', 'prefill', 'readonly')) then
    raise exception 'ES_FIELD_OPTIONS: a field has settings that are not allowed' using errcode = '22023';
  end if;
  return new;
end
$$;

-- ---------- merge text ----------
-- the first placeholder that is not a merge field (lower-cased), or null
create function app_private.merge_unknown(t text) returns text
language sql immutable set search_path = '' as $$
  select lower(m[1]) from regexp_matches(coalesce(t, ''), '\{\{\s*([A-Za-z_]+)\s*\}\}', 'g') with ordinality as x(m, n)
   where lower(m[1]) not in ('name', 'first_name', 'email', 'sender_name', 'sender_email', 'document_title')
   order by n limit 1
$$;

-- fill the placeholders in one pass, left to right (a filled-in value is never read again as a placeholder); unknown ones stay
create function app_private.merge_text(t text, p_name text, p_email text, p_sender_name text, p_sender_email text, p_title text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_out text := '';
  v_rest text := coalesce(t, '');
  v_m text[];
  v_whole text;
  v_pos int;
  v_name text := regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g');
begin
  loop
    v_m := regexp_match(v_rest, '\{\{\s*([A-Za-z_]+)\s*\}\}');
    exit when v_m is null;
    v_whole := substring(v_rest from '\{\{\s*[A-Za-z_]+\s*\}\}');
    v_pos := position(v_whole in v_rest);
    v_out := v_out || left(v_rest, v_pos - 1) || case lower(v_m[1])
      when 'name' then v_name
      when 'first_name' then split_part(regexp_replace(v_name, '\s+', ' ', 'g'), ' ', 1)
      when 'email' then coalesce(p_email, '')
      when 'sender_name' then coalesce(p_sender_name, '')
      when 'sender_email' then coalesce(p_sender_email, '')
      when 'document_title' then coalesce(p_title, '')
      else v_whole end;
    v_rest := substr(v_rest, v_pos + char_length(v_whole));
  end loop;
  return v_out || v_rest;
end
$$;
revoke all on function app_private.merge_unknown(text) from public, anon, authenticated, service_role;
revoke all on function app_private.merge_text(text, text, text, text, text, text) from public, anon, authenticated, service_role;

-- ---------- options: complete enough to send? (null = fine) ----------
create or replace function app_private.field_options_problem(p_type text, o jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_choices text[];
  v_pre text;
  v_problem text;
  v_unknown text;
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
  -- D-80: prefilled value (may hold merge text in typed text fields), and whether the signer may change it
  if o ? 'readonly' and jsonb_typeof(o -> 'readonly') <> 'boolean' then return 'the "cannot be changed" setting is not valid'; end if;
  if coalesce((o ->> 'readonly')::boolean, false) and btrim(coalesce(o ->> 'prefill', '')) = '' then
    return 'a value the signer cannot change needs a prefilled value';
  end if;
  if o ? 'prefill' then
    if jsonb_typeof(o -> 'prefill') <> 'string' or char_length(o ->> 'prefill') > 500 then return 'the prefilled value is not valid (up to 500 characters)'; end if;
    if p_type not in ('text', 'company', 'title', 'number', 'checkbox', 'radio', 'dropdown') then return 'only fields the signer fills in can be prefilled'; end if;
    v_pre := btrim(o ->> 'prefill');
    if v_pre <> '' then
      v_unknown := app_private.merge_unknown(v_pre);
      if p_type in ('text', 'company', 'title') then
        if v_unknown is not null then return 'prefilled value: "{{' || v_unknown || '}}" is not a merge field'; end if;
        -- with merge text, the value is checked once merged, when the document is sent (app_private.envelopes_prefill)
        if v_pre !~ '\{\{\s*[A-Za-z_]+\s*\}\}' then v_problem := app_private.field_value_problem(p_type, o, v_pre); end if;
      else
        if v_pre ~ '\{\{\s*[A-Za-z_]+\s*\}\}' then return 'merge text such as {{name}} can only be used in text, company and title fields'; end if;
        v_problem := app_private.field_value_problem(p_type, o, v_pre);
      end if;
      if v_problem is not null then return 'prefilled value: ' || v_problem; end if;
    end if;
  end if;
  if p_type = 'note' then
    v_unknown := app_private.merge_unknown(o ->> 'text');
    if v_unknown is not null then return 'note: "{{' || v_unknown || '}}" is not a merge field'; end if;
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

-- ---------- sending: prefilled values and merged notes become stored values ----------
create function app_private.envelopes_prefill() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  f record;
  v text;
  v_problem text;
  v_sender_name text;
  v_sender_email text;
  v_n int := 0;
  v_all text := '';
begin
  if old.status = 'draft' and new.status <> 'draft' then
    select coalesce(nullif(btrim(p.display_name), ''), u.email), u.email into v_sender_name, v_sender_email
      from auth.users u left join public.profiles p on p.id = u.id where u.id = new.sender_id;
    for f in select x.id, x.type, x.page, x.options, x.recipient_id, r.name, r.email
               from public.fields x join public.recipients r on r.id = x.recipient_id
              where x.envelope_id = new.id
                and ((x.options ? 'prefill' and btrim(x.options ->> 'prefill') <> '')
                     or (x.type = 'note' and coalesce(x.options ->> 'text', '') ~ '\{\{'))
              order by x.page, x.y, x.x loop
      if f.type = 'note' then
        v := app_private.merge_text(f.options ->> 'text', f.name, f.email, v_sender_name, v_sender_email, new.title);
        if char_length(v) > 2000 then
          raise exception 'ES_FIELD_SETUP: a note on page % is longer than 2000 characters once merged', f.page using errcode = '22023';
        end if;
      else
        v := btrim(app_private.merge_text(btrim(f.options ->> 'prefill'), f.name, f.email, v_sender_name, v_sender_email, new.title));
        v_problem := case when v = '' then 'it is empty once merged'
                          when char_length(v) > 500 then 'it is longer than 500 characters once merged'
                          else app_private.field_value_problem(f.type, f.options, v) end;
        if v_problem is not null then
          raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: prefilled value for %: %', replace(f.type, '_', ' '), f.page, f.name, v_problem
            using errcode = '22023';
        end if;
      end if;
      insert into public.field_values as fv (field_id, org_id, envelope_id, recipient_id, value_text)
        values (f.id, new.org_id, new.id, f.recipient_id, v)
        on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();
      v_n := v_n + 1;
      v_all := v_all || f.id::text || '=' || v || E'\n';
    end loop;
    if v_n > 0 then
      perform app_private.audit_append('env:' || new.id::text, new.org_id, new.id, null, 'system', null, 'fields_prefilled',
        jsonb_build_object('fields', v_n, 'values_sha256', encode(sha256(convert_to(v_all, 'UTF8')), 'hex')), null, null);
    end if;
  end if;
  return null;
end
$$;
revoke all on function app_private.envelopes_prefill() from public, anon, authenticated, service_role;
create trigger envelopes_prefill after update of status on public.envelopes
  for each row execute function app_private.envelopes_prefill();

-- ---------- filling a field: a locked prefilled value cannot be changed ----------
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
  if coalesce((v_options ->> 'readonly')::boolean, false) then   -- D-80
    raise exception 'ES_FIELD_READONLY: the sender filled this in and it cannot be changed' using errcode = '42501';
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

-- down:
-- drop trigger envelopes_prefill on public.envelopes; drop function app_private.envelopes_prefill();
-- re-run signer_fill_field from migration 20261120221542, and fields_options_guard and field_options_problem from
--   migration 20261121000853; drop function app_private.merge_text(text, text, text, text, text, text);
--   drop function app_private.merge_unknown(text); remove the keys prefill and readonly from fields.options and
--   template_fields.options (stored prefilled values in field_values stay: they are part of sent documents).
