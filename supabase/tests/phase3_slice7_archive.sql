-- YouNMeSign SQL tests for migration 28: audit-trail archiving (AT3.10 technical part). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; folder_a uuid; e1 uuid; e2 uuid; d1 uuid; d2 uuid; s1 uuid; s2 uuid;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  h1 text := repeat('a1', 32); h2 text := repeat('a2', 32);
  body text := 'Slice 7 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  job record; ok boolean; n int; cnt int; i int; st text; t text; rows jsonb; last_seq int; head text; code1 text;
  v record; v2 record; r record; total int; arch int;
  path1 text; path2 text;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's17-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Ari Archive"}', now(), now());
  select x.org_id into org_a from public.memberships x where x.user_id = a and x.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s17-v1', body);

  execute 'set local role service_role';
  -- e1: completed and sealed
  select e.id, e.public_code into e1, code1 from public.create_envelope(a, org_a, 'Archive me', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c9', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Ada Archive","email":"s17-ada@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('91', 16), 'token_sha256', h1)), exp, 'link');
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 's17-v1', body_sha, null, 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5d', 32), null, null, null, 'ua');
  st := public.signer_complete(t1, repeat('d1', 32), today, null, 'ua');
  for i in 1..50 loop
    select * into job from public.claim_seal_job(300);
    exit when job.envelope_id is null or job.envelope_id = e1;
  end loop;
  ok := public.complete_seal_job(e1, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e1 || '/sealed.pdf', org_a || '/' || e1 || '/cert.pdf', job.audit_seq, job.audit_hash, repeat('ab', 32));
  -- e2: still open
  select e.id into e2 from public.create_envelope(a, org_a, 'Still open', folder_a) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'g.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('ca', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Otto Open","email":"s17-otto@example.test","role":"signer","routing_order":1}]');
  select x.id into s2 from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', s2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', s2, 'token_id', t2, 'nonce', repeat('92', 16), 'token_sha256', h2)), exp, 'link');

  rows := public.audit_archive_rows('env:' || e1);
  last_seq := jsonb_array_length(rows);
  head := rows -> (last_seq - 1) ->> 'event_hash';
  execute 'reset role';   -- the chain verifier is internal: not even the service role may call it
  select * into v from app_private.audit_verify('env:' || e1);
  execute 'set local role service_role';
  total := v.events;
  path1 := org_a || '/' || e1 || '/audit-1-' || last_seq || '.jsonl.gz';

  -- T541: finished documents are listed as due; open ones are not; the rows carry every column in chain order
  select count(*) into n from public.audit_archive_due(0, 100, e1) d where d.envelope_id = e1;
  select count(*) into cnt from public.audit_archive_due(0, 100, e2) d where d.envelope_id = e2;
  if st = 'sealing' and ok and n = 1 and cnt = 0 and last_seq = total and last_seq >= 8
     and (rows -> 0 ->> 'chain_seq')::int = 1 and rows -> 0 ->> 'prev_hash' = repeat('00', 32)
     and rows -> (last_seq - 1) ->> 'event_hash' = v.head
     and rows -> 0 ? 'canonical' and rows -> 0 ? 'ip' and rows -> 0 ? 'user_agent'
  then res := res || E'PASS T541 finished documents are listed for archiving (open ones are not), and their rows come with every column in chain order\n';
  else res := res || 'FAIL T541 due/rows :: due=' || n || ' open=' || cnt || ' rows=' || last_seq || ' total=' || total || E'\n'; end if;

  -- T542: nothing else can remove audit rows: a wrong range, a wrong head, a direct delete, another chain's rows
  n := 0;
  begin perform public.audit_archive_commit('env:' || e1, 2, last_seq, head, path1, repeat('ff', 32)); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.audit_archive_commit('env:' || e1, 1, last_seq, repeat('00', 32), path1, repeat('ff', 32)); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.audit_archive_commit('org:' || org_a, 1, 1, head, path1, repeat('ff', 32)); n := n + 1; exception when invalid_parameter_value then null; end;
  execute 'reset role';
  begin delete from public.audit_events x where x.chain_key = 'env:' || e1; n := n + 1; exception when insufficient_privilege then null; end;
  -- even with the marker set for e1, another chain's rows and rows beyond the range stay
  perform set_config('easysign.audit_archive_chain', 'env:' || e1, true);
  perform set_config('easysign.audit_archive_last', '2', true);
  begin delete from public.audit_events x where x.chain_key = 'env:' || e2; n := n + 1; exception when insufficient_privilege then null; end;
  begin delete from public.audit_events x where x.chain_key = 'env:' || e1 and x.chain_seq = 3; n := n + 1; exception when insufficient_privilege then null; end;
  begin update public.audit_events set payload = '{}' where chain_key = 'env:' || e1 and chain_seq = 1; n := n + 1; exception when insufficient_privilege then null; end;
  perform set_config('easysign.audit_archive_chain', '', true);
  perform set_config('easysign.audit_archive_last', '', true);
  execute 'set local role service_role';
  if n = 0 and (select count(*) from public.audit_events x where x.chain_key = 'env:' || e1) = total
  then res := res || E'PASS T542 audit rows stay append-only: a wrong range, a wrong head, a non-document chain, a direct delete, another chain or a row outside the range are all refused\n';
  else res := res || 'FAIL T542 door :: n=' || n || E'\n'; end if;

  -- T543 AT3.10: archiving removes exactly the range, keeps the head, and the chain still verifies
  n := public.audit_archive_commit('env:' || e1, 1, last_seq, head, path1, repeat('ab', 32));
  execute 'reset role';   -- the chain verifier is internal: not even the service role may call it
  select * into v2 from app_private.audit_verify('env:' || e1);
  execute 'set local role service_role';
  select * into r from public.audit_archives x where x.chain_key = 'env:' || e1;
  if n = last_seq and not exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1)
     and v2.ok and v2.events = total and v2.head = head
     and r.first_seq = 1 and r.last_seq = last_seq and encode(r.head_hash, 'hex') = head and r.org_id = org_a and r.envelope_id = e1
     and (select count(*) from public.audit_archive_due(0, 100, e1) d where d.envelope_id = e1) = 0
  then res := res || E'PASS T543 AT3.10: archiving removes exactly that range from the database, keeps its head, and the chain still verifies with the same head and count\n';
  else res := res || 'FAIL T543 commit :: n=' || n || ' ok=' || coalesce(v2.ok::text, '?') || ' events=' || coalesce(v2.events, -1) || E'\n'; end if;

  -- T544 AT3.10: /verify still answers, and its new audit event continues the archived chain
  v := null;
  select * into r from (select public.verify_lookup(code1, 'ip-s17') j) q;
  select * into v from public.audit_events x where x.chain_key = 'env:' || e1 order by x.chain_seq limit 1;
  execute 'reset role';   -- the chain verifier is internal: not even the service role may call it
  select * into v2 from app_private.audit_verify('env:' || e1);
  execute 'set local role service_role';
  if r.j ->> 'status' = 'completed' and r.j ->> 'final_sha256' = repeat('e2', 32)
     and v.chain_seq = last_seq + 1 and encode(v.prev_hash, 'hex') = head and v.event_type = 'verify_page_hit'
     and v2.ok and v2.events = total + 1
  then res := res || E'PASS T544 AT3.10: after archiving, /verify still answers and its audit event continues the chain from the archived head\n';
  else res := res || 'FAIL T544 continue :: ' || coalesce(r.j::text, 'null') || ' seq=' || coalesce(v.chain_seq, -1) || E'\n'; end if;

  -- T545: a later part can be archived after the first; parts must be contiguous
  rows := public.audit_archive_rows('env:' || e1);
  path2 := org_a || '/' || e1 || '/audit-' || (last_seq + 1) || '-' || (last_seq + 1) || '.jsonl.gz';
  n := 0;
  begin perform public.audit_archive_commit('env:' || e1, last_seq + 2, last_seq + 1, rows -> 0 ->> 'event_hash', path2, repeat('ac', 32)); n := n + 1; exception when invalid_parameter_value then null; end;
  arch := public.audit_archive_commit('env:' || e1, last_seq + 1, last_seq + 1, rows -> 0 ->> 'event_hash', path2, repeat('ac', 32));
  execute 'reset role';   -- the chain verifier is internal: not even the service role may call it
  select * into v2 from app_private.audit_verify('env:' || e1);
  execute 'set local role service_role';
  if n = 0 and arch = 1 and v2.ok and v2.events = total + 1 and (select count(*) from public.audit_archives x where x.chain_key = 'env:' || e1) = 2
  then res := res || E'PASS T545 later events can be archived as a second part right after the first; a gap is refused; the chain still verifies\n';
  else res := res || 'FAIL T545 second part :: n=' || n || ' arch=' || coalesce(arch, -1) || E'\n'; end if;

  -- T546: server-only; members can read the archive index of their own workspace only
  n := 0;
  foreach t in array array['public.audit_archive_due(integer, integer, uuid)', 'public.audit_archive_rows(text)', 'public.audit_archive_commit(text, integer, integer, text, text, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  if has_function_privilege('service_role', 'app_private.audit_head(text)', 'execute') then n := n + 1; end if;
  foreach t in array array['insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.audit_archives', t) or has_table_privilege('service_role', 'public.audit_archives', t) then n := n + 1; end if;
  end loop;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into cnt from public.audit_archives x where x.envelope_id = e1;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into i from public.audit_archives x where x.envelope_id = e1;
  execute 'reset role';
  if n = 0 and cnt = 2 and i = 0 and (select x.ok from app_private.audit_verify('env:' || e2) x)
  then res := res || E'PASS T546 the archive functions are server-only, the archive index is read-only and visible only to the workspace, and other chains are untouched\n';
  else res := res || 'FAIL T546 privileges :: n=' || n || ' own=' || cnt || ' other=' || i || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
