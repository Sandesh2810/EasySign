-- YouNMeSign SQL tests for Phase 4 slice 13: fixes from the independent security review (AT3.8, D-89).
-- Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); m2 uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; kim uuid; e2 uuid; d2 uuid; lou uuid; tpl uuid := gen_random_uuid(); role1 uuid; batch uuid; form uuid;
  t_kim uuid := gen_random_uuid(); s_tok uuid := gen_random_uuid(); s2_tok uuid := gen_random_uuid();
  pin text := 'scrypt$' || repeat('ab', 20);
  body text := 'Slice 13 consent wording'; body_sha text;
  s1 uuid; s2 uuid; n int; ok boolean; v text; st text; r record; c1 int; c2 int; c3 int;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't52-host@example.test', now(), '{"provider":"email"}', '{"full_name":"Hal Host"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't52-mem@example.test', now(), '{"provider":"email"}', '{"full_name":"Mia Member"}', now(), now()),
         (m2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't52-m2@example.test', now(), '{"provider":"email"}', '{"full_name":"Nia Nofactor"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, mem, 'member');
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id in (a, mem);
  body_sha := public.register_consent_version('s52-v1', body);
  insert into public.templates (id, org_id, created_by, name, filename, storage_backend, storage_path, sha256, page_count, size_bytes)
    values (tpl, org_a, a, 'Waiver', 'w.pdf', 'supabase', org_a || '/tpl-' || tpl || '/document.pdf', repeat('cf', 32), 1, 900);
  insert into public.template_roles (template_id, label, role, routing_order, position) values (tpl, 'Volunteer', 'signer', 1, 1) returning id into role1;
  insert into public.template_fields (template_id, role_id, type, page, x, y, w, h, required, options) values (tpl, role1, 'signature', 1, 0.1, 0.8, 0.3, 0.06, true, '{}');

  execute 'set local role service_role';
  -- a document sent by email whose only person signs in person
  select e.id into e1 from public.create_envelope(a, org_a, 'In person', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'p.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('d1', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Kim Keys","email":"t52-kim@example.test","role":"in_person","routing_order":1}]');
  select x.id into kim from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', kim, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', kim, 'token_id', t_kim, 'nonce', repeat('a1', 16), 'token_sha256', repeat('b1', 32))), now() + interval '30 days', 'email');
  -- a second one, for T722 and T723
  select e.id into e2 from public.create_envelope(a, org_a, 'In person 2', null) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'q.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('d2', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Lou Live","email":"t52-lou@example.test","role":"in_person","routing_order":1}]');
  select x.id into lou from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', lou, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', lou, 'token_id', gen_random_uuid(), 'nonce', repeat('a2', 16), 'token_sha256', repeat('b2', 32))), now() + interval '30 days', 'email');

  -- T721 (F1): the in-person signer declines; the session's link is revoked, but the host's account stays locked
  -- until the host's PIN (a wrong one is refused)
  s1 := public.start_in_person(a, e1, kim, s_tok, repeat('c1', 16), repeat('d1', 32), pin);
  perform public.signer_open(repeat('d1', 32), null, 'ua');
  perform public.signer_decline(s_tok, 'Not today', null, 'ua');
  select count(*), bool_and(h.ended) into n, ok from public.in_person_host_open(a) h;
  st := public.in_person_host_end(a, s1, false);
  ok := ok and n = 1 and st = 'wrong' and (select count(*) from public.in_person_host_open(a)) = 1;
  st := public.in_person_host_end(a, s1, true);
  ok := ok and st = 'ended' and (select count(*) from public.in_person_host_open(a)) = 0
    and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1 and x.event_type = 'in_person_host_returned');
  if ok then res := res || E'PASS T721 when an in-person signing ends without the host (the signer declined), the host''s account stays locked until the host''s PIN\n';
  else res := res || 'FAIL T721 host lock after decline :: n=' || n || ' st=' || coalesce(st, 'null') || E'\n'; end if;

  -- T722 (F1): after 2 hours the signing ends but the lock stays; 5 wrong PINs answer locked_out; signing out clears it
  s2 := public.start_in_person(a, e2, lou, s2_tok, repeat('c2', 16), repeat('e2', 32), pin);
  execute 'reset role';
  update public.in_person_sessions s set started_at = now() - interval '3 hours' where s.id = s2;
  execute 'set local role service_role';
  select count(*) into n from public.in_person_host_open(a) h where h.ended;
  ok := n = 1 and (select s.end_reason = 'expired' and not s.host_cleared from public.in_person_sessions s where s.id = s2);
  for i in 1..4 loop st := public.in_person_host_end(a, s2, false); end loop;
  st := public.in_person_host_end(a, s2, false);
  ok := ok and st = 'locked_out' and (select count(*) from public.in_person_host_open(a)) = 1;
  perform public.in_person_end_for_host(a);
  ok := ok and (select count(*) from public.in_person_host_open(a)) = 0;
  if ok then res := res || E'PASS T722 an expired in-person signing keeps the host locked; 5 wrong PINs answer locked out; signing out clears the lock\n';
  else res := res || 'FAIL T722 expiry and sign-out :: n=' || n || ' st=' || coalesce(st, 'null') || E'\n'; end if;

  -- T723 (F3): an in-person signer's link is never revealed, re-sent or emailed with an answer
  perform public.start_in_person(a, e2, lou, gen_random_uuid(), repeat('c3', 16), repeat('f3', 32), pin);
  n := (select count(*) from public.reveal_signing_links(a, e2));
  c1 := 0;
  begin perform public.resend_request(a, e2, lou); c1 := c1 + 1; exception when insufficient_privilege then null; end;
  begin perform public.sender_comment(a, e2, lou, 'Hello'); c1 := c1 + 1; exception when insufficient_privilege then null; end;
  ok := n = 0 and c1 = 0 and not exists (select 1 from public.notification_outbox o where o.recipient_id = lou and o.kind in ('signature_request', 'comment_reply'));
  perform public.in_person_end_for_host(a);
  if ok then res := res || E'PASS T723 an in-person signer''s link is never revealed, re-sent or emailed with an answer\n';
  else res := res || 'FAIL T723 in-person link :: revealed=' || n || ' allowed=' || c1 || E'\n'; end if;

  -- T724 (F9): a member who leaves the workspace loses creator-only access to their bulk batch and public form
  batch := public.create_bulk_batch(mem, tpl, 'link', 30, '[{"row_no":1,"name":"Ann","email":"t52-ann@example.test"}]');
  form := public.create_power_form(mem, tpl, 'Sign up', 10, false, 'DDDDDDDDDDDDDDDDDDDD04');
  ok := (public.bulk_batch_view(mem, batch) ->> 'id')::uuid = batch;
  execute 'reset role';
  update public.memberships m set deactivated_at = now() where m.user_id = mem and m.org_id = org_a;
  execute 'set local role service_role';
  c2 := 0;
  begin perform public.bulk_batch_view(mem, batch); c2 := c2 + 1; exception when insufficient_privilege then null; end;
  begin perform public.cancel_bulk_batch(mem, batch); c2 := c2 + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_power_form_status(mem, form, 'paused'); c2 := c2 + 1; exception when insufficient_privilege then null; end;
  ok := ok and c2 = 0 and (public.bulk_batch_view(a, batch) ->> 'id')::uuid = batch;   -- the owner still can
  if ok then res := res || E'PASS T724 a member who leaves the workspace loses access to the bulk batches and public forms they made; the owner keeps it\n';
  else res := res || 'FAIL T724 deactivated creator :: allowed=' || c2 || E'\n'; end if;

  -- T725 (F2): with an authenticator set up, a session that has not passed it (aal1) reads nothing directly; after the
  -- code (aal2) it reads as before; someone without an authenticator is unaffected
  execute 'reset role';
  insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    values (gen_random_uuid(), a, 'test', 'totp', 'verified', now(), now());
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into c1 from public.envelopes e where e.id = e1;
  select count(*) into n from public.recipients x where x.envelope_id = e1;
  n := n + (select count(*) from public.audit_events x where x.envelope_id = e1) + (select count(*) from public.profiles p where p.id = a);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  select count(*) into c2 from public.envelopes e where e.id = e1;
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  select count(*) into c3 from public.profiles p where p.id = m2;
  execute 'reset role';
  ok := c1 = 0 and n = 0 and c2 = 1 and c3 = 1;
  if ok then res := res || E'PASS T725 with an authenticator set up, a session without the code reads nothing directly; with the code it reads as before; others are unaffected\n';
  else res := res || 'FAIL T725 two-step for direct reads :: aal1=' || c1 || '/' || n || ' aal2=' || c2 || ' nofactor=' || c3 || E'\n'; end if;

  -- T726: every table signed-in users can reach has the two-step rule; the check is not open to anonymous callers
  ok := (select count(*) from pg_policies p where p.schemaname = 'public' and p.policyname like '%\_mfa' escape '\' and p.permissive = 'RESTRICTIVE') = 23
    and not exists (select 1 from pg_policies p where p.schemaname = 'public' and 'authenticated' = any(p.roles) and p.qual is distinct from 'false' and p.permissive = 'PERMISSIVE'
                      and not exists (select 1 from pg_policies q where q.schemaname = 'public' and q.tablename = p.tablename and q.policyname = p.tablename || '_mfa'))
    and not has_function_privilege('anon', 'app_private.mfa_satisfied()', 'execute')
    and not has_function_privilege('authenticated', 'public.in_person_host_open(uuid)', 'execute');
  if ok then res := res || E'PASS T726 every table signed-in users can reach carries the two-step rule; the host-lock lookup stays server-only\n';
  else res := res || E'FAIL T726 coverage and privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
