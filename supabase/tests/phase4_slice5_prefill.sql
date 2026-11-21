-- YouNMeSign SQL tests for Phase 4 slice 5: prefill and merge fields (D-80). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; s1 uuid;
  t1 uuid := gen_random_uuid();
  h1 text := repeat('f9', 32);
  body text := 'Slice 5 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  f_co uuid; f_greet uuid; f_mail uuid; f_amt uuid; f_chk uuid; f_plan uuid; f_note uuid;
  sender_name text;
  n int; ok boolean; v text; st text; pl jsonb;
  base jsonb;
  good jsonb;
  tok jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't45-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Pat Prefill"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  select coalesce(nullif(btrim(p.display_name), ''), 't45-owner@example.test') into sender_name from public.profiles p where p.id = a;
  body_sha := public.register_consent_version('s45-v1', body);

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Lease 2027', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'lease.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c7', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Cleo Client","email":"t45-cleo@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  base := jsonb_build_object('document_id', d1, 'recipient_id', s1, 'page', 1, 'w', 0.3, 'h', 0.03);
  tok := jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('94', 16), 'token_sha256', h1));
  good := jsonb_build_array(
    base || jsonb_build_object('type', 'signature', 'x', 0.1, 'y', 0.9, 'h', 0.06),
    base || jsonb_build_object('type', 'company', 'x', 0.1, 'y', 0.05, 'options', jsonb_build_object('prefill', 'Acme Ltd', 'readonly', true)),
    base || jsonb_build_object('type', 'text', 'x', 0.1, 'y', 0.1, 'required', false, 'options', jsonb_build_object('prefill', 'Dear {{first_name}} of {{document_title}}')),
    base || jsonb_build_object('type', 'text', 'x', 0.1, 'y', 0.15, 'options', jsonb_build_object('check', 'email', 'prefill', '{{email}}', 'readonly', true)),
    base || jsonb_build_object('type', 'number', 'x', 0.1, 'y', 0.2, 'required', true, 'options', jsonb_build_object('decimals', 0, 'prefill', '1200')),
    base || jsonb_build_object('type', 'checkbox', 'x', 0.1, 'y', 0.25, 'w', 0.03, 'h', 0.02, 'required', true, 'options', jsonb_build_object('prefill', 'true')),
    base || jsonb_build_object('type', 'radio', 'x', 0.1, 'y', 0.3, 'h', 0.08, 'options', jsonb_build_object('choices', '["Monthly","Yearly"]'::jsonb, 'prefill', 'Yearly')),
    base || jsonb_build_object('type', 'note', 'x', 0.1, 'y', 0.4, 'h', 0.05, 'options', jsonb_build_object('text', 'Prepared by {{sender_name}} ({{sender_email}}) for {{name}}')));

  -- T641: the new settings save; unknown settings are still refused
  n := 0;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'text', 'x', 0.1, 'y', 0.1, 'options', jsonb_build_object('prefil', 'x'))));
        n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.save_fields(a, e1, good);
  if n = 0 and (select count(*) from public.fields f where f.envelope_id = e1 and f.options ? 'prefill') = 6
     and (select count(*) from public.field_values v2 where v2.envelope_id = e1) = 0
  then res := res || E'PASS T641 prefilled values and "cannot be changed" save in a draft (nothing is stored as a value yet); unknown settings are still refused\n';
  else res := res || 'FAIL T641 settings shape :: n=' || n || E'\n'; end if;

  -- T642: sending is refused for a prefilled value the signer could not have given, a lock without a value, an unknown
  -- placeholder, a merged value that fails the field's check, or a prefill on a signature; a proper setup sends
  n := 0;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'radio', 'x', 0.5, 'y', 0.5, 'h', 0.08, 'options', jsonb_build_object('choices', '["Monthly","Yearly"]'::jsonb, 'prefill', 'Weekly'))));
  begin perform public.send_envelope(a, e1, tok, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text;
          if v not like 'ES_FIELD_SETUP: a radio field on page 1 is not ready: prefilled value: choose one of the options%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'text', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('readonly', true))));
  begin perform public.send_envelope(a, e1, tok, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like '%needs a prefilled value%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'note', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('text', 'Hello {{nmae}}'))));
  begin perform public.send_envelope(a, e1, tok, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like '%note: "{{nmae}}" is not a merge field%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'text', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('check', 'digits', 'prefill', '{{name}}'))));
  begin perform public.send_envelope(a, e1, tok, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text;
          if v not like 'ES_FIELD_SETUP: a text field on page 1 is not ready: prefilled value for Cleo Client: use digits only%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good || jsonb_build_array(base || jsonb_build_object('type', 'initials', 'x', 0.5, 'y', 0.5, 'options', jsonb_build_object('prefill', 'CC'))));
  begin perform public.send_envelope(a, e1, tok, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like '%only fields the signer fills in can be prefilled%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, good);
  perform public.send_envelope(a, e1, tok, exp, 'link');
  if n = 0 and (select e.status from public.envelopes e where e.id = e1) = 'sent'
  then res := res || E'PASS T642 sending is refused for an impossible prefilled value, a lock without a value, an unknown placeholder, a merged value that fails its check, and a prefilled signature field; a proper setup sends\n';
  else res := res || 'FAIL T642 send-time checks :: n=' || n || ' last=' || coalesce(v, '?') || E'\n'; end if;
  select f.id into f_co from public.fields f where f.envelope_id = e1 and f.type = 'company';
  select f.id into f_greet from public.fields f where f.envelope_id = e1 and f.type = 'text' and f.y = 0.1;
  select f.id into f_mail from public.fields f where f.envelope_id = e1 and f.type = 'text' and f.y = 0.15;
  select f.id into f_amt from public.fields f where f.envelope_id = e1 and f.type = 'number';
  select f.id into f_chk from public.fields f where f.envelope_id = e1 and f.type = 'checkbox';
  select f.id into f_plan from public.fields f where f.envelope_id = e1 and f.type = 'radio';
  select f.id into f_note from public.fields f where f.envelope_id = e1 and f.type = 'note';
  execute 'reset role';

  -- T643: the database's rules give the same answers as the app's (examples shared with src/lib/prefill.test.ts and merge.test.ts)
  ok := app_private.field_options_problem('text', '{"readonly":true}') like '%needs a prefilled value%'
    and app_private.field_options_problem('text', '{"readonly":true,"prefill":"  "}') like '%needs a prefilled value%'
    and app_private.field_options_problem('text', '{"readonly":true,"prefill":"Acme Ltd"}') is null
    and app_private.field_options_problem('signature', '{"prefill":"x"}') like 'only fields the signer fills in%'
    and app_private.field_options_problem('formula', '{"formula":"1","prefill":"2"}') like 'only fields the signer fills in%'
    and app_private.field_options_problem('radio', '{"choices":["Monthly","Yearly"],"prefill":"Weekly"}') like 'prefilled value: choose one%'
    and app_private.field_options_problem('radio', '{"choices":["Monthly","Yearly"],"prefill":"Yearly"}') is null
    and app_private.field_options_problem('number', '{"max":100,"prefill":"250"}') = 'prefilled value: the largest allowed is 100'
    and app_private.field_options_problem('number', '{"decimals":0,"prefill":"12"}') is null
    and app_private.field_options_problem('checkbox', '{"prefill":"yes"}') like 'prefilled value: tick the box%'
    and app_private.field_options_problem('checkbox', '{"prefill":"true","readonly":true}') is null
    and app_private.field_options_problem('text', '{"check":"digits","prefill":"abc"}') like 'prefilled value: use digits only%'
    and app_private.field_options_problem('text', '{"prefill":"Dear {{first_name}}"}') is null
    and app_private.field_options_problem('text', '{"prefill":"Dear {{frist_name}}"}') like '%"{{frist_name}}" is not a merge field'
    and app_private.field_options_problem('number', '{"prefill":"{{name}}"}') like 'merge text%only be used in text, company and title%'
    and app_private.field_options_problem('text', '{"check":"email","prefill":"{{email}}"}') is null
    and app_private.field_options_problem('note', '{"text":"Hello {{name}}"}') is null
    and app_private.field_options_problem('note', '{"text":"Hello {{nmae}}"}') like 'note: "{{nmae}}" is not a merge field'
    and app_private.merge_text('Dear {{first_name}}, ({{name}}, {{email}})', 'Cleo Client', 'cleo@example.test', 'Sam Sender', 'sam@example.test', 'Lease 2027') = 'Dear Cleo, (Cleo Client, cleo@example.test)'
    and app_private.merge_text('From {{sender_name}} <{{sender_email}}> re {{document_title}}', 'Cleo Client', 'cleo@example.test', 'Sam Sender', 'sam@example.test', 'Lease 2027') = 'From Sam Sender <sam@example.test> re Lease 2027'
    and app_private.merge_text('{{ NAME }} / {{First_Name}}', 'Cleo Client', 'cleo@example.test', 'Sam Sender', 'sam@example.test', 'Lease 2027') = 'Cleo Client / Cleo'
    and app_private.merge_text('No merge here { name }', 'Cleo Client', 'c', 's', 'e', 't') = 'No merge here { name }'
    and app_private.merge_text('{{name}}', '{{email}} & \1 $1', 'cleo@example.test', 's', 'e', 't') = '{{email}} & \1 $1'
    and app_private.merge_text('{{first_name}}', 'Prince', 'c', 's', 'e', 't') = 'Prince'
    and app_private.merge_text('{{first_name}}', '  Ana  Maria Lopez ', 'c', 's', 'e', 't') = 'Ana'
    and app_private.merge_text('Hi {{nope}} {{name}}', 'Cleo Client', 'c', 's', 'e', 't') = 'Hi {{nope}} Cleo Client';
  if ok then res := res || E'PASS T643 the database''s rules for prefilled values and merge text agree with the editor on the shared examples\n';
  else res := res || E'FAIL T643 database and app disagree on a shared example\n'; end if;

  -- T644: on sending, the prefilled values and merged notes are stored (merged with this person's and the sender's details) and audited
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'fields_prefilled';
  ok := (select v2.value_text from public.field_values v2 where v2.field_id = f_co) = 'Acme Ltd'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_greet) = 'Dear Cleo of Lease 2027'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_mail) = 't45-cleo@example.test'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_amt) = '1200'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_chk) = 'true'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_plan) = 'Yearly'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_note) = 'Prepared by ' || sender_name || ' (t45-owner@example.test) for Cleo Client'
    and (pl ->> 'fields')::int = 7 and pl ->> 'values_sha256' ~ '^[0-9a-f]{64}$';
  if ok then res := res || E'PASS T644 sending stores every prefilled value and merged note (person''s and sender''s details, document title) and records one audit event with their fingerprint\n';
  else res := res || 'FAIL T644 prefilled values at sending :: payload=' || coalesce(pl::text, 'null') || E'\n'; end if;

  execute 'set local role service_role';
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 's45-v1', body_sha, '203.0.113.45', 'ua');
  -- T645: a locked value cannot be changed or cleared; an unlocked prefilled value can
  n := 0;
  begin perform public.signer_fill_field(t1, f_co, 'Other Ltd', null, 'ua'); n := n + 1;
        exception when insufficient_privilege then get stacked diagnostics v = message_text; if v not like 'ES_FIELD_READONLY%' then n := n + 10; end if; end;
  begin perform public.signer_fill_field(t1, f_mail, '', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.signer_fill_field(t1, f_greet, 'Dear Cleo, welcome', null, 'ua');
  if n = 0 and (select v2.value_text from public.field_values v2 where v2.field_id = f_co) = 'Acme Ltd'
     and (select v2.value_text from public.field_values v2 where v2.field_id = f_mail) = 't45-cleo@example.test'
     and (select v2.value_text from public.field_values v2 where v2.field_id = f_greet) = 'Dear Cleo, welcome'
  then res := res || E'PASS T645 a value the sender locked cannot be changed or cleared by the signer; an unlocked prefilled value can be changed\n';
  else res := res || 'FAIL T645 locked values :: n=' || n || E'\n'; end if;

  -- T646: prefilled values count as filled in: the signer signs without touching the required number and checkbox
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5f', 32), null, null, null, 'ua');
  st := public.signer_complete(t1, repeat('d6', 32), today, null, 'ua');
  if st is not null and (select x.status from public.recipients x where x.id = s1) = 'signed'
  then res := res || E'PASS T646 required fields the sender prefilled count as filled in\n';
  else res := res || 'FAIL T646 completing with prefilled required fields :: st=' || coalesce(st, '?') || E'\n'; end if;
  execute 'reset role';

  -- T647: the new functions are internal
  ok := not has_function_privilege('authenticated', 'app_private.merge_text(text, text, text, text, text, text)', 'execute')
    and not has_function_privilege('service_role', 'app_private.merge_text(text, text, text, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.merge_unknown(text)', 'execute')
    and not has_function_privilege('anon', 'app_private.envelopes_prefill()', 'execute')
    and not has_function_privilege('authenticated', 'app_private.envelopes_prefill()', 'execute');
  if ok then res := res || E'PASS T647 merging and prefilling run only inside the database\n';
  else res := res || E'FAIL T647 a new function is reachable from outside\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
