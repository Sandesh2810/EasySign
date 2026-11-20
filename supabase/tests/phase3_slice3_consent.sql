-- YouNMeSign SQL tests for migration 21: consent wordings on file, withdrawing consent, paper-copy requests
-- and tasks for the sender (AT3.3). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- sender
  b uuid := gen_random_uuid();   -- someone in another organisation
  org_a uuid; folder_a uuid; e1 uuid; e2 uuid; d1 uuid; d2 uuid; s1 uuid; s2 uuid; ftxt uuid; fsig uuid; tk uuid; tk2 uuid;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  h1 text := repeat('d7', 32); h2 text := repeat('d8', 32);
  body text := E'Test consent wording, paragraph one.\n\nParagraph two.';
  body_sha text; v1_sha text := 'ad236c6a7805f9f3ca7f71bd184be15fb66364a65449387895194f918d18ae03';
  v2_sha text := '3575f0d05370b2d0ace22553c5e64fda07e169d0cbe22a79e716b634fa783f6c';
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  ok boolean; n int; cnt int; i int; vis_b int; st text; st2 text; t text; r record;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's13-sender@example.test', now(), '{"provider":"email"}', '{"full_name":"Sasha Sender"}', now(), now()),
         (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's13-other@example.test', now(), '{"provider":"email"}', '{"full_name":"Olly Other"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;

  execute 'set local role service_role';
  -- e1: one outside signer with a text field and a signature field
  select e.id into e1 from public.create_envelope(a, org_a, 'Consent test', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('e7', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Paula Paper","email":"s13-paula@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.1, 'w', 0.3, 'h', 0.05),
    jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  select f.id into ftxt from public.fields f where f.recipient_id = s1 and f.type = 'text';
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('77', 16), 'token_sha256', h1)), exp, 'link');
  perform public.signer_open(h1, '203.0.113.7', 'ua-open');
  -- e2: the sender signs their own document
  select e.id into e2 from public.create_envelope(a, org_a, 'Self test', folder_a) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'g.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('e8', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Sasha Sender","email":"s13-sender@example.test","role":"signer","routing_order":1}]');
  select x.id into s2 from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', s2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', s2, 'token_id', t2, 'nonce', repeat('78', 16), 'token_sha256', h2)), exp, 'link');
  perform public.signer_open(h2, null, 'ua');

  -- T511: wordings on file: computed from the text, one text per version, permanent
  body_sha := public.register_consent_version('s13-test-v1', body);
  n := 0;
  begin perform public.register_consent_version('s13-test-v1', body || ' changed'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.register_consent_version('Bad Version!', body); n := n + 1; exception when invalid_parameter_value then null; end;
  begin insert into public.consent_versions (version, sha256, body) values ('s13-direct', repeat('00', 32), 'x'); n := n + 1; exception when insufficient_privilege then null; end;
  execute 'reset role';
  begin update public.consent_versions set body = 'rewritten' where version = 'esign-consent-2026-11-v2'; n := n + 1; exception when insufficient_privilege then null; end;
  begin delete from public.consent_versions where version = 'esign-consent-2026-11-v1'; n := n + 1; exception when insufficient_privilege then null; end;
  execute 'set local role service_role';
  if n = 0 and body_sha = encode(sha256(convert_to(body, 'UTF8')), 'hex')
     and public.register_consent_version('s13-test-v1', body) = body_sha
     and (select v.sha256 from public.consent_versions v where v.version = 'esign-consent-2026-11-v1') = v1_sha
     and (select v.sha256 from public.consent_versions v where v.version = 'esign-consent-2026-11-v2') = v2_sha
     and (select v.body from public.consent_versions v where v.version = 'esign-consent-2026-11-v1') like 'You have been asked to review and sign a document electronically using EasySign.%'
  then res := res || E'PASS T511 consent wordings are on file word for word: the fingerprint is computed from the text, a version name means one text, and nothing on file can be changed or removed\n';
  else res := res || 'FAIL T511 registry :: n=' || n || E'\n'; end if;

  -- T512: a consent must name a wording on file; the record holds version, fingerprint, IP, device and time
  n := 0;
  begin perform public.signer_consent(t1, 'not-on-file', body_sha, '203.0.113.7', 'ua-consent'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_consent(t1, 's13-test-v1', repeat('ab', 32), '203.0.113.7', 'ua-consent'); n := n + 1; exception when invalid_parameter_value then null; end;
  st := (select x.status from public.recipients x where x.id = s1);
  perform public.signer_consent(t1, 's13-test-v1', body_sha, '203.0.113.7', 'ua-consent');
  select * into r from public.consents c where c.recipient_id = s1 and c.withdrawn_at is null;
  if n = 0 and st = 'viewed' and r.disclosure_version = 's13-test-v1' and r.disclosure_sha256 = body_sha and r.ip = '203.0.113.7'::inet
     and r.user_agent = 'ua-consent' and r.given_at > now() - interval '1 minute'
     and (select x.payload ->> 'disclosure_sha256' from public.audit_events x where x.recipient_id = s1 and x.event_type = 'consent_given') = body_sha
  then res := res || E'PASS T512 AT3.3: consent must name a wording on file; the record holds the version, its fingerprint, the IP address, the device and the time\n';
  else res := res || 'FAIL T512 consent record :: n=' || n || ' st=' || coalesce(st, '?') || E'\n'; end if;

  -- T513: withdrawing clears what was done, blocks signing until the signer agrees again, and tells the sender
  perform public.signer_fill_field(t1, ftxt, 'ACME Ltd', null, 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5b', 32), null, null, null, 'ua');
  st := public.signer_withdraw_consent(t1, 'I would rather read it on paper first', false, '203.0.113.8', 'ua-withdraw');
  n := 0;
  begin perform public.signer_fill_field(t1, ftxt, 'again', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_complete(t1, repeat('d1', 32), today, null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  select * into r from public.audit_events x where x.recipient_id = s1 and x.event_type = 'consent_withdrawn';
  if st = 'withdrawn' and n = 0
     and (select x.status from public.recipients x where x.id = s1) = 'viewed'
     and not exists (select 1 from public.consents c where c.recipient_id = s1 and c.withdrawn_at is null)
     and not exists (select 1 from public.field_values v where v.recipient_id = s1)
     and not exists (select 1 from public.signature_assets s where s.recipient_id = s1)
     and r.ip = '203.0.113.8'::inet and r.user_agent = 'ua-withdraw' and r.payload ->> 'version' = 's13-test-v1'
     and (r.payload ->> 'values_cleared')::int = 1 and (r.payload ->> 'signatures_cleared')::int = 1
     and r.payload ->> 'reason_sha256' = encode(sha256(convert_to('I would rather read it on paper first', 'UTF8')), 'hex')
     and r.payload::text not ilike '%paper first%'
     and (select t.note from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'consent_withdrawn' and t.done_at is null) = 'I would rather read it on paper first'
     and exists (select 1 from public.notifications x where x.user_id = a and x.kind = 'consent_withdrawn' and x.payload ->> 'envelope_id' = e1::text and x.payload ->> 'by' = 'Paula Paper')
     and exists (select 1 from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'withdrawn_sender' and o.to_user_id = a
                   and o.payload ->> 'task_id' = (select t.id::text from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'consent_withdrawn'))
  then res := res || E'PASS T513 AT3.3: withdrawing consent clears what the signer filled in and adopted, blocks signing, keeps the reason out of the audit trail and tells the sender (task, notice, email)\n';
  else res := res || 'FAIL T513 withdraw :: st=' || coalesce(st, '?') || ' n=' || n || E'\n'; end if;

  -- T514: agreeing again works; nothing to withdraw says so; asking for paper while withdrawing opens a second task
  st := public.signer_withdraw_consent(t1, null, false, null, 'ua');   -- not consented any more
  perform public.signer_consent(t1, 's13-test-v1', body_sha, null, 'ua-again');
  select count(*) into n from public.consents c where c.recipient_id = s1;
  select count(*) into cnt from public.consents c where c.recipient_id = s1 and c.withdrawn_at is null;
  st2 := public.signer_withdraw_consent(t1, null, true, null, 'ua');
  if st = 'not_consented' and n = 2 and cnt = 1 and st2 = 'withdrawn'
     and (select count(*) from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'consent_withdrawn' and t.done_at is null) = 1
     and (select count(*) from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'withdrawn_sender') = 1
     and exists (select 1 from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'paper_copy' and t.done_at is null)
     and exists (select 1 from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'paper_copy_sender')
     and exists (select 1 from public.audit_events x where x.recipient_id = s1 and x.event_type = 'paper_copy_requested')
  then res := res || E'PASS T514 a signer can agree again after withdrawing; an open task is not duplicated or emailed twice; withdrawing can also ask for a paper copy\n';
  else res := res || 'FAIL T514 renew :: st=' || coalesce(st, '?') || ' consents=' || n || ' active=' || cnt || ' st2=' || coalesce(st2, '?') || E'\n'; end if;

  -- T515: asking for a paper copy creates one task; the note stays out of the audit trail
  select t.id into tk from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'paper_copy' and t.done_at is null;
  st := public.signer_request_paper_copy(t1, 'Post it to my office please', null, 'ua');
  perform public.complete_sender_task(a, tk);
  st2 := public.signer_request_paper_copy(t1, 'Post it to my office please', '203.0.113.9', 'ua-paper');
  select * into r from public.audit_events x where x.recipient_id = s1 and x.event_type = 'paper_copy_requested' order by x.seq desc limit 1;
  if st = 'already_requested' and st2 = 'requested'
     and (select t.note from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'paper_copy' and t.done_at is null) = 'Post it to my office please'
     and r.ip = '203.0.113.9'::inet and (r.payload ->> 'note_given')::boolean
     and r.payload ->> 'note_sha256' = encode(sha256(convert_to('Post it to my office please', 'UTF8')), 'hex') and r.payload::text not ilike '%office%'
     and (select count(*) from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'paper_copy_sender') = 2
     and exists (select 1 from public.notifications x where x.user_id = a and x.kind = 'paper_copy_requested')
  then res := res || E'PASS T515 AT3.3: a paper-copy request creates a task for the sender and tells them; a second request while one is open adds nothing\n';
  else res := res || 'FAIL T515 paper :: st=' || coalesce(st, '?') || ' st2=' || coalesce(st2, '?') || E'\n'; end if;

  -- T516: only the sender's organisation can see or close a task; closing is audited; repeat requests are limited
  select t.id into tk2 from public.sender_tasks t where t.recipient_id = s1 and t.kind = 'paper_copy' and t.done_at is null;
  n := 0;
  begin perform public.complete_sender_task(b, tk2); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.complete_sender_task(null, tk2); n := n + 1; exception when invalid_authorization_specification then null; end;
  st := public.complete_sender_task(a, tk2);
  st2 := public.complete_sender_task(a, tk2);
  cnt := 0;
  for i in 1..6 loop
    t := public.signer_request_paper_copy(t1, null, null, 'ua');
    if t = 'limited' then cnt := cnt + 1;
    elsif t = 'requested' then perform public.complete_sender_task(a, (select x.id from public.sender_tasks x where x.recipient_id = s1 and x.kind = 'paper_copy' and x.done_at is null));
    end if;
  end loop;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into i from public.sender_tasks t where t.envelope_id = e1;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into vis_b from public.sender_tasks t where t.envelope_id = e1;
  execute 'set local role service_role';
  if n = 0 and st = 'done' and st2 = 'already_done' and vis_b = 0
     and (select t.done_by from public.sender_tasks t where t.id = tk2) = a
     and exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type = 'sender_task_done' and x.actor_id = a and x.payload ->> 'task_id' = tk2::text)
     and cnt >= 2 and i >= 4
  then res := res || E'PASS T516 only the sender''s organisation can see or close a task; closing it is audited; repeated paper requests are rate limited\n';
  else res := res || 'FAIL T516 tasks :: n=' || n || ' st=' || coalesce(st, '?') || ' st2=' || coalesce(st2, '?') || ' limited=' || cnt || ' visible=' || i || ' other-org=' || vis_b || E'\n'; end if;

  -- T517: the sender's own document: a notice in the app, but no email to themself
  perform public.signer_consent(t2, 's13-test-v1', body_sha, null, 'ua');
  st := public.signer_withdraw_consent(t2, null, true, null, 'ua');
  if st = 'withdrawn'
     and (select count(*) from public.sender_tasks t where t.recipient_id = s2) = 2
     and not exists (select 1 from public.notification_outbox o where o.envelope_id = e2 and o.kind in ('withdrawn_sender', 'paper_copy_sender'))
     and exists (select 1 from public.notifications x where x.user_id = a and x.kind = 'consent_withdrawn' and x.payload ->> 'envelope_id' = e2::text)
  then res := res || E'PASS T517 on the sender''s own document the task and notice are recorded but no email is sent\n';
  else res := res || 'FAIL T517 self :: st=' || coalesce(st, '?') || E'\n'; end if;

  -- T518: server-only functions; tables closed to the browser roles; audit chains verify
  n := 0;
  foreach t in array array['public.register_consent_version(text, text)', 'public.signer_withdraw_consent(uuid, text, boolean, inet, text)',
                           'public.signer_request_paper_copy(uuid, text, inet, text)', 'public.complete_sender_task(uuid, uuid)',
                           'public.signer_consent(uuid, text, text, inet, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  if has_function_privilege('service_role', 'app_private.open_sender_task(public.recipients, text, text)', 'execute') then n := n + 1; end if;
  if has_table_privilege('authenticated', 'public.consent_versions', 'select') or has_table_privilege('anon', 'public.consent_versions', 'select') then n := n + 1; end if;
  foreach t in array array['insert', 'update', 'delete', 'truncate'] loop
    if has_table_privilege('authenticated', 'public.sender_tasks', t) or has_table_privilege('service_role', 'public.sender_tasks', t)
       or has_table_privilege('service_role', 'public.consent_versions', t) then n := n + 1; end if;
  end loop;
  execute 'reset role';
  if n = 0 and (select v.ok from app_private.audit_verify('env:' || e1) v) and (select v.ok from app_private.audit_verify('env:' || e2) v)
  then res := res || E'PASS T518 the new functions are server-only, the browser cannot read the wordings or write tasks, and the audit chains verify\n';
  else res := res || 'FAIL T518 privileges or chains :: ' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
