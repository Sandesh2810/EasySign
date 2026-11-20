-- YouNMeSign SQL tests for migration 23: two-step sign-in records (AT3.4). Self-contained; one transaction; always rolled back.
-- Authenticator records (auth.mfa_factors) are inserted directly to stand in for Supabase Auth's set-up step.
do $test$
declare
  res text := '';
  u uuid := gen_random_uuid();     -- an ordinary user
  adm uuid := gen_random_uuid();   -- a platform admin
  org_u uuid; hashes text[]; st text; st2 text; n int; cnt int; i int; t text; j jsonb; r record;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's14-user@example.test', now(), '{"provider":"email"}', '{"full_name":"Uma User"}', now(), now()),
         (adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's14-admin@example.test', now(), '{"provider":"email"}', '{"full_name":"Ada Admin"}', now(), now());
  update public.account_controls set is_platform_admin = true where user_id = adm;
  select m.org_id into org_u from public.memberships m where m.user_id = u and m.role = 'owner';
  select array_agg(encode(sha256(convert_to('code-' || g, 'UTF8')), 'hex')) into hashes from generate_series(1, 10) g;

  execute 'set local role service_role';
  -- T521: without an authenticator nothing can be claimed or stored
  n := 0;
  begin perform public.mfa_store_recovery_codes(u, hashes); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.mfa_record_event(u, 'mfa_enrolled', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.mfa_record_event(u, 'mfa_hacked', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  j := public.mfa_status(u);
  if n = 0 and j = '{"admin": false, "enrolled": false, "codes_left": 0}'::jsonb and (public.mfa_status(adm) ->> 'admin')::boolean
  then res := res || E'PASS T521 without an authenticator no set-up can be recorded and no recovery codes stored; status reports it\n';
  else res := res || 'FAIL T521 before set-up :: n=' || n || ' status=' || j::text || E'\n'; end if;

  -- T522 AT3.4: set-up and use are audited; ten recovery codes kept as fingerprints only
  execute 'reset role';
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (gen_random_uuid(), u, 'phone app', 'totp', 'verified', now(), now(), 'TESTSECRET');
  execute 'set local role service_role';
  perform public.mfa_record_event(u, 'mfa_enrolled', '203.0.113.20', 'ua-setup');
  n := public.mfa_store_recovery_codes(u, hashes);
  perform public.mfa_record_event(u, 'mfa_verified', '203.0.113.21', 'ua-signin');
  perform public.mfa_record_event(u, 'mfa_failed', '203.0.113.22', 'ua-signin');
  n := 0;
  begin perform public.mfa_store_recovery_codes(u, hashes[1:9]); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.mfa_store_recovery_codes(u, array_fill(hashes[1], array[10])); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.mfa_record_event(u, 'mfa_removed', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  select count(*) into cnt from public.audit_events x where x.chain_key = 'org:' || org_u and x.payload ->> 'user_id' = u::text
     and x.event_type in ('mfa_enrolled', 'mfa_recovery_codes_issued', 'mfa_verified', 'mfa_failed');
  execute 'reset role';   -- the codes table is closed even to the service role; read it as the owner
  select count(*) into i from public.mfa_recovery_codes c where c.user_id = u and c.code_sha256 = any (hashes);
  execute 'set local role service_role';
  if n = 0 and cnt = 4 and (public.mfa_status(u) ->> 'codes_left')::int = 10 and i = 10
     and (select x.ip from public.audit_events x where x.chain_key = 'org:' || org_u and x.event_type = 'mfa_enrolled') = '203.0.113.20'::inet
  then res := res || E'PASS T522 AT3.4: set-up, use and failure are in the audit trail; ten recovery codes are kept as fingerprints only\n';
  else res := res || 'FAIL T522 set-up :: n=' || n || ' audited=' || cnt || E'\n'; end if;

  -- T523 AT3.4: a recovery code works once, removes the authenticator and every other code; a wrong code is audited
  st := public.mfa_use_recovery_code(u, encode(sha256(convert_to('not-a-code', 'UTF8')), 'hex'), '203.0.113.23', 'ua');
  st2 := public.mfa_use_recovery_code(u, hashes[3], '203.0.113.24', 'ua-recover');
  t := public.mfa_use_recovery_code(u, hashes[3], null, 'ua');   -- the same code again
  if st = 'wrong' and st2 = 'ok' and t = 'wrong'
     and not (public.mfa_status(u) ->> 'enrolled')::boolean
     and (public.mfa_status(u) ->> 'codes_left')::int = 0
     and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_u and x.event_type = 'mfa_recovery_used'
                   and (x.payload ->> 'authenticators_removed')::int = 1 and x.ip = '203.0.113.24'::inet)
     and (select count(*) from public.audit_events x where x.chain_key = 'org:' || org_u and x.event_type = 'mfa_failed' and x.payload ->> 'method' = 'recovery_code') = 2
  then res := res || E'PASS T523 AT3.4: a recovery code works once, switches the authenticator off and cancels the other codes; wrong codes are audited\n';
  else res := res || 'FAIL T523 recovery :: st=' || coalesce(st, '?') || ' st2=' || coalesce(st2, '?') || ' again=' || coalesce(t, '?') || E'\n'; end if;

  -- T524: recovery attempts are limited to 5 per 15 minutes per account (3 used above)
  cnt := 0;
  for i in 1..4 loop
    if public.mfa_use_recovery_code(u, hashes[5], null, 'ua') = 'limited' then cnt := cnt + 1; end if;
  end loop;
  if cnt = 2
  then res := res || E'PASS T524 recovery-code attempts are limited to 5 per 15 minutes per account\n';
  else res := res || 'FAIL T524 limit :: limited=' || cnt || E'\n'; end if;

  -- T525 AT3.4: the admin can reset someone else's authenticator (audited, the person is told); nobody else can; not their own
  execute 'reset role';
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (gen_random_uuid(), u, 'new phone', 'totp', 'verified', now(), now(), 'TESTSECRET2');
  execute 'set local role service_role';
  n := 0;
  begin perform public.admin_reset_mfa(u, adm, null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_reset_mfa(adm, adm, null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_reset_mfa(adm, gen_random_uuid(), null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  cnt := public.admin_reset_mfa(adm, u, '203.0.113.25', 'ua-admin');
  select * into r from public.audit_events x where x.chain_key = 'org:' || org_u and x.event_type = 'mfa_reset';
  if n = 0 and cnt = 1 and not (public.mfa_status(u) ->> 'enrolled')::boolean
     and r.actor_type = 'admin' and r.actor_id = adm and r.ip = '203.0.113.25'::inet
     and exists (select 1 from public.notifications x where x.user_id = u and x.kind = 'mfa_reset')
  then res := res || E'PASS T525 AT3.4: only the admin can reset another person''s authenticator, not their own; the reset is audited and the person is told\n';
  else res := res || 'FAIL T525 reset :: n=' || n || ' removed=' || coalesce(cnt, -1) || E'\n'; end if;

  -- T526: switching it off is recorded only when it really is off, and clears the codes
  execute 'reset role';
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (gen_random_uuid(), u, 'phone', 'totp', 'verified', now(), now(), 'TESTSECRET3');
  execute 'set local role service_role';
  perform public.mfa_store_recovery_codes(u, hashes);
  execute 'reset role';
  delete from auth.mfa_factors f where f.user_id = u;
  execute 'set local role service_role';
  perform public.mfa_record_event(u, 'mfa_removed', null, 'ua');
  if (public.mfa_status(u) ->> 'codes_left')::int = 0
     and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_u and x.event_type = 'mfa_removed')
  then res := res || E'PASS T526 switching the authenticator off is audited and cancels the recovery codes\n';
  else res := res || E'FAIL T526 removed\n'; end if;

  -- T527: server-only; the browser cannot see recovery codes; the workspace chain verifies
  n := 0;
  foreach t in array array['public.mfa_status(uuid)', 'public.mfa_store_recovery_codes(uuid, text[])', 'public.mfa_record_event(uuid, text, inet, text)',
                           'public.mfa_use_recovery_code(uuid, text, inet, text)', 'public.admin_reset_mfa(uuid, uuid, inet, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  foreach t in array array['app_private.has_verified_authenticator(uuid)', 'app_private.own_org(uuid)', 'app_private.mfa_audit(uuid, text, uuid, text, jsonb, inet, text)'] loop
    if has_function_privilege('service_role', t, 'execute') or has_function_privilege('authenticated', t, 'execute') then n := n + 1; end if;
  end loop;
  foreach t in array array['select', 'insert', 'update', 'delete'] loop
    if has_table_privilege('authenticated', 'public.mfa_recovery_codes', t) or has_table_privilege('anon', 'public.mfa_recovery_codes', t)
       or has_table_privilege('service_role', 'public.mfa_recovery_codes', t) then n := n + 1; end if;
  end loop;
  execute 'reset role';
  if n = 0 and (select v.ok from app_private.audit_verify('org:' || org_u) v)
  then res := res || E'PASS T527 the functions are server-only, recovery codes are closed to every client role, and the workspace audit chain verifies\n';
  else res := res || 'FAIL T527 privileges or chain :: ' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
