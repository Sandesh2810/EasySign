-- YouNMeSign SQL tests for Phase 5 slice 1: API keys and the core API (AT5.1, D-90). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  org_a uuid; org_o uuid; e_a uuid; e_m uuid; e_o uuid;
  k1 uuid; k2 uuid; kmem uuid; n int; ok boolean; v text; r record; j jsonb;
  h1 text := repeat('a1', 32); h2 text := repeat('a2', 32); h3 text := repeat('a3', 32);
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't53-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Ola Owner"}', now(), now()),
         (adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't53-adm@example.test', now(), '{"provider":"email"}', '{"full_name":"Ada Admin"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't53-mem@example.test', now(), '{"provider":"email"}', '{"full_name":"Mo Member"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't53-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Oz Outside"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_o from public.memberships m where m.user_id = outsider and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, adm, 'admin'), (org_a, mem, 'member');

  execute 'set local role service_role';
  select e.id into e_a from public.create_envelope(a, org_a, 'Owner doc', null) e;
  select e.id into e_m from public.create_envelope(mem, org_a, 'Member doc', null) e;
  select e.id into e_o from public.create_envelope(outsider, org_o, 'Outside doc', null) e;

  -- T731: owners and administrators create keys (scopes checked and normalised, at most 10 live), audited; members cannot
  n := 0;
  begin perform public.create_api_key(mem, org_a, 'Mine', array['documents:read'], 'ynms_abcdefg', h3); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_api_key(outsider, org_a, 'X', array['documents:read'], 'ynms_abcdefg', h3); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_api_key(a, org_a, 'Bad', array['documents:delete'], 'ynms_abcdefg', h3); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_api_key(a, org_a, 'Bad', '{}', 'ynms_abcdefg', h3); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_api_key(a, org_a, ' ', array['documents:read'], 'ynms_abcdefg', h3); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_api_key(a, org_a, 'Bad', array['documents:read'], 'nope', h3); n := n + 1; exception when check_violation then null; end;
  k1 := public.create_api_key(a, org_a, 'CRM', array['documents:send', 'documents:read', 'documents:read'], 'ynms_k1aaaaa', h1);
  k2 := public.create_api_key(adm, org_a, 'Reader', array['documents:read'], 'ynms_k2aaaaa', h2);
  ok := n = 0 and (select k.scopes = array['documents:read', 'documents:send'] from public.api_keys k where k.id = k1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'api_key_created' and (x.payload ->> 'key_id')::uuid = k1);
  for i in 1..8 loop perform public.create_api_key(a, org_a, 'Fill ' || i, array['documents:read'], 'ynms_fill' || i || 'aa', md5('f' || i) || md5('g' || i)); end loop;
  begin perform public.create_api_key(a, org_a, 'Eleventh', array['documents:read'], 'ynms_eleventh'::text, h3); n := n + 1; exception when invalid_parameter_value or check_violation then null; end;
  ok := ok and n = 0;
  if ok then res := res || E'PASS T731 owners and administrators create API keys (scopes checked, at most 10 live, audited); members and outsiders cannot\n';
  else res := res || 'FAIL T731 create :: n=' || n || E'\n'; end if;

  -- T732: a key resolves to its workspace, creator and role while live; not once revoked, or its creator left or is suspended
  select * into r from public.api_key_resolve(h1);
  ok := r.key_id = k1 and r.org_id = org_a and r.user_id = a and r.role = 'owner' and (select k.last_used_at is not null from public.api_keys k where k.id = k1);
  ok := ok and (select count(*) from public.api_key_resolve(repeat('ff', 32))) = 0 and (select count(*) from public.api_key_resolve('not hex')) = 0;
  execute 'reset role';
  update public.memberships m set deactivated_at = now() where m.user_id = adm and m.org_id = org_a;
  execute 'set local role service_role';
  ok := ok and (select count(*) from public.api_key_resolve(h2)) = 0;
  execute 'reset role';
  update public.memberships m set deactivated_at = null where m.user_id = adm and m.org_id = org_a;
  update public.account_controls c set trust_level = 'suspended' where c.user_id = adm;
  execute 'set local role service_role';
  ok := ok and (select count(*) from public.api_key_resolve(h2)) = 0;
  execute 'reset role';
  update public.account_controls c set trust_level = 'restricted' where c.user_id = adm;
  execute 'set local role service_role';
  ok := ok and (select count(*) from public.api_key_resolve(h2)) = 1;
  if ok then res := res || E'PASS T732 a key acts as its creator while live; it stops when its creator leaves the workspace or is suspended\n';
  else res := res || E'FAIL T732 resolve\n'; end if;

  -- T733: idempotency: a new request goes ahead once; the same request is answered from the stored result; a different
  -- request with the same key is refused; one still running is reported as such
  ok := public.api_idem_begin(k1, 'req-1', repeat('b1', 32)) ->> 'state' = 'new'
    and public.api_idem_begin(k1, 'req-1', repeat('b1', 32)) ->> 'state' = 'in_progress';
  perform public.api_idem_finish(k1, 'req-1', 201, '{"id":"x"}');
  j := public.api_idem_begin(k1, 'req-1', repeat('b1', 32));
  ok := ok and j ->> 'state' = 'done' and (j ->> 'status')::int = 201 and j -> 'body' ->> 'id' = 'x'
    and public.api_idem_begin(k1, 'req-1', repeat('b2', 32)) ->> 'state' = 'mismatch'
    and public.api_idem_begin(k2, 'req-1', repeat('b2', 32)) ->> 'state' = 'new';   -- keys do not share idempotency keys
  if ok then res := res || E'PASS T733 a write with an idempotency key runs once; a repeat gets the stored answer; a different request with the same key is refused\n';
  else res := res || E'FAIL T733 idempotency\n'; end if;

  -- T734: a key sees documents as its creator would, only in its own workspace
  ok := (public.api_document_view(a, org_a, e_a) ->> 'title') = 'Owner doc' and (public.api_document_view(a, org_a, e_m) ->> 'title') = 'Member doc';
  n := 0;
  begin perform public.api_document_view(a, org_a, e_o); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.api_document_view(outsider, org_a, e_o); n := n + 1; exception when insufficient_privilege then null; end;   -- wrong workspace for this document
  begin perform public.api_document_view(mem, org_a, e_a); n := n + 1; exception when insufficient_privilege then null; end;      -- a member sees only their own
  ok := ok and n = 0 and (public.api_document_view(mem, org_a, e_m) ->> 'status') = 'draft';
  if ok then res := res || E'PASS T734 a key sees documents as its creator would, and only in its own workspace\n';
  else res := res || 'FAIL T734 document view :: n=' || n || E'\n'; end if;

  -- T735: revoking: owners and administrators only; immediate; audited; repeating it is harmless
  n := 0;
  begin perform public.revoke_api_key(mem, k1); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.revoke_api_key(outsider, k1); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.revoke_api_key(adm, k1);
  perform public.revoke_api_key(adm, k1);
  ok := n = 0 and (select count(*) from public.api_key_resolve(h1)) = 0
    and (select k.revoked_by = adm from public.api_keys k where k.id = k1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'api_key_revoked')
    and jsonb_array_length(public.api_key_list(a, org_a)) = 10;
  begin perform public.api_key_list(mem, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and n = 0;
  if ok then res := res || E'PASS T735 only owners and administrators revoke and list keys; a revoked key stops at once; audited\n';
  else res := res || 'FAIL T735 revoke :: n=' || n || E'\n'; end if;

  -- T736: everything is server-only; the key itself is never stored
  execute 'reset role';
  ok := not has_table_privilege('authenticated', 'public.api_keys', 'select') and not has_table_privilege('anon', 'public.api_keys', 'select')
    and not has_function_privilege('anon', 'public.api_key_resolve(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.create_api_key(uuid, uuid, text, text[], text, text)', 'execute')
    and not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'api_keys' and c.column_name in ('key', 'secret', 'token'));
  if ok then res := res || E'PASS T736 API keys are handled only by the server, and only their fingerprints are stored\n';
  else res := res || E'FAIL T736 privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
