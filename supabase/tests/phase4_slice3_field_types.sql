-- YouNMeSign SQL tests for Phase 4 slice 3: more field types (D-78). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; s1 uuid; e2 uuid; d2 uuid; s2 uuid;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  h1 text := repeat('f6', 32); h2 text := repeat('f7', 32);
  body text := 'Slice 3 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  f_chk uuid; f_radio uuid; f_drop uuid; f_num uuid; f_txt uuid; f_note uuid; f_link uuid; f_att uuid; f_att2 uuid;
  n int; ok boolean; v text; st text; old_hash text; new_hash text; files jsonb;
  base jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't43-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Fay Fields"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s43-v1', body);

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Order form', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'order.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c4', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Cleo Client","email":"t43-cleo@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  base := jsonb_build_object('document_id', d1, 'recipient_id', s1, 'page', 1, 'w', 0.2, 'h', 0.03);

  -- T621: option shape is checked on every write
  n := 0;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'radio', 'x', 0.1, 'y', 0.1, 'options', jsonb_build_object('choices', '["A","B"]'::jsonb, 'onclick', 'x'))));
        n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'note', 'x', 0.1, 'y', 0.1, 'options', jsonb_build_object('text', repeat('x', 5000)))));
        n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.save_fields(a, e1, jsonb_build_array(base || jsonb_build_object('type', 'javascript', 'x', 0.1, 'y', 0.1)));
        n := n + 1; exception when check_violation then null; end;
  if n = 0 then res := res || E'PASS T621 field settings: unknown keys, oversized settings and unknown field types are refused on save\n';
  else res := res || 'FAIL T621 option shape :: n=' || n || E'\n'; end if;

  -- T622: a half set-up field can be saved in a draft but never sent
  perform public.save_fields(a, e1, jsonb_build_array(
    base || jsonb_build_object('type', 'signature', 'x', 0.1, 'y', 0.9, 'h', 0.06),
    base || jsonb_build_object('type', 'radio', 'x', 0.1, 'y', 0.1, 'options', jsonb_build_object('choices', '["Only one"]'::jsonb))));
  n := 0;
  begin perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('91', 16), 'token_sha256', h1)), exp, 'link');
        n := n + 1; exception when invalid_parameter_value then
          get stacked diagnostics v = message_text; if v not like 'ES_FIELD_SETUP: a radio field on page 1 is not ready: give at least two choices%' then n := n + 10; end if; end;
  -- now the real layout: every new type, all set up
  perform public.save_fields(a, e1, jsonb_build_array(
    base || jsonb_build_object('type', 'signature', 'x', 0.1, 'y', 0.9, 'h', 0.06),
    base || jsonb_build_object('type', 'checkbox', 'x', 0.1, 'y', 0.05, 'w', 0.03, 'h', 0.02, 'required', true),
    base || jsonb_build_object('type', 'radio', 'x', 0.1, 'y', 0.1, 'h', 0.08, 'options', jsonb_build_object('choices', '["Monthly","Yearly"]'::jsonb)),
    base || jsonb_build_object('type', 'dropdown', 'x', 0.1, 'y', 0.2, 'options', jsonb_build_object('choices', '["Red","Green","Blue"]'::jsonb)),
    base || jsonb_build_object('type', 'number', 'x', 0.1, 'y', 0.3, 'options', jsonb_build_object('min', 0, 'max', 1000, 'decimals', 2)),
    base || jsonb_build_object('type', 'text', 'x', 0.1, 'y', 0.4, 'options', jsonb_build_object('check', 'custom', 'pattern', '^[A-Z]{2}[0-9]{4}$', 'message', 'Use the policy number, like AB1234')),
    base || jsonb_build_object('type', 'note', 'x', 0.1, 'y', 0.5, 'required', true, 'options', jsonb_build_object('text', 'Payment is due within 30 days.')),
    base || jsonb_build_object('type', 'hyperlink', 'x', 0.1, 'y', 0.6, 'required', true, 'options', jsonb_build_object('url', 'https://example.com/terms', 'label', 'Our terms')),
    base || jsonb_build_object('type', 'attachment', 'x', 0.1, 'y', 0.7, 'required', true)));
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('91', 16), 'token_sha256', h1)), exp, 'link');
  if n = 0 and (select e.status from public.envelopes e where e.id = e1) = 'sent'
  then res := res || E'PASS T622 a draft may hold a half set-up field, but sending is refused with a plain reason until every field is ready\n';
  else res := res || 'FAIL T622 send-time check :: n=' || n || E'\n'; end if;
  select f.id into f_chk from public.fields f where f.envelope_id = e1 and f.type = 'checkbox';
  select f.id into f_radio from public.fields f where f.envelope_id = e1 and f.type = 'radio';
  select f.id into f_drop from public.fields f where f.envelope_id = e1 and f.type = 'dropdown';
  select f.id into f_num from public.fields f where f.envelope_id = e1 and f.type = 'number';
  select f.id into f_txt from public.fields f where f.envelope_id = e1 and f.type = 'text';
  select f.id into f_note from public.fields f where f.envelope_id = e1 and f.type = 'note';
  select f.id into f_link from public.fields f where f.envelope_id = e1 and f.type = 'hyperlink';
  select f.id into f_att from public.fields f where f.envelope_id = e1 and f.type = 'attachment';
  execute 'reset role';

  -- T623: the database rules give the same answers as the app's (examples shared with src/lib/field-options.test.ts)
  ok := app_private.field_options_problem('radio', '{"choices":["Yes"]}') is not null
    and app_private.field_options_problem('dropdown', '{"choices":["A","A"]}') like '%different%'
    and app_private.field_options_problem('radio', '{"choices":["Yes","No"]}') is null
    and app_private.field_options_problem('note', '{"text":"   "}') is not null
    and app_private.field_options_problem('hyperlink', '{"url":"example.com"}') is not null
    and app_private.field_options_problem('hyperlink', '{"url":"javascript:alert(1)"}') is not null
    and app_private.field_options_problem('hyperlink', '{"url":"https://example.com/terms"}') is null
    and app_private.field_options_problem('number', '{"min":10,"max":1}') like '%bigger%'
    and app_private.field_options_problem('text', '{"check":"custom"}') like '%pattern%'
    and app_private.field_options_problem('text', '{"check":"custom","pattern":"([a-z"}') like '%not valid%'
    and app_private.field_value_problem('number', '{"min":0,"max":1000,"decimals":2}', '12.50') is null
    and app_private.field_value_problem('number', '{"min":0,"max":1000,"decimals":2}', '-1') like '%smallest%'
    and app_private.field_value_problem('number', '{"min":0,"max":1000,"decimals":2}', '1000.01') like '%largest%'
    and app_private.field_value_problem('number', '{"min":0,"max":1000,"decimals":2}', '1.234') like '%2 decimal%'
    and app_private.field_value_problem('number', '{"decimals":0}', '3.5') like '%whole%'
    and app_private.field_value_problem('number', '{}', '1e3') is not null
    and app_private.field_value_problem('number', '{}', '12,5') is not null
    and app_private.field_value_problem('text', '{"check":"digits"}', '12345') is null
    and app_private.field_value_problem('text', '{"check":"digits"}', '12a45') like '%digits%'
    and app_private.field_value_problem('text', '{"check":"letters"}', 'Zoë O''Neil-Smith') is null
    and app_private.field_value_problem('text', '{"check":"email"}', 'a@b.co') is null
    and app_private.field_value_problem('text', '{"check":"phone"}', '+44 (20) 7946-0000') is null
    and app_private.field_value_problem('text', '{"check":"phone"}', '12') like '%phone%'
    and app_private.field_value_problem('dropdown', '{"choices":["Monthly","Yearly"]}', 'yearly') is not null
    and app_private.field_value_problem('checkbox', '{}', 'yes') is not null
    and app_private.field_value_problem('text', '{"check":"custom","pattern":"([a-z"}', 'x') like '%set up wrongly%';
  if ok then res := res || E'PASS T623 the database checks give the same answers as the editor and signer page on the shared examples\n';
  else res := res || E'FAIL T623 database and app checks disagree on a shared example\n'; end if;

  execute 'set local role service_role';
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 's43-v1', body_sha, '203.0.113.43', 'ua');
  -- T624: every value is checked by type before it is stored
  n := 0;
  begin perform public.signer_fill_field(t1, f_chk, 'yes', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_fill_field(t1, f_radio, 'Weekly', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_fill_field(t1, f_drop, 'red', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_fill_field(t1, f_num, '1000.5', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_fill_field(t1, f_txt, 'ab1234', null, 'ua'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v <> 'ES_VALUE_INVALID: Use the policy number, like AB1234' then n := n + 10; end if; end;
  begin perform public.signer_fill_field(t1, f_note, 'hello', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_fill_field(t1, f_link, 'hello', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_fill_field(t1, f_att, 'file.pdf', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.signer_fill_field(t1, f_chk, 'true', null, 'ua');
  perform public.signer_fill_field(t1, f_radio, 'Yearly', null, 'ua');
  perform public.signer_fill_field(t1, f_drop, 'Green', null, 'ua');
  perform public.signer_fill_field(t1, f_num, '249.99', null, 'ua');
  perform public.signer_fill_field(t1, f_txt, 'AB1234', null, 'ua');
  ok := (select string_agg(v2.value_text, ',' order by f.y) from public.field_values v2 join public.fields f on f.id = v2.field_id where f.envelope_id = e1)
        = 'true,Yearly,Green,249.99,AB1234';
  if n = 0 and ok then res := res || E'PASS T624 each type accepts only proper values (with the sender''s own message for a custom check); notes, links and attachments cannot be typed into\n';
  else res := res || 'FAIL T624 value checks :: n=' || n || ' ok=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T625: required: an unticked required checkbox and a missing attachment block signing; notes and links never do
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5d', 32), null, null, null, 'ua');
  perform public.signer_fill_field(t1, f_chk, '', null, 'ua');   -- untick
  n := 0;
  begin perform public.signer_complete(t1, repeat('d4', 32), today, null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.signer_fill_field(t1, f_chk, 'true', null, 'ua');
  begin perform public.signer_complete(t1, repeat('d4', 32), today, null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;  -- attachment still missing

  -- T626: attachments: checked, stored once per field, replaceable, and part of document deletion
  begin perform public.signer_attach(t1, f_att, 'supabase', org_a || '/' || gen_random_uuid() || '/att-' || gen_random_uuid() || '.pdf', 'x.pdf', 'pdf', 100, repeat('ab', 32), null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;  -- another document's folder
  begin perform public.signer_attach(t1, f_att, 'supabase', org_a || '/' || e1 || '/att-' || gen_random_uuid() || '.exe', 'x.exe', 'pdf', 100, repeat('ab', 32), null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_attach(t1, f_att, 'supabase', org_a || '/' || e1 || '/att-' || gen_random_uuid() || '.pdf', 'big.pdf', 'pdf', 6000000, repeat('ab', 32), null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_attach(t1, f_txt, 'supabase', org_a || '/' || e1 || '/att-' || gen_random_uuid() || '.pdf', 'x.pdf', 'pdf', 100, repeat('ab', 32), null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  v := public.signer_attach(t1, f_att, 'supabase', org_a || '/' || e1 || '/att-11111111-1111-4111-8111-111111111111.pdf', 'Proof of address.pdf', 'pdf', 2048, repeat('ab', 32), null, 'ua');
  ok := v is null;
  v := public.signer_attach(t1, f_att, 'supabase', org_a || '/' || e1 || '/att-22222222-2222-4222-8222-222222222222.png', 'photo.png', 'png', 4096, repeat('cd', 32), null, 'ua');
  ok := ok and v = org_a || '/' || e1 || '/att-11111111-1111-4111-8111-111111111111.pdf'
           and (select v2.value_text from public.field_values v2 where v2.field_id = f_att) = 'photo.png · SHA-256 cdcdcdcdcdcdcdcd'
           and (select count(*) from public.field_attachments t where t.field_id = f_att) = 1;
  st := public.signer_complete(t1, repeat('d4', 32), today, null, 'ua');
  if n = 0 and ok and st is not null and (select x.status from public.recipients x where x.id = s1) = 'signed'
  then res := res || E'PASS T625 an unticked required checkbox or a missing attachment stops signing; required notes and links never do\n'
                  || E'PASS T626 attachments: only into this document''s folder, PDF/PNG/JPG up to 5 MB, only on attachment fields; a new file replaces the old (whose path is returned for removal)\n';
  else res := res || 'FAIL T625/T626 required and attachments :: n=' || n || ' ok=' || coalesce(ok::text, '?') || ' st=' || coalesce(st, '?') || E'\n'; end if;

  -- deletion lists the attachment: a second document, attached and then cancelled, retention 0
  select e.id into e2 from public.create_envelope(a, org_a, 'Cancelled order', null) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'o2.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('c5', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Dev Deleted","email":"t43-dev@example.test","role":"signer","routing_order":1}]');
  select x.id into s2 from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(
    jsonb_build_object('document_id', d2, 'recipient_id', s2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.9, 'w', 0.2, 'h', 0.06),
    jsonb_build_object('document_id', d2, 'recipient_id', s2, 'type', 'attachment', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.04)));
  select f.id into f_att2 from public.fields f where f.envelope_id = e2 and f.type = 'attachment';
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', s2, 'token_id', t2, 'nonce', repeat('92', 16), 'token_sha256', h2)), exp, 'link');
  perform public.signer_open(h2, null, 'ua');
  perform public.signer_consent(t2, 's43-v1', body_sha, '203.0.113.44', 'ua');
  perform public.signer_attach(t2, f_att2, 'supabase', org_a || '/' || e2 || '/att-33333333-3333-4333-8333-333333333333.jpg', 'id.jpg', 'jpeg', 1000, repeat('ef', 32), null, 'ua');
  perform public.void_envelope(a, e2, 'test');
  perform public.set_retention_years(a, org_a, 0);
  files := public.begin_envelope_deletion(a, e2, null, 'ua');
  if files @> jsonb_build_array(jsonb_build_object('bucket', 'attachments', 'path', org_a || '/' || e2 || '/att-33333333-3333-4333-8333-333333333333.jpg'))
  then res := res || E'PASS T626b deleting a document also removes the files signers attached to it\n';
  else res := res || 'FAIL T626b deletion does not list the attachment :: ' || coalesce(files::text, 'null') || E'\n'; end if;
  execute 'reset role';

  -- T627: the layout fingerprint: exactly as before for fields without options (e2), and it covers options (e1)
  -- old_hash(x) = the formula before this migration
  select encode(sha256(convert_to(coalesce(string_agg(
           f.document_id::text || '|' || f.recipient_id::text || '|' || f.type || '|' || f.page::text || '|' ||
           f.x::text || '|' || f.y::text || '|' || f.w::text || '|' || f.h::text || '|' || f.required::text,
           E'\n' order by f.page, f.y, f.x, f.type, f.recipient_id), ''), 'UTF8')), 'hex')
    into old_hash from public.fields f where f.envelope_id = e2;
  select encode(sha256(convert_to(coalesce(string_agg(
           f.document_id::text || '|' || f.recipient_id::text || '|' || f.type || '|' || f.page::text || '|' ||
           f.x::text || '|' || f.y::text || '|' || f.w::text || '|' || f.h::text || '|' || f.required::text,
           E'\n' order by f.page, f.y, f.x, f.type, f.recipient_id), ''), 'UTF8')), 'hex')
    into new_hash from public.fields f where f.envelope_id = e1;
  ok := app_private.field_layout_hash(e2) = old_hash           -- no field of e2 has settings
        and app_private.field_layout_hash(e1) <> new_hash      -- e1's choices, limits, note text and link are covered
        and (select e.field_layout_sha256 from public.envelopes e where e.id = e1) = app_private.field_layout_hash(e1);
  if ok then res := res || E'PASS T627 the layout fingerprint now covers a field''s choices and settings; fields without settings fingerprint exactly as before\n';
  else res := res || E'FAIL T627 layout fingerprint\n'; end if;

  -- T628: nothing new is reachable from the browser; the stored path of an attachment is not readable there
  ok := not has_function_privilege('authenticated', 'public.signer_attach(uuid, uuid, text, text, text, text, bigint, text, inet, text)', 'execute')
    and not has_column_privilege('authenticated', 'public.field_attachments', 'storage_path', 'select')
    and has_column_privilege('authenticated', 'public.field_attachments', 'file_name', 'select')
    and not has_function_privilege('authenticated', 'app_private.field_value_problem(text, jsonb, text)', 'execute');
  if ok then res := res || E'PASS T628 attaching is server-only; the browser can list attachments of documents it may see but not their stored paths\n';
  else res := res || E'FAIL T628 something new is reachable from the browser\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
