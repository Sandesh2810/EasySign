-- YouNMeSign SQL tests for Phase 5 slice 10: fixes from the independent security review (D-98). Self-contained; one
-- transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); newbie uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  org_a uuid; org_n uuid; org_o uuid; k1 uuid; ko uuid; w1 uuid := gen_random_uuid(); d1 uuid; e1 uuid; eo uuid; n int; ok boolean; v text;
  s1 text := 'v1.' || repeat('A', 60);
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't58-a@example.test', now(), '{"provider":"email"}', '{"full_name":"Rae Review"}', now(), now()),
         (newbie, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't58-n@example.test', now(), '{"provider":"email"}', '{"full_name":"Ned New"}', now(), now()),
         (oth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't58-o@example.test', now(), '{"provider":"email"}', '{"full_name":"Ola Other"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_n from public.memberships m where m.user_id = newbie and m.role = 'owner';
  select m.org_id into org_o from public.memberships m where m.user_id = oth and m.role = 'owner';
  update public.account_controls set approved = true where user_id in (a, oth);
  update public.account_controls set approved = false where user_id = newbie;
  execute 'set local role service_role';

  -- T781: an account that is not approved cannot make API keys or webhook endpoints; an approved one can
  n := 0;
  begin perform public.create_api_key(newbie, org_n, 'Mine', array['documents:write'], 'ynms_t58nnnn', repeat('d1', 32)); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.webhook_endpoint_create(newbie, org_n, gen_random_uuid(), 'https://hooks.example.test/n', '', array['document.sent'], s1); n := n + 1; exception when insufficient_privilege then null; end;
  k1 := public.create_api_key(a, org_a, 'Approved', array['documents:read', 'documents:write', 'documents:send'], 'ynms_t58aaaa', repeat('d2', 32));
  ko := public.create_api_key(oth, org_o, 'Other', array['documents:read'], 'ynms_t58oooo', repeat('d3', 32));
  perform public.webhook_endpoint_create(a, org_a, w1, 'https://hooks.example.test/a', '', array['document.sent'], s1);
  ok := n = 0 and k1 is not null;
  if ok then res := res || E'PASS T781 only approved accounts make API keys and webhook endpoints\n';
  else res := res || 'FAIL T781 approval :: n=' || n || E'\n'; end if;

  -- T782: revoking a key deletes its stored answers; the worker's prune removes answers older than 24 hours only
  perform public.api_idem_begin(k1, 'old', repeat('e1', 32));
  perform public.api_idem_begin(k1, 'new', repeat('e2', 32));
  perform public.api_idem_begin(ko, 'other', repeat('e3', 32));
  execute 'reset role';
  update public.api_idempotency x set created_at = now() - interval '25 hours' where x.key_id = k1 and x.idem_key = 'old';
  execute 'set local role service_role';
  n := public.api_idem_prune();   -- called first: the order of an "and" chain is not guaranteed
  ok := n >= 1
    and not exists (select 1 from public.api_idempotency x where x.key_id = k1 and x.idem_key = 'old')
    and exists (select 1 from public.api_idempotency x where x.key_id = k1 and x.idem_key = 'new');
  perform public.revoke_api_key(a, k1);
  ok := ok and not exists (select 1 from public.api_idempotency x where x.key_id = k1)
    and exists (select 1 from public.api_idempotency x where x.key_id = ko);
  -- an answer that is not to be replayed releases its key at once; a finished answer is never removed this way
  perform public.api_idem_begin(ko, 'retry-me', repeat('e4', 32));
  perform public.api_idem_finish(ko, 'other', 201, '{"id": "x"}');
  perform public.api_idem_abort(ko, 'retry-me');
  perform public.api_idem_abort(ko, 'other');
  ok := ok and not exists (select 1 from public.api_idempotency x where x.key_id = ko and x.idem_key = 'retry-me')
    and exists (select 1 from public.api_idempotency x where x.key_id = ko and x.idem_key = 'other' and x.status_code = 201)
    and not has_function_privilege('authenticated', 'public.api_idem_abort(uuid, text)', 'execute');
  if ok then res := res || E'PASS T782 revoking a key deletes its stored answers; stored answers older than 24 hours are pruned\n';
  else res := res || E'FAIL T782 idempotency store\n'; end if;

  -- T783: a test event is tried once; one endpoint gets at most two deliveries per worker pass
  d1 := public.webhook_test(a, w1);
  perform 1 from public.webhook_claim(50) c where c.id = d1;
  v := public.webhook_result(d1, false, 503, 'HTTP 503', 10);
  ok := v = 'failed' and (select d.status = 'failed' and d.attempts = 1 from public.webhook_deliveries d where d.id = d1);
  execute 'reset role';
  insert into public.webhook_deliveries (endpoint_id, org_id, event_type, payload) select w1, org_a, 'document.sent', '{}' from generate_series(1, 5);
  execute 'set local role service_role';
  select count(*) into n from public.webhook_claim(50) c where c.endpoint_id = w1;
  ok := ok and n = 2;
  select count(*) into n from public.webhook_claim(50) c where c.endpoint_id = w1;   -- the next pass takes the next two
  ok := ok and n = 2;
  if ok then res := res || E'PASS T783 a test event is tried once; one endpoint gets at most two deliveries per pass\n';
  else res := res || 'FAIL T783 delivery :: ' || coalesce(v, '-') || ' n=' || n || E'\n'; end if;

  -- T784: test events and re-sends are audited; an API key's action on a document is in its audit trail, with the key
  perform public.webhook_redeliver(a, d1);
  ok := exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'webhook_tested' and (x.payload ->> 'delivery_id')::uuid = d1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'webhook_redelivered' and (x.payload ->> 'delivery_id')::uuid = d1);
  select e.id into e1 from public.create_envelope(a, org_a, 'Audited', null) e;
  select e.id into eo from public.create_envelope(oth, org_o, 'Elsewhere', null) e;
  perform public.api_audit(k1, e1, 'created_from_template');
  ok := ok and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1 and x.event_type = 'api_call'
    and (x.payload ->> 'key_id')::uuid = k1 and x.payload ->> 'action' = 'created_from_template' and x.actor_id = a);
  n := 0;
  begin perform public.api_audit(k1, eo, 'sent'); n := n + 1; exception when insufficient_privilege then null; end;   -- another workspace's document
  begin perform public.api_audit(k1, e1, 'deleted'); n := n + 1; exception when invalid_parameter_value then null; end;
  execute 'reset role';
  ok := ok and n = 0 and not has_function_privilege('authenticated', 'public.api_audit(uuid, uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.api_idem_prune()', 'execute');
  if ok then res := res || E'PASS T784 test events and re-sends are audited; an API key''s action is in the document''s audit trail with the key; not callable from the browser\n';
  else res := res || 'FAIL T784 audit :: n=' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
