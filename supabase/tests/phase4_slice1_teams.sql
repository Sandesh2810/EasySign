-- YouNMeSign SQL tests for Phase 4 slice 1: teams (D-75). Self-contained; one transaction; always rolled back.
-- Roles: owner o, admin ad, members m1 and m2, viewer vw; outsider x (own workspace B).
do $test$
declare
  res text := '';
  o uuid := gen_random_uuid(); ad uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  vw uuid := gen_random_uuid(); x uuid := gen_random_uuid(); late uuid := gen_random_uuid();
  org_a uuid; org_b uuid;
  e_o uuid; e_m1 uuid; e_m2 uuid; e_sent uuid; d_sent uuid; s_sent uuid; t_sent uuid := gen_random_uuid();
  inv uuid; inv2 uuid; n int; c int; ok boolean; r record; v text; i int;
  exp timestamptz := now() + interval '30 days';
  tok_ad bytea := decode(repeat('a1', 32), 'hex'); tok_m1 bytea := decode(repeat('a2', 32), 'hex'); tok_m2 bytea := decode(repeat('a3', 32), 'hex');
  tok_vw bytea := decode(repeat('a4', 32), 'hex'); tok_old bytea := decode(repeat('a5', 32), 'hex'); tok_new bytea := decode(repeat('a6', 32), 'hex');
  tok_exp bytea := decode(repeat('a7', 32), 'hex');
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (o,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-owner@example.test',  now(), '{"provider":"email"}', '{"full_name":"Olive Owner"}', now(), now()),
         (ad, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-admin@example.test',  now(), '{"provider":"email"}', '{"full_name":"Adam Admin"}', now(), now()),
         (m1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-m1@example.test',     now(), '{"provider":"email"}', '{"full_name":"Mia One"}', now(), now()),
         (m2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-m2@example.test',     now(), '{"provider":"email"}', '{"full_name":"Mo Two"}', now(), now()),
         (vw, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-viewer@example.test', now(), '{"provider":"email"}', '{"full_name":"Vic Viewer"}', now(), now()),
         (x,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-out@example.test',    now(), '{"provider":"email"}', '{"full_name":"Xena Outside"}', now(), now()),
         (late, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't41-late@example.test', now(), '{"provider":"email"}', '{"full_name":"Lee Late"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = o and m.role = 'owner';
  select m.org_id into org_b from public.memberships m where m.user_id = x and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id in (o, ad, m1, m2, vw, x, late);

  execute 'set local role service_role';

  -- T601: who may invite whom; only a fingerprint of the address goes into the audit trail
  n := 0;
  inv := public.team_invite(o, org_a, 'T41-Admin@Example.test ', 'admin', tok_ad);
  begin perform public.team_invite(m1, org_a, 'nobody1@example.test', 'member', decode(repeat('b1', 32), 'hex')); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_invite(x, org_a, 'nobody2@example.test', 'member', decode(repeat('b2', 32), 'hex')); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_invite(o, org_a, 'not-an-address', 'member', decode(repeat('b3', 32), 'hex')); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.team_invite(o, org_a, 'nobody4@example.test', 'owner', decode(repeat('b4', 32), 'hex')); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.team_invite(o, org_a, 't41-owner@example.test', 'member', decode(repeat('b5', 32), 'hex')); n := n + 1; exception when unique_violation then null; end;
  if n = 0
     and (select i.email from public.team_invitations i where i.id = inv) = 't41-admin@example.test'
     and exists (select 1 from public.audit_events a where a.org_id = org_a and a.event_type = 'member_invited'
                  and a.payload ->> 'email_sha256' = encode(sha256(convert_to('t41-admin@example.test', 'UTF8')), 'hex')
                  and a.payload::text not ilike '%t41-admin%')
  then res := res || E'PASS T601 only the owner or an administrator invites; bad addresses, unknown roles and existing members are refused; the audit trail holds only a fingerprint of the address\n';
  else res := res || 'FAIL T601 invite rules :: n=' || n || E'\n'; end if;

  -- T602: accepting: only the invited address, once, before expiry; admins cannot invite admins
  n := 0;
  begin perform public.team_accept(m1, tok_ad); n := n + 1; exception when insufficient_privilege then null; end;   -- wrong address
  perform public.team_accept(ad, tok_ad);
  begin perform public.team_accept(ad, tok_ad); n := n + 1; exception when insufficient_privilege then null; end;   -- used
  begin perform public.team_invite(ad, org_a, 'nobody6@example.test', 'admin', decode(repeat('b6', 32), 'hex')); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.team_invite(ad, org_a, 't41-m1@example.test', 'member', tok_m1);
  perform public.team_invite(ad, org_a, 't41-m2@example.test', 'member', tok_m2);
  perform public.team_invite(o, org_a, 't41-viewer@example.test', 'viewer', tok_vw);
  perform public.team_accept(m1, tok_m1); perform public.team_accept(m2, tok_m2); perform public.team_accept(vw, tok_vw);
  -- a second invitation to the same address replaces the first; an expired one is refused
  perform public.team_invite(o, org_a, 't41-late@example.test', 'member', tok_old);
  perform public.team_invite(o, org_a, 't41-late@example.test', 'viewer', tok_new);
  begin perform public.team_accept(late, tok_old); n := n + 1; exception when insufficient_privilege then null; end;
  update public.team_invitations i set expires_at = now() - interval '1 minute' where i.token_sha256 = tok_new;
  begin perform public.team_accept(late, tok_new); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0
     and (select string_agg(m.role, ',' order by m.role) from public.memberships m where m.org_id = org_a) = 'admin,member,member,owner,viewer'
     and not exists (select 1 from public.memberships m where m.org_id = org_a and m.user_id = late)
  then res := res || E'PASS T602 an invitation works once, only for the address it names, not after it expires or is replaced; an administrator cannot invite another administrator\n';
  else res := res || 'FAIL T602 accept rules :: n=' || n || E'\n'; end if;

  -- documents: owner, m1, m2 each a draft; m1 also one sent
  select e.id into e_o  from public.create_envelope(o,  org_a, 'Owner draft', null) e;
  select e.id into e_m1 from public.create_envelope(m1, org_a, 'Mia draft', null) e;
  select e.id into e_m2 from public.create_envelope(m2, org_a, 'Mo draft', null) e;
  select e.id into e_sent from public.create_envelope(m1, org_a, 'Mia sent', null) e;
  select d.id into d_sent from public.add_envelope_document(m1, e_sent, 's.pdf', 'supabase', org_a || '/' || e_sent || '/d', repeat('e4', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(m1, e_sent, '[{"name":"Sam Signer","email":"t41-sam@example.test","role":"signer","routing_order":1}]');
  select x2.id into s_sent from public.recipients x2 where x2.envelope_id = e_sent;
  perform public.save_fields(m1, e_sent, jsonb_build_array(jsonb_build_object('document_id', d_sent, 'recipient_id', s_sent, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(m1, e_sent, jsonb_build_array(jsonb_build_object('recipient_id', s_sent, 'token_id', t_sent, 'nonce', repeat('91', 16), 'token_sha256', repeat('c1', 32))), exp, 'link');

  -- T603: server functions: a member handles only their own documents; admin handles all; viewer changes nothing
  n := 0;
  begin perform public.update_envelope_draft(m2, e_m1, 'hijack', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.save_recipients(m1, e_o, '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.void_envelope(m2, e_sent, 'not mine'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.reveal_signing_links(m2, e_sent); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.move_to_folder(m2, e_m1, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_envelope(vw, org_a, 'viewer try', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.update_envelope_draft(vw, e_m1, 'viewer edit', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.update_envelope_draft(x, e_m1, 'outsider', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.update_envelope_draft(m1, e_m1, 'Mia draft (own edit)', '', null);
  perform public.update_envelope_draft(ad, e_m2, 'Mo draft (admin edit)', '', null);
  select count(*) into c from public.reveal_signing_links(ad, e_sent);
  if n = 0 and c = 1
     and (select e.title from public.envelopes e where e.id = e_m1) = 'Mia draft (own edit)'
     and (select e.title from public.envelopes e where e.id = e_m2) = 'Mo draft (admin edit)'
  then res := res || E'PASS T603 a member can change only documents they sent; an administrator can change any; a viewer and an outsider can change none\n';
  else res := res || 'FAIL T603 function rules :: n=' || n || ' links=' || c || E'\n'; end if;

  -- T604: search shows the same thing, in one workspace only
  select count(*) into c from public.search_envelopes(m1, org_a, '', 'all', null, 50, 0);
  select count(*) into n from public.search_envelopes(vw, org_a, '', 'all', null, 50, 0);
  select count(*) into i from public.search_envelopes(ad, org_a, 'mo draft', 'all', null, 50, 0);
  ok := true;
  begin perform public.search_envelopes(x, org_a, '', 'all', null, 50, 0); ok := false; exception when insufficient_privilege then null; end;
  if c = 2 and n = 4 and i = 1 and ok
  then res := res || E'PASS T604 search: a member finds only their own documents, a viewer and an administrator find all, an outsider is refused\n';
  else res := res || 'FAIL T604 search :: member=' || c || ' viewer=' || n || ' admin=' || i || ' outsider_refused=' || ok || E'\n'; end if;

  execute 'reset role';
  -- T605: read rules (what the browser can read directly)
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  select count(*) into c from public.envelopes e where e.org_id = org_a;
  select count(*) into n from public.recipients x3 where x3.envelope_id = e_sent;
  select count(*) into i from public.audit_events a where a.envelope_id = e_o;
  ok := (c = 2 and n = 1 and i = 0 and not exists (select 1 from public.audit_events a where a.org_id = org_a and a.envelope_id is null));
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  ok := ok and (select count(*) from public.recipients x3 where x3.envelope_id = e_sent) = 0
           and (select count(*) from public.fields f where f.envelope_id = e_sent) = 0;
  perform set_config('request.jwt.claims', json_build_object('sub', vw, 'role', 'authenticated')::text, true);
  ok := ok and (select count(*) from public.envelopes e where e.org_id = org_a) = 4
           and exists (select 1 from public.audit_events a where a.org_id = org_a and a.envelope_id is null and a.event_type = 'member_joined');
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  ok := ok and (select count(*) from public.envelopes e where e.org_id = org_a) = 0;
  execute 'reset role';
  if ok then res := res || E'PASS T605 read rules: a member reads only their own documents and none of the workspace-wide trail; a viewer reads everything; an outsider nothing\n';
  else res := res || 'FAIL T605 read rules :: m1 envelopes=' || c || ' m1 recipients of own sent=' || n || ' m1 owner audit=' || i || E'\n'; end if;

  execute 'set local role service_role';
  -- T606: roles: only the owner touches administrators; nobody changes the owner or themselves
  n := 0;
  begin perform public.team_set_role(ad, org_a, m1, 'admin'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_set_role(ad, org_a, o, 'member'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_set_role(ad, org_a, ad, 'viewer'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_set_role(m1, org_a, m2, 'viewer'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_set_active(ad, org_a, o, false); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_set_role(o, org_a, m2, 'owner'); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := public.team_set_role(ad, org_a, m2, 'viewer');
  ok := ok and public.team_set_role(o, org_a, m2, 'admin');
  begin perform public.team_set_active(ad, org_a, m2, false); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and public.team_set_role(o, org_a, m2, 'member');
  if n = 0 and ok
     and exists (select 1 from public.audit_events a where a.org_id = org_a and a.event_type = 'member_role_changed' and a.payload ->> 'to' = 'admin')
  then res := res || E'PASS T606 an administrator manages members and viewers only; only the owner makes or changes administrators; nobody changes the owner or themselves; every change audited\n';
  else res := res || 'FAIL T606 role rules :: n=' || n || ' ok=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T607: deactivation cuts off everything at once and keeps the documents; reactivation restores
  ok := public.team_set_active(ad, org_a, m1, false);
  n := 0;
  begin perform public.create_envelope(m1, org_a, 'after leaving', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.update_envelope_draft(m1, e_m1, 'after leaving', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.search_envelopes(m1, org_a, '', 'all', null, 50, 0); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and not exists (select 1 from public.my_workspaces(m1) w where w.org_id = org_a)
           and exists (select 1 from public.my_workspaces(m1) w where w.role = 'owner');
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  ok := ok and (select count(*) from public.envelopes e where e.org_id = org_a) = 0;
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  ok := ok and (select count(*) from public.envelopes e where e.org_id = org_a and e.sender_id = m1) = 2;
  execute 'reset role';
  execute 'set local role service_role';
  begin perform public.team_set_role(o, org_a, m1, 'viewer'); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and public.team_set_active(o, org_a, m1, true);
  perform public.update_envelope_draft(m1, e_m1, 'back again', '', null);
  if n = 0 and ok and (select e.title from public.envelopes e where e.id = e_m1) = 'back again'
  then res := res || E'PASS T607 a deactivated person loses all access to the workspace at once (functions, search, reads, workspace list); their documents stay with the team; reactivating restores access\n';
  else res := res || 'FAIL T607 deactivation :: n=' || n || ' ok=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T608: who sees the team list and the open invitations; withdrawing an invitation
  inv2 := public.team_invite(o, org_a, 'nobody7@example.test', 'member', decode(repeat('b7', 32), 'hex'));
  select count(*) into c from public.team_members(m2, org_a);
  n := 0;
  begin perform public.team_open_invitations(m2, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_members(x, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.team_revoke_invite(m2, inv2); n := n + 1; exception when insufficient_privilege then null; end;
  select count(*) into i from public.team_open_invitations(ad, org_a);
  ok := public.team_revoke_invite(ad, inv2);
  if n = 0 and c = 5 and i = 1 and ok and (select count(*) from public.team_open_invitations(o, org_a)) = 0
  then res := res || E'PASS T608 every active team member sees who is in the team; only the owner and administrators see and withdraw open invitations; outsiders see nothing\n';
  else res := res || 'FAIL T608 team lists :: n=' || n || ' members=' || c || ' invites=' || i || E'\n'; end if;

  -- T609: at most 25 people per team, counting open invitations
  n := 0;
  for i in 1..20 loop
    perform public.team_invite(o, org_a, 'fill' || i || '@example.test', 'viewer', decode(lpad(to_hex(i), 2, '0') || repeat('d0', 31), 'hex'));
  end loop;
  begin perform public.team_invite(o, org_a, 'one-too-many@example.test', 'viewer', decode(repeat('d9', 32), 'hex')); n := n + 1; exception when program_limit_exceeded then null; end;
  if n = 0 then res := res || E'PASS T609 a team is capped at 25 people including open invitations\n';
  else res := res || E'FAIL T609 team cap not enforced\n'; end if;
  execute 'reset role';

  -- T610: nothing new is reachable from the browser directly
  ok := not has_table_privilege('authenticated', 'public.team_invitations', 'select')
    and not has_function_privilege('authenticated', 'public.team_invite(uuid, uuid, text, text, bytea)', 'execute')
    and not has_function_privilege('authenticated', 'public.search_envelopes(uuid, uuid, text, text, uuid, integer, integer)', 'execute')
    and not has_function_privilege('anon', 'public.my_workspaces(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'app_private.may_handle_envelope(uuid, uuid, uuid, text)', 'execute');
  if ok then res := res || E'PASS T610 invitations and the new team functions are server-only\n';
  else res := res || E'FAIL T610 something new is reachable from the browser\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
