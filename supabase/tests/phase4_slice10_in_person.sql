-- YouNMeSign SQL tests for Phase 4 slice 10: in-person signing (AT4.7, D-86). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); viewer uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; e2 uuid; d2 uuid; kim uuid; rob uuid; pat uuid;
  t_kim uuid := gen_random_uuid(); t_rob uuid := gen_random_uuid(); t_pat uuid := gen_random_uuid();
  s1_tok uuid := gen_random_uuid(); s2_tok uuid := gen_random_uuid(); s3_tok uuid := gen_random_uuid(); s4_tok uuid := gen_random_uuid();
  pin text := 'scrypt$' || repeat('ab', 20);
  body text := 'Slice 10 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  f_kim_txt uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; n int; ok boolean; v text; st text; r record;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't48-host@example.test', now(), '{"provider":"email"}', '{"full_name":"Hana Host"}', now(), now()),
         (viewer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't48-viewer@example.test', now(), '{"provider":"email"}', '{"full_name":"Vic Viewer"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't48-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Oz Outside"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, viewer, 'viewer');
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s48-v1', body);

  execute 'set local role service_role';
  -- e1 (by email, all at once): Kim signs in person, Rob signs through his link
  select e.id into e1 from public.create_envelope(a, org_a, 'Tenancy agreement', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 't.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('d1', 32), 1, 900, '[]', 'pdf') d;
  perform public.set_routing_mode(a, e1, 'parallel');
  perform public.save_recipients(a, e1, '[{"name":"Kim Keys","email":"t48-kim@example.test","role":"in_person","routing_order":1},
                                          {"name":"Rob Remote","email":"t48-rob@example.test","role":"signer","routing_order":1}]');
  select x.id into kim from public.recipients x where x.envelope_id = e1 and x.role = 'in_person';
  select x.id into rob from public.recipients x where x.envelope_id = e1 and x.role = 'signer';
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', kim, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d1, 'recipient_id', kim, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.2, 'w', 0.3, 'h', 0.03),
    jsonb_build_object('document_id', d1, 'recipient_id', rob, 'type', 'signature', 'page', 1, 'x', 0.5, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  select f.id into f_kim_txt from public.fields f where f.recipient_id = kim and f.type = 'text';
  perform public.set_reminders(a, e1, 1, 1, 2);   -- reminders are chosen on the draft
  perform public.send_envelope(a, e1, jsonb_build_array(
    jsonb_build_object('recipient_id', kim, 'token_id', t_kim, 'nonce', repeat('a1', 16), 'token_sha256', repeat('b1', 32)),
    jsonb_build_object('recipient_id', rob, 'token_id', t_rob, 'nonce', repeat('a2', 16), 'token_sha256', repeat('b2', 32))), exp, 'email');
  -- e2 (links): Pat is the only signer and signs in person
  select e.id into e2 from public.create_envelope(a, org_a, 'Second agreement', null) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 's.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('d2', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Pat Present","email":"t48-pat@example.test","role":"in_person","routing_order":1}]');
  select x.id into pat from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', pat, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', pat, 'token_id', t_pat, 'nonce', repeat('a3', 16), 'token_sha256', repeat('b3', 32))), exp, 'link');

  -- T691: an in-person signer is never emailed or reminded; the sender is told it is their turn; the person with a link still is
  ok := not exists (select 1 from public.notification_outbox o where o.recipient_id = kim)
    and exists (select 1 from public.notification_outbox o where o.recipient_id = rob and o.kind = 'signature_request')
    and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'in_person_turn' and q.payload ->> 'by' = 'Kim Keys' and (q.payload ->> 'envelope_id')::uuid = e1);
  perform set_config('easysign.test_clock', 'on', true);
  perform public.process_due(now() + interval '2 days');
  ok := ok and not exists (select 1 from public.notification_outbox o where o.recipient_id = kim)
    and exists (select 1 from public.notification_outbox o where o.recipient_id = rob and o.kind = 'reminder');
  if ok then res := res || E'PASS T691 an in-person signer gets no email and no reminder; the sender is told it is their turn; the person with a link still gets both\n';
  else res := res || E'FAIL T691 no emails for in-person signers\n'; end if;

  -- T692: the link made at sending never works for an in-person signer
  n := 0;
  begin perform public.signer_consent(t_kim, 's48-v1', body_sha, null, 'ua'); n := n + 1; exception when insufficient_privilege then v := sqlerrm; end;
  if n = 0 and v like 'ES_IN_PERSON_ONLY:%' then res := res || E'PASS T692 an in-person signer cannot sign through a link\n';
  else res := res || 'FAIL T692 link refused :: n=' || n || ' ' || coalesce(v, 'null') || E'\n'; end if;

  -- T693: only someone who may handle the document starts a session, only for an in-person signer at their turn;
  -- the old link is retired, a new short-lived one is made, the host's name is recorded and audited
  n := 0;
  begin perform public.start_in_person(viewer, e1, kim, gen_random_uuid(), repeat('c1', 16), repeat('d1', 32), pin); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.start_in_person(outsider, e1, kim, gen_random_uuid(), repeat('c1', 16), repeat('d1', 32), pin); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.start_in_person(a, e1, rob, gen_random_uuid(), repeat('c1', 16), repeat('d1', 32), pin); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.start_in_person(a, e1, kim, gen_random_uuid(), repeat('c1', 16), repeat('d1', 32), 'short'); n := n + 1; exception when invalid_parameter_value then null; end;
  s1 := public.start_in_person(a, e1, kim, s1_tok, repeat('c1', 16), repeat('d1', 32), pin);
  ok := n = 0
    and (select k.revoked_at is not null from public.recipient_tokens k where k.id = t_kim)
    and (select k.revoked_at is null and k.expires_at <= now() + interval '2 hours' from public.recipient_tokens k where k.id = s1_tok)
    and (select s.host_name = 'Hana Host' and s.host_email = 't48-host@example.test' and s.host_user_id = a from public.in_person_sessions s where s.id = s1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1 and x.event_type = 'in_person_started' and x.payload ->> 'host_name' = 'Hana Host');
  if ok then res := res || E'PASS T693 only someone who may handle the document starts in-person signing, only for an in-person signer at their turn; the old link is retired and the host is recorded\n';
  else res := res || 'FAIL T693 start :: n=' || n || E'\n'; end if;

  -- T694: while the session is open and in use the signer signs on the host's device; after 5 quiet minutes it locks
  -- (and the database refuses every signer action); touching it then reports "locked" and audits why
  select * into r from public.in_person_touch(s1_tok);
  perform public.signer_open(repeat('d1', 32), null, 'ua');
  perform public.signer_consent(s1_tok, 's48-v1', body_sha, null, 'ua');
  perform public.signer_fill_field(s1_tok, f_kim_txt, 'first', null, 'ua');
  ok := r.state = 'active' and r.host_name = 'Hana Host' and (select x.status from public.recipients x where x.id = kim) = 'consented';
  update public.in_person_sessions s set last_active_at = now() - interval '6 minutes' where s.id = s1;
  n := 0;
  begin perform public.signer_fill_field(s1_tok, f_kim_txt, 'second', null, 'ua'); n := n + 1; exception when insufficient_privilege then v := sqlerrm; end;
  select * into r from public.in_person_touch(s1_tok);
  ok := ok and n = 0 and v like 'ES_IN_PERSON_LOCKED:%' and r.state = 'locked'
    and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1 and x.event_type = 'in_person_locked' and x.payload ->> 'reason' = 'inactive');
  if ok then res := res || E'PASS T694 the in-person signer signs while the session is in use; after 5 quiet minutes it locks and every signer action is refused\n';
  else res := res || 'FAIL T694 idle lock :: n=' || n || ' ' || coalesce(v, 'null') || ' state=' || coalesce(r.state, 'null') || E'\n'; end if;

  -- T695: only the host's PIN unlocks; a wrong PIN is counted and audited; the right one resumes signing
  st := public.in_person_pin(s1_tok, false, 'unlock');
  ok := st = 'wrong' and (select s.wrong_pins from public.in_person_sessions s where s.id = s1) = 1 and (select s.locked_at is not null from public.in_person_sessions s where s.id = s1);
  st := public.in_person_pin(s1_tok, true, 'unlock');
  perform public.signer_fill_field(s1_tok, f_kim_txt, 'third', null, 'ua');
  ok := ok and st = 'unlocked' and (select s.locked_at is null and s.wrong_pins = 0 from public.in_person_sessions s where s.id = s1)
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_kim_txt) = 'third'
    and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e1 and x.event_type = 'in_person_unlocked');
  -- the screen's own lock (after 3 quiet minutes) also stops signer actions at once
  perform public.in_person_lock(s1_tok, 'inactive');
  n := 0;
  begin perform public.signer_fill_field(s1_tok, f_kim_txt, 'fourth', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and n = 0;
  if ok then res := res || E'PASS T695 only the host''s PIN unlocks (a wrong one is counted and audited); the screen''s own lock stops signing at once\n';
  else res := res || 'FAIL T695 unlock :: st=' || coalesce(st, 'null') || ' n=' || n || E'\n'; end if;

  -- T696: five wrong PINs end the session and retire its link; a new session can then be started, which replaces nothing
  for i in 1..5 loop st := public.in_person_pin(s1_tok, false, 'unlock'); end loop;
  n := 0;
  begin perform public.signer_fill_field(s1_tok, f_kim_txt, 'fifth', null, 'ua'); n := n + 1; exception when insufficient_privilege then v := sqlerrm; end;
  ok := st = 'ended' and n = 0 and v like 'ES_LINK_INVALID:%'
    and (select s.end_reason = 'wrong_pin' from public.in_person_sessions s where s.id = s1)
    and (select k.revoked_at is not null from public.recipient_tokens k where k.id = s1_tok);
  s2 := public.start_in_person(a, e1, kim, s2_tok, repeat('c2', 16), repeat('d2', 32), pin);
  -- starting another session for the same person replaces the open one
  s3 := public.start_in_person(a, e1, kim, s3_tok, repeat('c3', 16), repeat('d3', 32), pin);
  ok := ok and (select s.end_reason = 'replaced' from public.in_person_sessions s where s.id = s2)
    and (select k.revoked_at is not null from public.recipient_tokens k where k.id = s2_tok)
    and (select s.ended_at is null from public.in_person_sessions s where s.id = s3);
  if ok then res := res || E'PASS T696 five wrong PINs end the session and retire its link; a new session replaces any open one for that person\n';
  else res := res || 'FAIL T696 wrong PINs and replacing :: st=' || coalesce(st, 'null') || ' n=' || n || E'\n'; end if;

  -- T697: the host's account: sessions that still lock it are listed (the app asks for the PIN): the open one, and
  -- (D-89) the two that ended without the host's PIN (wrong PINs, replaced); only the host can end theirs; the right PIN
  -- ends it ('finished' once the person signed); signing out ends every open one and clears every lock
  select count(*) into n from public.in_person_host_open(a);
  ok := n = 3 and (select count(*) from public.in_person_host_open(a) h where not h.ended) = 1 and (select count(*) from public.in_person_host_open(outsider)) = 0;
  st := public.in_person_host_end(outsider, s3, true);
  ok := ok and (select s.ended_at is null from public.in_person_sessions s where s.id = s3);
  st := public.in_person_host_end(a, s3, false);
  ok := ok and st = 'wrong';
  execute 'reset role';   -- stand-in for a finished signing: mark Kim as signed directly
  perform app_private.sanction();
  update public.recipients x set status = 'signed', completed_at = now() where x.id = kim;
  perform set_config('easysign.sanctioned', '', true);
  execute 'set local role service_role';
  st := public.in_person_host_end(a, s3, true);
  ok := ok and st = 'ended' and (select s.end_reason = 'finished' from public.in_person_sessions s where s.id = s3)
    and (select count(*) from public.in_person_host_open(a)) = 2;   -- the two that ended without the PIN still lock it
  s4 := public.start_in_person(a, e2, pat, s4_tok, repeat('c4', 16), repeat('d4', 32), pin);
  n := public.in_person_end_for_host(a);
  ok := ok and n = 1 and (select s.end_reason = 'signed_out' from public.in_person_sessions s where s.id = s4)
    and (select k.revoked_at is not null from public.recipient_tokens k where k.id = s4_tok)
    and (select count(*) from public.in_person_host_open(a)) = 0;
  if ok then res := res || E'PASS T697 the host''s open sessions are listed; only the host ends theirs, with the right PIN (recorded as finished once signed); signing out ends them all\n';
  else res := res || 'FAIL T697 host account :: n=' || n || ' st=' || coalesce(st, 'null') || E'\n'; end if;

  -- T698: an already-signed in-person signer cannot be hosted again; everything is server-only
  n := 0;
  begin perform public.start_in_person(a, e1, kim, gen_random_uuid(), repeat('c5', 16), repeat('d5', 32), pin); n := n + 1; exception when invalid_parameter_value then null; end;
  execute 'reset role';
  ok := n = 0
    and not has_function_privilege('authenticated', 'public.start_in_person(uuid, uuid, uuid, uuid, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.in_person_pin(uuid, boolean, text)', 'execute')
    and not has_function_privilege('anon', 'public.in_person_touch(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.in_person_host_open(uuid)', 'execute')
    and not has_table_privilege('authenticated', 'public.in_person_sessions', 'select')
    and not has_table_privilege('anon', 'public.in_person_sessions', 'select');
  if ok then res := res || E'PASS T698 a person who has signed cannot be hosted again; in-person signing is server-only\n';
  else res := res || 'FAIL T698 finished and privileges :: n=' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
