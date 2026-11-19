-- EasySign SQL tests for migration 19: fixes from the independent review of Phase 2 (D-63).
-- Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- sender
  b uuid := gen_random_uuid();   -- administrator
  org_a uuid; folder_a uuid; e1 uuid; d1 uuid; s1 uuid; s3 uuid; s4 uuid; oid uuid;
  t1 uuid := gen_random_uuid(); t3 uuid := gen_random_uuid(); t4 uuid := gen_random_uuid(); t4b uuid := gen_random_uuid();
  h1 text := repeat('c1', 32); h3 text := repeat('c3', 32); h4 text := repeat('c4', 32); h4b text := repeat('c5', 32);
  code_hash bytea := decode(repeat('ab', 32), 'hex');
  hash1 text := 'scrypt$32768$8$3$' || repeat('A', 22) || '$' || repeat('B', 43);
  exp timestamptz := now() + interval '30 days';
  n int; cnt int; st text; r record; i int; t text; e_before timestamptz; k_before timestamptz;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's11-sender@example.test', now(), '{"provider":"email"}', '{"full_name":"Sid Sender"}', now(), now()),
         (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's11-admin@example.test', now(), '{"provider":"email"}', '{"full_name":"Ada Admin"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  update public.account_controls set approved = true, is_platform_admin = true, trust_level = 'trusted' where user_id = b;

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Review fixes', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('e5', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Otto Code","email":"s11-otto@example.test","role":"signer","routing_order":1},{"name":"Ava Access","email":"s11-ava@example.test","role":"signer","routing_order":1},{"name":"Cory Corrected","email":"s11-cory@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1 and x.email = 's11-otto@example.test';
  select x.id into s3 from public.recipients x where x.envelope_id = e1 and x.email = 's11-ava@example.test';
  select x.id into s4 from public.recipients x where x.envelope_id = e1 and x.email = 's11-cory@example.test';
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07),
    jsonb_build_object('document_id', d1, 'recipient_id', s3, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07),
    jsonb_build_object('document_id', d1, 'recipient_id', s4, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.7, 'w', 0.3, 'h', 0.07)));
  perform public.set_routing_mode(a, e1, 'parallel');
  perform public.set_recipient_auth(a, e1, s1, 'email_otp', null);
  perform public.set_recipient_auth(a, e1, s3, 'access_code', hash1);
  perform public.set_recipient_auth(a, e1, s4, 'email_otp', null);
  perform public.set_reminders(a, e1, 1, 1, 5);
  perform public.send_envelope(a, e1, jsonb_build_array(
    jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('71', 16), 'token_sha256', h1),
    jsonb_build_object('recipient_id', s3, 'token_id', t3, 'nonce', repeat('73', 16), 'token_sha256', h3),
    jsonb_build_object('recipient_id', s4, 'token_id', t4, 'nonce', repeat('74', 16), 'token_sha256', h4)), exp, 'email');

  -- T401 (M1): a code email counts against the sender, as a request; at most 5 codes a day per person
  perform public.signer_open(h1, null, 'ua');
  select * into r from public.signer_request_otp(t1, null, 'ua');
  select o.id into oid from public.notification_outbox o where o.recipient_id = s1 and o.kind = 'otp';
  n := 0;
  for i in 1..5 loop
    execute 'reset role';   -- test set-up: the server role cannot write recipient_auth (T118)
    update public.recipient_auth set otp_requested_at = now() - interval '2 minutes' where recipient_id = s1;
    execute 'set local role service_role';
    st :=(select x.status from public.signer_request_otp(t1, null, 'ua') x);
    if st = 'queued' then n := n + 1; end if;
  end loop;
  if r.status = 'queued' and n = 4 and st = 'limit'
     and (select o.priority || '|' || (o.sender_user_id = a)::text from public.notification_outbox o where o.id = oid) = 'P0_REQUEST|true'
     and (select count(*) from public.notification_outbox o where o.recipient_id = s1 and o.kind = 'otp') = 5
     and exists (select 1 from public.rate_limits l where l.bucket = 'otp_day')
  then res := res || E'PASS T401 a code email is sent on the sender''s behalf and counts against the sender''s own daily limits; a person gets at most 5 codes\n';
  else res := res || 'FAIL T401 code email budget :: first=' || coalesce(r.status, '?') || ' queued=' || n || ' last=' || coalesce(st, '?') || E'\n'; end if;

  -- T402 (m5): the database refuses a signing step until the identity check is passed
  n := 0;
  begin perform public.signer_consent(t1, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
  select o.id into oid from public.notification_outbox o where o.recipient_id = s1 and o.kind = 'otp' order by o.created_at desc, o.idempotency_key desc limit 1;
  select o.id into oid from public.notification_outbox o where o.idempotency_key = 'otp:' || t1 || ':' || (select x.otp_requests from public.recipient_auth x where x.recipient_id = s1);
  execute 'reset role';   -- test set-up: pretend the worker has claimed the code email
  update public.notification_outbox set status = 'sending', attempts = 1, locked_until = now() + interval '1 minute' where id = oid;
  execute 'set local role service_role';
  if not public.signer_store_otp(oid, code_hash) then n := n + 1; end if;
  st := (select x.status from public.signer_verify_otp(t1, code_hash, null, 'ua') x);
  perform public.signer_consent(t1, 'v1', repeat('c1', 32), null, 'ua');
  if n = 0 and st = 'ok' and (select x.status from public.recipients x where x.id = s1) = 'consented'
  then res := res || E'PASS T402 the database itself refuses a signing step from someone who has not passed their identity check, and allows it once they have\n';
  else res := res || 'FAIL T402 database gate :: n=' || n || ' verify=' || coalesce(st, '?') || E'\n'; end if;

  -- T403 (M2): while the sender is suspended nothing expires and no reminder is queued; lifting gives the time back
  st := public.admin_set_suspension(b, a, true, 'review test');
  perform set_config('easysign.test_clock', 'on', true);
  select count(*) into cnt from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'reminder';
  perform public.process_due(now() + interval '2 days');
  perform public.process_due(exp + interval '1 minute');
  n := 0;
  if (select e.status from public.envelopes e where e.id = e1) <> 'in_progress' then n := n + 1; end if;
  if (select count(*) from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'reminder') <> cnt then n := n + 1; end if;
  if (select count(*) from public.recipient_tokens k where k.envelope_id = e1 and k.revoked_at is null) <> 3 then n := n + 1; end if;
  execute 'reset role';
  update public.account_controls set suspended_at = now() - interval '3 days' where user_id = a;   -- the hold lasted three days
  execute 'set local role service_role';
  select e.expires_at into e_before from public.envelopes e where e.id = e1;
  select k.expires_at into k_before from public.recipient_tokens k where k.id = t3;
  st := public.admin_set_suspension(b, a, false, null);
  perform set_config('easysign.test_clock', '', true);
  if n = 0 and st = 'lifted'
     and (select e.expires_at from public.envelopes e where e.id = e1) = e_before + interval '3 days'
     and (select k.expires_at from public.recipient_tokens k where k.id = t3) = k_before + interval '3 days'
  then res := res || E'PASS T403 while the sender is suspended the document neither expires nor collects reminders; lifting the suspension moves its expiry date and links on by the time on hold\n';
  else res := res || 'FAIL T403 hold and time :: n=' || n || ' lift=' || coalesce(st, '?') || E'\n'; end if;

  -- T404 (m1): no email about a held document is handed out, whoever queued it (here: the whole workspace is suspended)
  execute 'reset role';
  insert into public.org_controls (org_id, status) values (org_a, 'suspended') on conflict (org_id) do update set status = 'suspended';
  update public.notification_outbox set status = 'queued', not_before = now() - interval '1 minute', locked_until = null where envelope_id = e1 and status in ('queued', 'deferred', 'sending');
  execute 'set local role service_role';
  n := 0;
  for i in 1..10 loop
    if exists (select 1 from public.claim_outbox(50, 120) c where c.envelope_id = e1) then n := n + 1; end if;
  end loop;
  execute 'reset role';
  update public.org_controls set status = 'active' where org_id = org_a;
  execute 'set local role service_role';
  cnt := 0;
  for i in 1..40 loop
    if exists (select 1 from public.claim_outbox(50, 120) c where c.envelope_id = e1) then cnt := cnt + 1; exit; end if;
  end loop;
  if n = 0 and cnt = 1
  then res := res || E'PASS T404 no email about a held document is handed out, even when the account is not suspended but its workspace is; once lifted it goes out\n';
  else res := res || 'FAIL T404 held emails :: handed while held=' || n || ' after=' || cnt || E'\n'; end if;

  -- T405 (m3): someone corrected to the sender's own address loses the extra check
  st := public.correct_recipient(a, e1, s4, 'Sid Sender', 's11-sender@example.test',
          jsonb_build_object('token_id', t4b, 'nonce', repeat('75', 16), 'token_sha256', h4b));
  if (select x.is_sender::text || '|' || x.auth_method || '|' || (x.access_code_hash is null)::text from public.recipients x where x.id = s4) = 'true|link|true'
  then res := res || E'PASS T405 a person corrected to the sender''s own address loses the extra check, so the certificate cannot name a check that did not run\n';
  else res := res || 'FAIL T405 sender check :: ' || coalesce(st, '?') || ' ' || coalesce((select x.is_sender::text || '|' || x.auth_method from public.recipients x where x.id = s4), '?') || E'\n'; end if;

  -- T406 (m6): a check whose second step never arrived stops counting as running after 2 minutes
  perform public.signer_open(h3, null, 'ua');
  perform public.signer_auth_begin(t3);                                                    -- step 2 never comes
  execute 'reset role';
  update public.recipient_auth set pending_since = now() - interval '5 minutes' where recipient_id = s3;
  execute 'set local role service_role';
  perform public.signer_auth_begin(t3);
  st := (select x.pending_checks::text from public.recipient_auth x where x.recipient_id = s3);
  perform public.signer_auth_finish(t3, false, null, 'ua');
  if st = '1' and (select x.pending_checks from public.recipient_auth x where x.recipient_id = s3) = 0
  then res := res || E'PASS T406 an access-code check whose second step never arrived is forgotten after 2 minutes, so lock notices keep working\n';
  else res := res || 'FAIL T406 stale check :: pending after second begin=' || coalesce(st, '?') || E'\n'; end if;

  -- T407: privileges and chains
  n := 0;
  foreach t in array array['public.process_due(timestamptz)', 'public.admin_set_suspension(uuid, uuid, boolean, text)', 'public.claim_outbox(int, int)',
                           'public.signer_request_otp(uuid, inet, text)', 'public.signer_auth_begin(uuid)', 'public.signer_auth_finish(uuid, boolean, inet, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  foreach t in array array['app_private.recipient_sender_no_check()', 'app_private.require_signer(uuid)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  execute 'reset role';
  if n = 0 and (select v2.ok from app_private.audit_verify('env:' || e1) v2) and (select v2.ok from app_private.audit_verify('org:' || org_a) v2)
  then res := res || E'PASS T407 the re-issued functions keep their server-only access, and the audit chains verify\n';
  else res := res || 'FAIL T407 privileges or chains :: ' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
