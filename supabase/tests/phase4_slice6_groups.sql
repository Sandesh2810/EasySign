-- YouNMeSign SQL tests for Phase 4 slice 6: signing groups (AT4.5, D-81). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; ann uuid; ben uuid; cy uuid;
  t_ann uuid := gen_random_uuid(); t_ben uuid := gen_random_uuid(); t_cy uuid := gen_random_uuid();
  h_ann text := repeat('a1', 32); h_ben text := repeat('a2', 32); h_cy text := repeat('a3', 32);
  body text := 'Slice 6 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  f_ben_po uuid;
  n int; ok boolean; v text; st text; pl jsonb; rec record;
  people jsonb;
  lay jsonb;
  toks jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't46-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Gil Group"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s46-v1', body);

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Board resolution', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'board.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c8', 32), 1, 900, '[]', 'pdf') d;

  -- T651: the signing group is saved with each person; only signers can be in one
  n := 0;
  begin perform public.save_recipients(a, e1, '[{"name":"Ann Able","email":"t46-ann@example.test","role":"approver","routing_order":1,"signing_group":"Finance"}]');
        n := n + 1; exception when check_violation then null; end;
  people := '[{"name":"Ann Able","email":"t46-ann@example.test","role":"signer","routing_order":1,"signing_group":"Finance"},
              {"name":"Ben Bold","email":"t46-ben@example.test","role":"signer","routing_order":1,"signing_group":" finance "},
              {"name":"Cy Clerk","email":"t46-cy@example.test","role":"signer","routing_order":2}]';
  perform public.save_recipients(a, e1, people);
  select x.id into ann from public.recipients x where x.envelope_id = e1 and x.email = 't46-ann@example.test';
  select x.id into ben from public.recipients x where x.envelope_id = e1 and x.email = 't46-ben@example.test';
  select x.id into cy from public.recipients x where x.envelope_id = e1 and x.email = 't46-cy@example.test';
  -- from here on every save passes everyone's id, so people (and their fields) are updated, never replaced
  people := jsonb_build_array((people -> 0) || jsonb_build_object('id', ann), (people -> 1) || jsonb_build_object('id', ben), (people -> 2) || jsonb_build_object('id', cy));
  if n = 0 and (select x.signing_group from public.recipients x where x.id = ann) = 'Finance'
     and (select x.signing_group from public.recipients x where x.id = ben) = 'finance'
     and (select x.signing_group from public.recipients x where x.id = cy) is null
  then res := res || E'PASS T651 a signing group is saved with each person (trimmed); an approver cannot be in one\n';
  else res := res || 'FAIL T651 saving groups :: n=' || n || E'\n'; end if;

  -- each member gets the same fields (the app copies them); names repeat per person
  lay := '[]'::jsonb;
  for rec in select x.id from public.recipients x where x.envelope_id = e1 and x.id in (ann, ben) loop
    lay := lay || jsonb_build_array(
      jsonb_build_object('document_id', d1, 'recipient_id', rec.id, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
      jsonb_build_object('document_id', d1, 'recipient_id', rec.id, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.2, 'w', 0.3, 'h', 0.03, 'required', false, 'options', jsonb_build_object('name', 'po')));
  end loop;
  lay := lay || jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', cy, 'type', 'signature', 'page', 1, 'x', 0.5, 'y', 0.8, 'w', 0.3, 'h', 0.06));
  toks := jsonb_build_array(
    jsonb_build_object('recipient_id', ann, 'token_id', t_ann, 'nonce', repeat('95', 16), 'token_sha256', h_ann),
    jsonb_build_object('recipient_id', ben, 'token_id', t_ben, 'nonce', repeat('96', 16), 'token_sha256', h_ben),
    jsonb_build_object('recipient_id', cy, 'token_id', t_cy, 'nonce', repeat('97', 16), 'token_sha256', h_cy));

  -- T652: sending is refused for a one-person group, a group split over two places, members with different fields, and a
  -- name used twice by one person; names repeated across members are fine; then it sends
  n := 0;
  -- "custom order" while the group rules are tested, so only the group rules can refuse; the final send is "one after another"
  perform public.set_routing_mode(a, e1, 'mixed');
  perform public.save_fields(a, e1, lay);
  perform public.save_recipients(a, e1, jsonb_set(people, '{1,signing_group}', '"Other"'));
  begin perform public.send_envelope(a, e1, toks, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like 'ES_GROUP: the signing group "%" needs at least two people' then n := n + 10; end if; end;
  perform public.save_recipients(a, e1, jsonb_set(people, '{1,routing_order}', '2'));
  begin perform public.send_envelope(a, e1, toks, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like 'ES_GROUP: everyone in the signing group "%" must have the same place in the order' then n := n + 10; end if; end;
  perform public.save_recipients(a, e1, people);
  perform public.save_fields(a, e1, lay || jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', ben, 'type', 'text', 'page', 1, 'x', 0.5, 'y', 0.5, 'w', 0.2, 'h', 0.03)));
  begin perform public.send_envelope(a, e1, toks, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not ilike 'ES_GROUP: everyone in the signing group "finance" must have the same fields' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, lay || jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', cy, 'type', 'text', 'page', 1, 'x', 0.5, 'y', 0.5, 'w', 0.2, 'h', 0.03, 'required', false, 'options', jsonb_build_object('name', 'x')),
                                                          jsonb_build_object('document_id', d1, 'recipient_id', cy, 'type', 'text', 'page', 1, 'x', 0.5, 'y', 0.6, 'w', 0.2, 'h', 0.03, 'required', false, 'options', jsonb_build_object('name', 'x'))));
  begin perform public.send_envelope(a, e1, toks, exp, 'link'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like '%two fields are named "x"%' then n := n + 10; end if; end;
  perform public.save_fields(a, e1, lay);
  perform public.set_routing_mode(a, e1, 'sequential');   -- the group takes one turn, so "one after another" accepts it
  perform public.send_envelope(a, e1, toks, exp, 'link');
  if n = 0 and (select e.status from public.envelopes e where e.id = e1) = 'sent'
     and (select x.status from public.recipients x where x.id = ann) = 'sent' and (select x.status from public.recipients x where x.id = ben) = 'sent'
     and (select x.status from public.recipients x where x.id = cy) = 'created'
  then res := res || E'PASS T652 sending is refused for a one-person group, a group over two places, members with different fields and a name used twice by one person; members may share names; once sent, both members are in turn together\n';
  else res := res || 'FAIL T652 send-time group checks :: n=' || n || ' last=' || coalesce(v, '?') || E'\n'; end if;
  select f.id into f_ben_po from public.fields f where f.recipient_id = ben and f.type = 'text';

  -- T653: the first member to sign completes the group: the other is no longer needed, the next person is in turn, and
  -- one audit event says who signed and who was no longer needed
  perform public.signer_open(h_ann, null, 'ua');
  perform public.signer_open(h_ben, null, 'ua');
  perform public.signer_consent(t_ann, 's46-v1', body_sha, '203.0.113.46', 'ua');
  perform public.signer_consent(t_ben, 's46-v1', body_sha, '203.0.113.47', 'ua');
  perform public.signer_fill_field(t_ben, f_ben_po, 'PO-77', null, 'ua');
  perform public.signer_adopt_signature(t_ann, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig-ann.png', repeat('6a', 32), null, null, null, 'ua');
  perform public.signer_adopt_signature(t_ben, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig-ben.png', repeat('6b', 32), null, null, null, 'ua');
  st := public.signer_complete(t_ann, repeat('d7', 32), today, null, 'ua');
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'group_completed';
  if st = 'waiting' and (select x.status from public.recipients x where x.id = ann) = 'signed'
     and (select x.status from public.recipients x where x.id = ben) = 'skipped'
     and (select x.group_completed_by from public.recipients x where x.id = ben) = ann
     and (select x.status from public.recipients x where x.id = cy) = 'sent'
     and pl ->> 'by' = ann::text and pl ->> 'by_name' = 'Ann Able' and pl -> 'no_longer_needed' = jsonb_build_array(ben) and pl ->> 'group' = 'Finance'
  then res := res || E'PASS T653 the first member to sign completes the group: the other member is no longer needed, the next person is in turn, and one audit event records who signed and who was no longer needed\n';
  else res := res || 'FAIL T653 group completion :: st=' || coalesce(st, '?') || ' payload=' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T654: the member no longer needed is told who signed, whatever they try
  n := 0;
  begin perform public.signer_complete(t_ben, repeat('d7', 32), today, null, 'ua'); n := n + 1;
        exception when insufficient_privilege then get stacked diagnostics v = message_text;
          if v <> 'ES_GROUP_DONE: Ann Able has already signed for your signing group; nothing more is needed from you' then n := n + 10; end if; end;
  begin perform public.signer_fill_field(t_ben, f_ben_po, 'PO-78', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_decline(t_ben, 'no', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 and (select e.status from public.envelopes e where e.id = e1) = 'in_progress'
  then res := res || E'PASS T654 the member no longer needed cannot sign, fill in or decline, and is told who signed for the group\n';
  else res := res || 'FAIL T654 refusals for the other member :: n=' || n || ' last=' || coalesce(v, '?') || E'\n'; end if;

  -- T655: their link still opens (to show "already completed"); the document finishes without them
  select x.recipient_status into v from public.signer_open(h_ben, null, 'ua') x;
  perform public.signer_open(h_cy, null, 'ua');
  perform public.signer_consent(t_cy, 's46-v1', body_sha, '203.0.113.48', 'ua');
  perform public.signer_adopt_signature(t_cy, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig-cy.png', repeat('6c', 32), null, null, null, 'ua');
  st := public.signer_complete(t_cy, repeat('d7', 32), today, null, 'ua');
  if v = 'skipped' and st = 'sealing' and exists (select 1 from public.seal_jobs j where j.envelope_id = e1)
  then res := res || E'PASS T655 the other member''s link still opens (status "skipped", for the "already completed" page) and the document is sealed once the next person signs\n';
  else res := res || 'FAIL T655 finishing without the other member :: open=' || coalesce(v, '?') || ' st=' || coalesce(st, '?') || E'\n'; end if;
  execute 'reset role';

  -- T656: a skipped person no longer holds up a turn
  ok := app_private.routing_active_order(e1) is null;
  if ok then res := res || E'PASS T656 a member no longer needed never holds up a turn\n';
  else res := res || E'FAIL T656 routing still waits for a skipped member\n'; end if;

  -- T657: completing and declining both take the per-document lock (so two members cannot both sign for the group)
  ok := (select prosrc from pg_proc where oid = 'public.signer_complete(uuid, text, text, inet, text, uuid[])'::regprocedure) like '%pg_advisory_xact_lock(hashtextextended(''env-act:''%'
    and (select prosrc from pg_proc where oid = 'public.signer_decline(uuid, text, inet, text)'::regprocedure) like '%pg_advisory_xact_lock(hashtextextended(''env-act:''%'
    and position('pg_advisory_xact_lock' in (select prosrc from pg_proc where oid = 'public.signer_complete(uuid, text, text, inet, text, uuid[])'::regprocedure))
        < position('require_signer' in (select prosrc from pg_proc where oid = 'public.signer_complete(uuid, text, text, inet, text, uuid[])'::regprocedure));
  if ok then res := res || E'PASS T657 completing and declining take one per-document lock before anything else, so members finishing together are handled one at a time\n';
  else res := res || E'FAIL T657 the per-document lock is missing or taken too late\n'; end if;

  -- T658: the document page (a signed-in user) can read who is in which group and who signed for it
  ok := has_column_privilege('authenticated', 'public.recipients', 'signing_group', 'select')
    and has_column_privilege('authenticated', 'public.recipients', 'group_completed_by', 'select')
    and not has_column_privilege('authenticated', 'public.recipients', 'access_code_hash', 'select');
  if ok then res := res || E'PASS T658 signed-in users can read the signing group and who signed for it (still not the access-code hash)\n';
  else res := res || E'FAIL T658 recipient column privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
