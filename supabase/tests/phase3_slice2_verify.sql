-- YouNMeSign SQL tests for migration 20: public verification and the seal key id (AT3.2, AT3.1).
-- Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- sender
  org_a uuid; folder_a uuid; e1 uuid; e2 uuid; e3 uuid; d1 uuid; d3 uuid; s1 uuid; s3 uuid; f1 uuid;
  code1 text; code2 text; code3 text;
  t1 uuid := gen_random_uuid(); t3 uuid := gen_random_uuid();
  h1 text := repeat('d1', 32); h3 text := repeat('d3', 32);
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  job record; ok boolean; r jsonb; r2 jsonb; n int; cnt int; i int; st text; t text; keys text[];
begin
  perform public.register_consent_version('v1', 'Test consent wording');   -- slice 3: consents must name a wording on file
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's12-sender@example.test', now(), '{"provider":"email"}', '{"full_name":"Sid Sender"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;

  execute 'set local role service_role';
  -- e1: completed and sealed; e2: draft; e3: sent, not signed
  select e.id, e.public_code into e1, code1 from public.create_envelope(a, org_a, 'Confidential: Vera Verifier lease', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('e5', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Vera Verifier","email":"s12-vera@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('71', 16), 'token_sha256', h1)), exp, 'link');
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 'v1', '252af77b5bc802dfb2722865f1f3522bbae2738e617af28df5b6e5bdeea7af3e', null, 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5a', 32), null, null, null, 'ua');
  st := public.signer_complete(t1, repeat('d1', 32), today, null, 'ua');
  select * into job from public.claim_seal_job(300);

  select e.id, e.public_code into e2, code2 from public.create_envelope(a, org_a, 'Draft one', folder_a) e;

  select e.id, e.public_code into e3, code3 from public.create_envelope(a, org_a, 'Waiting one', folder_a) e;
  select d.id into d3 from public.add_envelope_document(a, e3, 'g.pdf', 'supabase', org_a || '/' || e3 || '/d3', repeat('e6', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e3, '[{"name":"Walt Waiting","email":"s12-walt@example.test","role":"signer","routing_order":1}]');
  select x.id into s3 from public.recipients x where x.envelope_id = e3;
  perform public.save_fields(a, e3, jsonb_build_array(jsonb_build_object('document_id', d3, 'recipient_id', s3, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e3, jsonb_build_array(jsonb_build_object('recipient_id', s3, 'token_id', t3, 'nonce', repeat('73', 16), 'token_sha256', h3)), exp, 'link');

  -- T506 (first, it completes e1): the seal key id is checked, stored and audited
  n := 0;
  begin perform public.complete_seal_job(e1, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e1 || '/sealed.pdf', org_a || '/' || e1 || '/cert.pdf', job.audit_seq, job.audit_hash, 'not-a-key-id');
    n := n + 1; exception when invalid_parameter_value then null; end;
  ok := public.complete_seal_job(e1, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e1 || '/sealed.pdf', org_a || '/' || e1 || '/cert.pdf', job.audit_seq, job.audit_hash, repeat('ab', 32));
  execute 'reset role';
  begin update public.envelopes set seal_key_id = repeat('cd', 32) where id = e1; n := n + 1; exception when insufficient_privilege then null; end;
  execute 'set local role service_role';
  if st = 'sealing' and job.envelope_id = e1 and ok and n = 0
     and (select e.seal_key_id from public.envelopes e where e.id = e1) = repeat('ab', 32)
     and (select x.payload ->> 'seal_key_id' from public.audit_events x where x.envelope_id = e1 and x.event_type = 'sealing_completed') = repeat('ab', 32)
     and to_regprocedure('public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text)') is null
  then res := res || E'PASS T506 the seal key id is checked, kept on the completed document and in its audit trail, and cannot be changed afterwards\n';
  else res := res || 'FAIL T506 seal key id :: st=' || coalesce(st, '?') || ' ok=' || coalesce(ok::text, '?') || ' n=' || n || ' job=' || coalesce(job.envelope_id::text, 'none') || E'\n'; end if;

  -- T501: a completed document: status, completion time, number of signers, hashes, seal key; no names, emails or title
  r := public.verify_lookup(lower(code1), 'ip-a');
  select array_agg(k order by k) into keys from jsonb_object_keys(r) k;
  if r ->> 'found' = 'true' and r ->> 'status' = 'completed' and r ->> 'code' = code1
     and (r ->> 'completed_at')::timestamptz = (select e.completed_at from public.envelopes e where e.id = e1)
     and (r ->> 'signer_count')::int = 1
     and r ->> 'final_sha256' = repeat('e2', 32) and r ->> 'preseal_sha256' = repeat('e1', 32) and r ->> 'seal_key_id' = repeat('ab', 32)
     and keys = array['code', 'completed_at', 'final_sha256', 'found', 'preseal_sha256', 'seal_key_id', 'signer_count', 'status']
     and r::text not ilike '%vera%' and r::text not ilike '%sid sender%' and r::text not like '%@%' and r::text not ilike '%lease%'
  then res := res || E'PASS T501 AT3.2: a verification code shows status, completion time, number of signers and the hashes, and no names, emails or title\n';
  else res := res || 'FAIL T501 completed lookup :: ' || coalesce(r::text, 'null') || E'\n'; end if;

  -- T502: unknown, malformed and draft codes all get the same answer
  r := public.verify_lookup('ES-2611-AAAA-BBBB-CCCC-DD', 'ip-b');
  r2 := public.verify_lookup(code2, 'ip-b');
  if r = '{"found": false}'::jsonb and r2 = r and public.verify_lookup('nonsense', 'ip-b') = r and public.verify_lookup(null, 'ip-b') = r
  then res := res || E'PASS T502 AT3.2: an unknown code, a malformed code and a draft all get the same "not found"\n';
  else res := res || 'FAIL T502 not found :: ' || coalesce(r::text, 'null') || ' / ' || coalesce(r2::text, 'null') || E'\n'; end if;

  -- T503: a document that is still being signed says so, without hashes or a completion time
  r := public.verify_lookup(code3, 'ip-c');
  if r ->> 'status' = 'in_progress' and r -> 'completed_at' = 'null'::jsonb and r -> 'final_sha256' = 'null'::jsonb and r -> 'signer_count' = 'null'::jsonb
     and r::text not ilike '%walt%'
  then res := res || E'PASS T503 a document still being signed shows only that it is in progress\n';
  else res := res || 'FAIL T503 in progress :: ' || coalesce(r::text, 'null') || E'\n'; end if;

  -- T504: rate limits: 20 lookups per caller per 10 minutes, 60 per code per hour
  n := 0;
  for i in 1..21 loop
    if public.verify_lookup('ES-2611-ZZZZ-ZZZZ-ZZZZ-ZZ', 'ip-d') ? 'limited' then n := n + 1; end if;
  end loop;
  r := public.verify_lookup(code1, 'ip-e');   -- another caller is unaffected
  cnt := 0;
  for i in 1..61 loop
    if public.verify_lookup(code3, 'ip-code-' || i) ? 'limited' then cnt := cnt + 1; end if;
  end loop;
  if n = 1 and r ->> 'found' = 'true' and cnt between 1 and 2
  then res := res || E'PASS T504 AT3.2: lookups are rate limited per caller (20 in 10 minutes) and per code (60 an hour); other callers are unaffected\n';
  else res := res || 'FAIL T504 rate limit :: caller-limited=' || n || ' code-limited=' || cnt || ' other=' || coalesce(r::text, 'null') || E'\n'; end if;

  -- T505: every lookup that finds a document is in its audit trail, without IP or device
  select count(*) into n from public.audit_events x where x.envelope_id = e1 and x.event_type = 'verify_page_hit';
  select count(*) into cnt from public.audit_events x
   where x.envelope_id = e1 and x.event_type = 'verify_page_hit' and x.payload = '{"status": "completed"}'::jsonb and x.ip is null and x.user_agent is null and x.actor_id is null;
  if n = 2 and cnt = 2 and not exists (select 1 from public.audit_events x where x.envelope_id = e2 and x.event_type = 'verify_page_hit')
  then res := res || E'PASS T505 each lookup that finds a document is written to its audit trail, with no IP address or device\n';
  else res := res || 'FAIL T505 audit :: hits=' || n || ' clean=' || cnt || E'\n'; end if;

  -- T507: server-only; chains verify
  n := 0;
  foreach t in array array['public.verify_lookup(text, text)', 'public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  execute 'reset role';
  if n = 0 and (select v2.ok from app_private.audit_verify('env:' || e1) v2) and (select v2.ok from app_private.audit_verify('env:' || e3) v2)
  then res := res || E'PASS T507 both functions are server-only, and the audit chains verify after the lookups\n';
  else res := res || 'FAIL T507 privileges or chains :: ' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
