-- YouNMeSign SQL tests for Phase 5 slice 3: webhooks (AT5.2, D-92). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  org_a uuid; org_o uuid; e_a uuid; e_o uuid; r_a uuid;
  w1 uuid := gen_random_uuid(); w2 uuid := gen_random_uuid(); w3 uuid := gen_random_uuid(); wo uuid := gen_random_uuid();
  d1 uuid; n int; ok boolean; v text; r record; j jsonb; t timestamptz;
  s1 text := 'v1.' || repeat('A', 60); s2 text := 'v1.' || repeat('B', 60); s3 text := 'v1.' || repeat('C', 60);
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't54-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Wren Owner"}', now(), now()),
         (adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't54-adm@example.test', now(), '{"provider":"email"}', '{"full_name":"Wade Admin"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't54-mem@example.test', now(), '{"provider":"email"}', '{"full_name":"Wes Member"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't54-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Wyn Outside"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_o from public.memberships m where m.user_id = outsider and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, adm, 'admin'), (org_a, mem, 'member');

  execute 'set local role service_role';
  select e.id into e_a from public.create_envelope(a, org_a, 'Hook doc', null) e;
  select e.id into e_o from public.create_envelope(outsider, org_o, 'Other doc', null) e;
  select x.id into r_a from public.save_recipients(a, e_a, '[{"name":"Pat Signer","email":"t54-pat@example.test","role":"signer","routing_order":1}]'::jsonb) x;

  -- T741: owners and administrators add endpoints (events checked and normalised, https only, at most 10), audited
  -- without the path or query; members and outsiders cannot
  n := 0;
  begin perform public.webhook_endpoint_create(mem, org_a, gen_random_uuid(), 'https://hooks.example.com/a', '', array['document.sent'], s1); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.webhook_endpoint_create(outsider, org_a, gen_random_uuid(), 'https://hooks.example.com/a', '', array['document.sent'], s1); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.com/a', '', array['document.deleted'], s1); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.com/a', '', '{}', s1); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'http://hooks.example.com/a', '', array['document.sent'], s1); n := n + 1; exception when check_violation then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'http://10.0.0.1/a', '', array['document.sent'], s1); n := n + 1; exception when check_violation then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.com/a b', '', array['document.sent'], s1); n := n + 1; exception when check_violation then null; end;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.com/a', '', array['document.sent'], 'whsec_plain'); n := n + 1; exception when check_violation then null; end;
  perform public.webhook_endpoint_create(a, org_a, w1, 'https://hooks.example.com/in?token=abc123', 'CRM', array['person.completed', 'document.completed', 'document.sent', 'document.sent'], s1);
  perform public.webhook_endpoint_create(adm, org_a, w2, 'https://other.example.com/y', '', array['document.declined'], s2);
  perform public.webhook_endpoint_create(outsider, org_o, wo, 'https://hooks.example.com/o', '', array['document.sent'], s3);
  select x.payload into j from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'webhook_created' and (x.payload ->> 'endpoint_id')::uuid = w1;
  ok := n = 0 and (select w.events = array['document.completed', 'document.sent', 'person.completed'] from public.webhook_endpoints w where w.id = w1)
    and j ->> 'origin' = 'https://hooks.example.com' and j::text not like '%abc123%';
  for i in 1..8 loop perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://fill.example.com/' || i, '', array['document.voided'], s1); end loop;
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://fill.example.com/11', '', array['document.voided'], s1); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := ok and n = 0;
  delete from public.webhook_endpoints w where w.url like 'https://fill.example.com/%';
  -- the list never contains a secret
  j := public.webhook_endpoint_list(a, org_a);
  ok := ok and jsonb_array_length(j) = 2 and j::text not like '%' || repeat('A', 20) || '%' and j -> 0 ->> 'url' = 'https://hooks.example.com/in?token=abc123';
  n := 0;
  begin perform public.webhook_endpoint_list(mem, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.webhook_delivery_list(outsider, w1, 10); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and n = 0;
  if ok then res := res || E'PASS T741 owners and administrators add webhook endpoints (https only, events checked, at most 10, audited without the path); others cannot; no secret is listed\n';
  else res := res || 'FAIL T741 create :: n=' || n || E'\n'; end if;

  -- T742: a status change queues one delivery per live endpoint that chose the event, in its own workspace only, with
  -- the documented payload; a person signing queues person.completed
  execute 'reset role';
  perform app_private.sanction();
  update public.envelopes set status = 'sent', sent_at = now() where id = e_a;
  update public.envelopes set status = 'sent', sent_at = now() where id = e_o;
  update public.recipients set status = 'signed', completed_at = now() where id = r_a;
  update public.envelopes set status = 'in_progress' where id = e_a;   -- not an event
  execute 'set local role service_role';
  select * into r from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'document.sent';
  ok := r.id is not null and r.status = 'pending' and r.envelope_id = e_a and r.org_id = org_a
    and r.payload ->> 'type' = 'document.sent' and r.payload ? 'timestamp'
    and r.payload -> 'data' -> 'document' ->> 'id' = e_a::text and r.payload -> 'data' -> 'document' ->> 'title' = 'Hook doc'
    and r.payload -> 'data' -> 'document' ->> 'status' = 'sent' and (r.payload -> 'data' -> 'document' -> 'sealed') = 'false'::jsonb;
  select d.payload into j from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'person.completed';
  ok := ok and j -> 'data' -> 'person' ->> 'name' = 'Pat Signer' and j -> 'data' -> 'person' ->> 'status' = 'signed' and j -> 'data' -> 'document' ->> 'id' = e_a::text;
  ok := ok and (select count(*) from public.webhook_deliveries d where d.endpoint_id = w1) = 2           -- sent + person.completed (not in_progress)
    and (select count(*) from public.webhook_deliveries d where d.endpoint_id = w2) = 0                  -- did not choose sent
    and (select count(*) from public.webhook_deliveries d where d.endpoint_id = wo) = 1                  -- its own document only
    and (select d.envelope_id from public.webhook_deliveries d where d.endpoint_id = wo) = e_o;
  if ok then res := res || E'PASS T742 status changes and signatures queue one delivery per endpoint that chose the event, in its own workspace, with the documented payload\n';
  else res := res || E'FAIL T742 enqueue\n'; end if;

  -- T743: the worker claims due deliveries once (a second claim gets nothing while they are being sent); the claim
  -- carries the url, payload and the encrypted secret, plus the previous secret only during a change
  select count(*) into n from public.webhook_claim(10) c where c.endpoint_id = w1;
  ok := n = 2 and (select count(*) from public.webhook_claim(10)) = 0
    and (select count(*) from public.webhook_deliveries d where d.endpoint_id = w1 and d.status = 'sending' and d.locked_until > now()) = 2;
  -- a crashed worker: the lock runs out and the delivery is claimed again
  execute 'reset role';
  update public.webhook_deliveries d set locked_until = now() - interval '1 second' where d.endpoint_id = wo;
  execute 'set local role service_role';
  select * into r from public.webhook_claim(10) c;
  ok := ok and r.endpoint_id = wo and r.secret_enc = s3 and r.previous_secret_enc is null and r.url = 'https://hooks.example.com/o';
  if ok then res := res || E'PASS T743 the worker claims each due delivery once; a delivery left by a crashed worker is claimed again after its lock runs out\n';
  else res := res || 'FAIL T743 claim :: n=' || n || E'\n'; end if;

  -- T744: retries with backoff: each failure is logged and waits 60 s, 5 min, 30 min, 2 h, 6 h, 12 h; the seventh failure
  -- stops it; success is final; a result for a delivery that is not being sent is ignored
  select d.id into d1 from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'document.sent';
  ok := true;
  v := 'start';
  for i in 1..6 loop
    t := now();
    v := public.webhook_result(d1, false, 503, 'HTTP 503', 120);
    select * into r from public.webhook_deliveries d where d.id = d1;
    if not (v = 'retry' and r.status = 'pending' and r.attempts = i and r.last_status_code = 503
            and r.next_attempt_at = t + make_interval(secs => (array[60, 300, 1800, 7200, 21600, 43200])[i])) then
      ok := false; res := res || 'NOTE T744 attempt ' || i || ': ' || v || ' ' || r.status || ' ' || r.attempts || ' ' || coalesce((r.next_attempt_at - t)::text, '-') || E'\n';
    end if;
    execute 'reset role';
    update public.webhook_deliveries d set status = 'sending' where d.id = d1;   -- as if claimed again when due
    execute 'set local role service_role';
  end loop;
  v := public.webhook_result(d1, false, null, 'connection refused', 5);
  ok := ok and v = 'failed'
    and (select d.status = 'failed' and d.attempts = 7 and d.last_error = 'connection refused' from public.webhook_deliveries d where d.id = d1)
    and (select count(*) from public.webhook_attempts x where x.delivery_id = d1) = 7
    and (select array_agg(coalesce(x.status_code, 0) order by x.attempt) from public.webhook_attempts x where x.delivery_id = d1) = array[503, 503, 503, 503, 503, 503, 0];
  v := public.webhook_result(d1, true, 200, null, 5);
  ok := ok and v = 'ignored' and (select w.consecutive_failures from public.webhook_endpoints w where w.id = w1) = 1;
  if not ok then res := res || E'NOTE T744 after the seventh failure\n'; end if;
  select c.id::text into v from public.webhook_deliveries c where c.endpoint_id = w1 and c.event_type = 'person.completed';
  d1 := v::uuid;
  v := public.webhook_result(d1, true, 204, null, 40);
  ok := ok and v = 'delivered'
    and (select d.status = 'delivered' and d.delivered_at is not null and d.attempts = 1 from public.webhook_deliveries d where d.id = d1)
    and (select w.consecutive_failures = 0 and w.last_success_at is not null from public.webhook_endpoints w where w.id = w1);
  select d.id into d1 from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'document.sent';
  select c.id::text into v from public.webhook_deliveries c where c.endpoint_id = w1 and c.event_type = 'person.completed';
  if ok then res := res || E'PASS T744 a failed delivery is retried after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h, every attempt logged; the seventh failure stops it; success is final\n';
  else res := res || 'FAIL T744 retries :: ' || coalesce((select string_agg(x.event_type || '/' || x.status || '/' || x.attempts || '/' || coalesce(x.last_status_code::text, '-'), ', ')
      from public.webhook_deliveries x where x.endpoint_id = w1), 'none') || ' tries=' || (select count(*) from public.webhook_attempts a where a.delivery_id = d1)
      || ' fails=' || (select w.consecutive_failures from public.webhook_endpoints w where w.id = w1) || E'\n'; end if;

  -- T745: the delivery log shows every attempt; a failed delivery can be sent once more (same id), a delivered one cannot;
  -- a test event is queued (at most 5 a minute)
  j := public.webhook_delivery_list(a, w1, 50);
  ok := jsonb_array_length(j) = 2
    and (select jsonb_array_length(x -> 'tries') from jsonb_array_elements(j) x where x ->> 'id' = d1::text) = 7
    and (select x -> 'tries' -> 6 ->> 'error' from jsonb_array_elements(j) x where x ->> 'id' = d1::text) = 'connection refused';
  perform public.webhook_redeliver(adm, d1);
  ok := ok and (select d.status = 'pending' and d.manual_retry from public.webhook_deliveries d where d.id = d1);
  n := 0;
  begin perform public.webhook_redeliver(a, v::uuid); n := n + 1; exception when invalid_parameter_value then null; end;   -- delivered
  begin perform public.webhook_redeliver(mem, d1); n := n + 1; exception when insufficient_privilege then null; end;
  select count(*) into n from public.webhook_claim(10) c where c.id = d1;
  ok := ok and n = 1;
  n := 0;
  ok := ok and public.webhook_result(d1, false, 500, 'HTTP 500', 3) = 'failed';  -- a manual try is one attempt
  ok := ok and (select d.attempts = 8 and not d.manual_retry from public.webhook_deliveries d where d.id = d1)
    and (select w.consecutive_failures from public.webhook_endpoints w where w.id = w1) = 0;   -- manual tries do not count
  for i in 1..5 loop perform public.webhook_test(a, w1); end loop;
  begin perform public.webhook_test(a, w1); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := ok and n = 0 and (select count(*) from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'webhook.test' and d.payload ->> 'type' = 'webhook.test') = 5;
  if ok then res := res || E'PASS T745 the delivery log shows every attempt; a failed delivery can be sent once more; test events are queued (at most 5 a minute)\n';
  else res := res || 'FAIL T745 log :: n=' || n || E'\n'; end if;

  -- T746: changing the secret keeps the old one signing for 24 hours; switching off stops queuing and stops due
  -- deliveries without an attempt; switching on again resets the failure count; deletion removes the log
  t := public.webhook_endpoint_rotate(a, w1, s2);
  ok := t > now() + interval '23 hours' and (select w.secret_enc = s2 and w.previous_secret_enc = s1 from public.webhook_endpoints w where w.id = w1);
  perform public.webhook_endpoint_update(a, w1, null, false, null);
  select count(*) into n from public.webhook_claim(10) c where c.endpoint_id = w1;
  ok := ok and n = 0;
  ok := ok and (select count(*) from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'webhook.test' and d.status = 'failed' and d.last_error like 'Not sent:%') = 5;
  execute 'reset role';
  perform app_private.sanction();
  update public.envelopes set status = 'voided' where id = e_a;
  execute 'set local role service_role';
  ok := ok and not exists (select 1 from public.webhook_deliveries d where d.endpoint_id = w1 and d.event_type = 'document.voided');
  n := 0;
  begin perform public.webhook_test(a, w1); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.webhook_endpoint_update(a, w1, array['document.voided'], true, 'CRM 2');
  ok := ok and n = 0 and (select w.enabled and w.disabled_reason is null and w.events = array['document.voided'] and w.description = 'CRM 2' from public.webhook_endpoints w where w.id = w1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'webhook_secret_changed');
  perform public.webhook_endpoint_delete(a, w2);
  ok := ok and not exists (select 1 from public.webhook_endpoints w where w.id = w2)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'webhook_deleted' and (x.payload ->> 'endpoint_id')::uuid = w2);
  if ok then res := res || E'PASS T746 a new secret keeps the old one signing for 24 hours; switching off stops new and due deliveries; switching on again; deleting is audited\n';
  else res := res || 'FAIL T746 manage :: n=' || n || E'\n'; end if;

  -- T747: an endpoint stops receiving when its creator is no longer an owner or administrator, or is suspended
  perform public.webhook_endpoint_create(adm, org_a, w3, 'https://third.example.com/z', '', array['document.expired'], s3);
  execute 'reset role';
  update public.memberships m set role = 'member' where m.user_id = adm and m.org_id = org_a;
  perform app_private.sanction();
  update public.envelopes set status = 'sent' where id = e_o;   -- no-op for org_a
  execute 'set local role service_role';
  select e.id into v from public.create_envelope(a, org_a, 'Second', null) e;
  execute 'reset role';
  perform app_private.sanction();
  update public.envelopes set status = 'sent' where id = v::uuid;
  perform app_private.sanction();
  update public.envelopes set status = 'expired' where id = v::uuid;
  execute 'set local role service_role';
  ok := not exists (select 1 from public.webhook_deliveries d where d.endpoint_id = w3);
  j := public.webhook_endpoint_list(a, org_a);
  ok := ok and (select (x ->> 'live')::boolean from jsonb_array_elements(j) x where x ->> 'id' = w3::text) = false;
  execute 'reset role';
  update public.memberships m set role = 'admin' where m.user_id = adm and m.org_id = org_a;
  update public.account_controls c set trust_level = 'suspended' where c.user_id = adm;
  ok := ok and not app_private.webhook_live(adm, org_a) and app_private.webhook_live(a, org_a) and not app_private.webhook_live(mem, org_a)
    and app_private.webhook_live(null, org_a) = false;
  execute 'set local role service_role';
  if ok then res := res || E'PASS T747 an endpoint stops receiving when the person who added it is no longer an owner or administrator, or is suspended\n';
  else res := res || E'FAIL T747 live\n'; end if;

  -- T748: five deliveries in a row failing after every retry switch the endpoint off; the tables and functions are closed
  -- to the browser
  execute 'reset role';
  update public.webhook_endpoints w set consecutive_failures = 4 where w.id = w1;
  insert into public.webhook_deliveries (endpoint_id, org_id, event_type, payload, status, attempts) values (w1, org_a, 'document.voided', '{}', 'sending', 6) returning id into d1;
  execute 'set local role service_role';
  ok := public.webhook_result(d1, false, 410, 'HTTP 410', 9) = 'failed';
  ok := ok and (select not w.enabled and w.disabled_reason like 'Switched off automatically%' from public.webhook_endpoints w where w.id = w1);
  execute 'reset role';
  ok := ok and not has_table_privilege('authenticated', 'public.webhook_endpoints', 'select') and not has_table_privilege('anon', 'public.webhook_deliveries', 'select')
    and not has_table_privilege('authenticated', 'public.webhook_attempts', 'select')
    and not has_function_privilege('authenticated', 'public.webhook_claim(int)', 'execute')
    and not has_function_privilege('anon', 'public.webhook_endpoint_create(uuid, uuid, uuid, text, text, text[], text)', 'execute')
    and not has_function_privilege('authenticated', 'public.webhook_result(uuid, boolean, int, text, int)', 'execute');
  execute 'set local role service_role';
  ok := ok and public.webhook_prune(30) = 0;
  if ok then res := res || E'PASS T748 five deliveries in a row failing completely switch the endpoint off; nothing is reachable from the browser\n';
  else res := res || E'FAIL T748 auto-off\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
