-- YouNMeSign SQL tests for Phase 5 slice 5: usage metering and plan limits (D-94). Self-contained; one transaction;
-- always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  org_a uuid; org_o uuid; e1 uuid; e2 uuid; e3 uuid; n int; ok boolean; r record; j jsonb;
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
  s1 text := 'v1.' || repeat('A', 60);
  msg text;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't56-a@example.test', now(), '{"provider":"email"}', '{"full_name":"Uma Usage"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't56-m@example.test', now(), '{"provider":"email"}', '{"full_name":"Mia Member"}', now(), now()),
         (oth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't56-o@example.test', now(), '{"provider":"email"}', '{"full_name":"Ola Other"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_o from public.memberships m where m.user_id = oth and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, mem, 'member');

  -- T761: plans are data; a workspace with no plan set is on "free" (10 keys, 10 endpoints, 60 a minute, no monthly
  -- limit); the placeholder is not offered; plans cannot be changed by the server or reached from the browser
  ok := (select p.offered and p.max_api_keys = 10 and p.max_webhook_endpoints = 10 and p.api_requests_per_minute = 60 and p.monthly_api_calls is null from public.plans p where p.id = 'free')
    and (select not p.offered from public.plans p where p.id = 'paid_placeholder')
    and (app_private.org_plan(org_a)).id = 'free';
  execute 'set local role service_role';
  n := 0;
  begin insert into public.plans (id, name, offered, max_api_keys, max_webhook_endpoints, api_requests_per_minute) values ('cheat', 'Cheat', true, 999, 999, 9999); n := n + 1; exception when insufficient_privilege then null; end;
  begin update public.plans set max_api_keys = 999 where id = 'free'; n := n + 1; exception when insufficient_privilege then null; end;
  execute 'reset role';
  ok := ok and n = 0 and not has_table_privilege('authenticated', 'public.plans', 'select') and not has_table_privilege('anon', 'public.usage_monthly', 'select')
    and not has_table_privilege('authenticated', 'public.org_plans', 'select');
  if ok then res := res || E'PASS T761 plans are data; no plan set means free (10 keys, 10 endpoints, 60 a minute, no monthly limit); plans cannot be changed by the server or reached from the browser\n';
  else res := res || 'FAIL T761 plans :: n=' || n || E'\n'; end if;

  -- T762: every API request is counted for its workspace and month; the key check answers with the plan's limits
  execute 'set local role service_role';
  perform public.create_api_key(a, org_a, 'Counter', array['documents:read'], 'ynms_t56aaaa', repeat('c1', 32));
  perform public.create_api_key(oth, org_o, 'Other', array['documents:read'], 'ynms_t56bbbb', repeat('c2', 32));
  select * into r from public.api_key_resolve(repeat('c1', 32));
  ok := r.per_minute = 60 and r.month_limit is null and r.month_calls = 1;
  select * into r from public.api_key_resolve(repeat('c1', 32));
  ok := ok and r.month_calls = 2;
  select * into r from public.api_key_resolve(repeat('c2', 32));
  ok := ok and r.month_calls = 1 and (select count(*) from public.api_key_resolve(repeat('ff', 32))) = 0
    and (select u.api_calls from public.usage_monthly u where u.org_id = org_a and u.month = this_month) = 2;
  if ok then res := res || E'PASS T762 every API request is counted for its workspace and month; the key check answers with the plan''s limits\n';
  else res := res || E'FAIL T762 counting\n'; end if;

  -- T763: the limits that existed now come from the plan: a smaller test plan allows 2 keys, 1 endpoint, 5 a minute,
  -- 3 requests a month
  execute 'reset role';
  insert into public.plans (id, name, offered, max_api_keys, max_webhook_endpoints, api_requests_per_minute, monthly_api_calls) values ('t56_small', 'Small', false, 2, 1, 5, 3);
  insert into public.org_plans (org_id, plan_id) values (org_a, 't56_small');
  execute 'set local role service_role';
  perform public.create_api_key(a, org_a, 'Second', array['documents:read'], 'ynms_t56cccc', repeat('c3', 32));
  n := 0;
  begin perform public.create_api_key(a, org_a, 'Third', array['documents:read'], 'ynms_t56dddd', repeat('c4', 32)); n := n + 1;
  exception when invalid_parameter_value then
    get stacked diagnostics msg = message_text;
  end;
  ok := n = 0 and msg like '%plan allows 2 active API keys%';
  perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.test/1', '', array['document.sent'], s1);
  begin perform public.webhook_endpoint_create(a, org_a, gen_random_uuid(), 'https://hooks.example.test/2', '', array['document.sent'], s1); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.webhook_endpoint_create(oth, org_o, gen_random_uuid(), 'https://hooks.example.test/3', '', array['document.sent'], s1);   -- free: fine
  perform public.webhook_endpoint_create(oth, org_o, gen_random_uuid(), 'https://hooks.example.test/4', '', array['document.sent'], s1);
  select * into r from public.api_key_resolve(repeat('c1', 32));
  ok := ok and n = 0 and r.per_minute = 5 and r.month_limit = 3 and r.month_calls = 3;
  if ok then res := res || E'PASS T763 the existing limits come from the plan: a smaller plan allows fewer keys, endpoints and requests\n';
  else res := res || 'FAIL T763 limits :: n=' || n || ' ' || coalesce(msg, '') || E'\n'; end if;

  -- T764: the month's usage: documents and people sent this month (not last month, not drafts, not the sender
  -- signing their own), API requests, storage, members, keys and endpoints
  select e.id into e1 from public.create_envelope(a, org_a, 'Usage 1', null) e;
  select e.id into e2 from public.create_envelope(mem, org_a, 'Usage 2', null) e;
  select e.id into e3 from public.create_envelope(a, org_a, 'Usage 3 (draft)', null) e;
  execute 'reset role';
  perform app_private.sanction();
  insert into public.recipients (org_id, envelope_id, name, email, role, routing_order, is_sender, sent_at)
  values (org_a, e1, 'P1', 't56-p1@example.test', 'signer', 1, false, now()), (org_a, e1, 'P2', 't56-p2@example.test', 'signer', 1, false, now()),
         (org_a, e1, 'Uma Usage', 't56-a@example.test', 'signer', 2, true, now()), (org_a, e2, 'P3', 't56-p3@example.test', 'signer', 1, false, this_month - 3);
  update public.envelopes set status = 'sent', sent_at = now() where id = e1;
  update public.envelopes set status = 'sent', sent_at = this_month - 3 where id = e2;   -- last month
  insert into storage.objects (bucket_id, name, metadata) values ('originals', org_a || '/t56/a.pdf', '{"size": 1000}'), ('sealed', org_a || '/t56/b.pdf', '{"size": 2345}'),
         ('originals', org_o || '/t56/c.pdf', '{"size": 99999}');
  execute 'set local role service_role';
  j := public.usage_summary(a, org_a, null);
  ok := j ->> 'month' = to_char(this_month, 'YYYY-MM') and (j -> 'plan' ->> 'id') = 't56_small' and (j -> 'plan' ->> 'max_api_keys')::int = 2
    and (j ->> 'documents_sent')::int = 1 and (j ->> 'people_sent_to')::int = 2 and (j ->> 'api_calls')::int = 3 and (j ->> 'storage_bytes')::bigint = 3345
    and (j ->> 'members')::int = 2 and (j ->> 'api_keys')::int = 2 and (j ->> 'webhook_endpoints')::int = 1;
  j := public.usage_summary(a, org_a, this_month - 3);
  ok := ok and (j ->> 'documents_sent')::int = 1 and (j ->> 'people_sent_to')::int = 1 and (j ->> 'api_calls')::int = 0;
  if ok then res := res || E'PASS T764 the month''s usage counts what was sent in it, API requests, storage, members, keys and endpoints, for this workspace only\n';
  else res := res || 'FAIL T764 usage :: ' || j::text || E'\n'; end if;

  -- T765: only owners and administrators see usage; not callable from the browser
  n := 0;
  begin perform public.usage_summary(mem, org_a, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.usage_summary(oth, org_a, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.usage_summary(null, org_a, null); n := n + 1; exception when insufficient_privilege then null; end;
  execute 'reset role';
  ok := n = 0 and not has_function_privilege('authenticated', 'public.usage_summary(uuid, uuid, date)', 'execute')
    and not has_function_privilege('anon', 'public.api_key_resolve(text)', 'execute');
  if ok then res := res || E'PASS T765 only owners and administrators see usage; nothing is callable from the browser\n';
  else res := res || 'FAIL T765 access :: n=' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
