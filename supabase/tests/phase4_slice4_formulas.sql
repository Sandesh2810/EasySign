-- YouNMeSign SQL tests for Phase 4 slice 4: formulas and conditions (D-79). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; s1 uuid;
  t1 uuid := gen_random_uuid();
  h1 text := repeat('f8', 32);
  body text := 'Slice 4 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  f_sig uuid; f_extra uuid; f_extra_qty uuid; f_qty uuid; f_total uuid;
  n int; ok boolean; v text; st text; pl jsonb;
  base jsonb;
  good jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't44-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Flo Formula"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s44-v1', body);

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Quote', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'quote.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c6', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Quinn Quote","email":"t44-quinn@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  base := jsonb_build_object('document_id', d1, 'recipient_id', s1, 'page', 1, 'w', 0.2, 'h', 0.03);
  good := jsonb_build_array(
    base || jsonb_build_object('type', 'signature', 'x', 0.1, 'y', 0.9, 'h', 0.06),
    base || jsonb_build_object('type', 'checkbox', 'x', 0.1, 'y', 0.05, 'w', 0.03, 'h', 0.02, 'required', false, 'options', jsonb_build_object('name', 'extra')),
    base || jsonb_build_object('type', 'number', 'x', 0.1, 'y', 0.1, 'required', true, 'options', jsonb_build_object('name', 'extra_qty', 'decimals', 0, 'show_if', 'extra')),
    base || jsonb_build_object('type', 'number', 'x', 0.1, 'y', 0.2, 'required', true, 'options', jsonb_build_object('name', 'qty', 'decimals', 0)),
    base || jsonb_build_object('type', 'formula', 'x', 0.1, 'y', 0.3, 'required', true, 'options', jsonb_build_object('name', 'total', 'formula', 'qty * 19.99 + extra_qty * 5', 'decimals', 2)));

  -- T631: the new settings save; unknown settings are still refused
  n := 0;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'number', 'x', 0.1, 'y', 0.1, 'options', jsonb_build_object('name', 'qty', 'onchange', 'x'))));
        n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'javascript', 'x', 0.1, 'y', 0.1)));
        n := n + 1; exception when check_violation then null; end;
  perform public.save_fields(a, e1, good);
  if n = 0 and (select count(*) from public.fields f where f.envelope_id = e1 and (f.options ? 'name' or f.options ? 'show_if' or f.options ? 'formula')) = 4
     and exists (select 1 from public.fields f where f.envelope_id = e1 and f.type = 'formula')
  then res := res || E'PASS T631 names, formulas, conditions and the calculated field type save; unknown settings and types are still refused\n';
  else res := res || 'FAIL T631 settings shape :: n=' || n || E'\n'; end if;

  -- T632: sending is refused until formulas and conditions are set up properly; then it goes
  n := 0;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'formula', 'x', 0.5, 'y', 0.5)));
  begin perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('93', 16), 'token_sha256', h1)), exp, 'link');
        n := n + 1; exception when invalid_parameter_value then
          get stacked diagnostics v = message_text; if v not like 'ES_FIELD_SETUP: a formula field on page 1 is not ready: type the formula%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'text', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('name', 'Qty'))));
  begin perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('93', 16), 'token_sha256', h1)), exp, 'link');
        n := n + 1; exception when invalid_parameter_value then
          get stacked diagnostics v = message_text; if v not like '%a name starts with a small letter%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'initials', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('show_if', 'extra'))));
  begin perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('93', 16), 'token_sha256', h1)), exp, 'link');
        n := n + 1; exception when invalid_parameter_value then
          get stacked diagnostics v = message_text; if v not like '%always shown%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'text', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('name', 'qty'))));
  begin perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('93', 16), 'token_sha256', h1)), exp, 'link');
        n := n + 1; exception when invalid_parameter_value then
          get stacked diagnostics v = message_text; if v <> 'ES_FIELD_SETUP: two fields are named "qty"; each name must be different' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good);
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('93', 16), 'token_sha256', h1)), exp, 'link');
  if n = 0 and (select e.status from public.envelopes e where e.id = e1) = 'sent'
  then res := res || E'PASS T632 sending is refused for a calculated field without a formula, a badly formed name, a condition on initials, or two fields with one name; a proper setup sends\n';
  else res := res || 'FAIL T632 send-time checks :: n=' || n || ' last=' || coalesce(v, '?') || E'\n'; end if;
  select f.id into f_sig from public.fields f where f.envelope_id = e1 and f.type = 'signature';
  select f.id into f_extra from public.fields f where f.envelope_id = e1 and f.options ->> 'name' = 'extra';
  select f.id into f_extra_qty from public.fields f where f.envelope_id = e1 and f.options ->> 'name' = 'extra_qty';
  select f.id into f_qty from public.fields f where f.envelope_id = e1 and f.options ->> 'name' = 'qty';
  select f.id into f_total from public.fields f where f.envelope_id = e1 and f.type = 'formula';
  execute 'reset role';

  -- T633: the database's shape rules give the same answers as the app's (examples shared with src/lib/form-logic.test.ts)
  ok := app_private.field_options_problem('number', '{"name":"Qty"}') like '%small letter%'
    and app_private.field_options_problem('number', '{"name":"1qty"}') like '%small letter%'
    and app_private.field_options_problem('number', '{"name":"unit_price_2"}') is null
    and app_private.field_options_problem('note', '{"name":"n","text":"x"}') like '%only fields%'
    and app_private.field_options_problem('signature', '{"name":"s"}') like '%only fields%'
    and app_private.field_options_problem('formula', '{}') like 'type the formula%'
    and app_private.field_options_problem('formula', '{"formula":"qty * price"}') is null
    and app_private.field_options_problem('formula', '{"formula":"qty","decimals":3}') like 'decimals%'
    and app_private.field_options_problem('signature', '{"show_if":"true"}') like '%always shown%'
    and app_private.field_options_problem('initials', '{"show_if":"true"}') like '%always shown%'
    and app_private.field_options_problem('text', '{"show_if":"plan == \"Yearly\""}') is null
    and app_private.field_options_problem('text', '{"show_if":"   "}') like 'type the condition%';
  if ok then res := res || E'PASS T633 the database''s rules for names, formulas and conditions agree with the editor on the shared examples\n';
  else res := res || E'FAIL T633 database and app disagree on a shared example\n'; end if;

  execute 'set local role service_role';
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 's44-v1', body_sha, '203.0.113.44', 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5e', 32), null, null, null, 'ua');
  perform public.signer_fill_field(t1, f_qty, '3', null, 'ua');

  -- T634: nobody types into a calculated field
  n := 0;
  begin perform public.signer_fill_field(t1, f_total, '1.00', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 and not exists (select 1 from public.field_values v2 where v2.field_id = f_total)
  then res := res || E'PASS T634 a calculated field cannot be filled in by the signer\n';
  else res := res || E'FAIL T634 a calculated field took a typed value\n'; end if;

  -- T635: only the signer's own fields that have a condition can be passed as hidden
  n := 0;
  begin perform public.signer_complete(t1, repeat('d5', 32), today, null, 'ua', array[f_qty]); n := n + 1; exception when invalid_parameter_value then null; end;        -- no condition
  begin perform public.signer_complete(t1, repeat('d5', 32), today, null, 'ua', array[gen_random_uuid()]); n := n + 1; exception when invalid_parameter_value then null; end;  -- not a field
  begin perform public.signer_complete(t1, repeat('d5', 32), today, null, 'ua', array[f_sig]); n := n + 1; exception when invalid_parameter_value then null; end;        -- a signature
  if n = 0 and (select x.status from public.recipients x where x.id = s1) = 'consented'
  then res := res || E'PASS T635 a field without a condition, an unknown id or a signature cannot be passed as hidden\n';
  else res := res || 'FAIL T635 hidden list not checked :: n=' || n || E'\n'; end if;

  -- T636: a required field hidden by its condition is not asked for; a calculated field never blocks; the hidden list is recorded
  n := 0;
  begin perform public.signer_complete(t1, repeat('d5', 32), today, null, 'ua'); n := n + 1;                       -- old 5-argument call: extra_qty counts as visible
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like 'ES_FIELDS_MISSING%' then n := n + 10; end if; end;
  st := public.signer_complete(t1, repeat('d5', 32), today, null, 'ua', array[f_extra_qty]);
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'recipient_signed' order by x.seq desc limit 1;
  if n = 0 and st is not null and (select x.status from public.recipients x where x.id = s1) = 'signed'
     and pl -> 'hidden_fields' = jsonb_build_array(f_extra_qty) and not exists (select 1 from public.field_values v2 where v2.field_id = f_total)
  then res := res || E'PASS T636 a required field hidden by its condition is not asked for, a required calculated field never blocks signing, and the hidden fields are recorded in the signing event\n';
  else res := res || 'FAIL T636 completing with hidden fields :: n=' || n || ' st=' || coalesce(st, '?') || ' payload=' || coalesce(pl::text, 'null') || E'\n'; end if;
  execute 'reset role';

  -- T637: completing stays server-only; the old five-argument function is gone (one function, so no ambiguity)
  ok := not has_function_privilege('authenticated', 'public.signer_complete(uuid, text, text, inet, text, uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.signer_complete(uuid, text, text, inet, text, uuid[])', 'execute')
    and has_function_privilege('service_role', 'public.signer_complete(uuid, text, text, inet, text, uuid[])', 'execute')
    and (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'signer_complete') = 1;
  if ok then res := res || E'PASS T637 signing is server-only and exists once (the old form is gone)\n';
  else res := res || E'FAIL T637 signer_complete privileges or duplicates\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
