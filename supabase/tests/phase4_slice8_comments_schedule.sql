-- YouNMeSign SQL tests for Phase 4 slice 8: comments and scheduled send (D-84). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; e2 uuid; d2 uuid; e3 uuid; d3 uuid;
  ann uuid; bo uuid; cy uuid; sol uuid; tia uuid;
  t_ann uuid := gen_random_uuid(); t_bo uuid := gen_random_uuid(); t_sol uuid := gen_random_uuid(); t_tia uuid := gen_random_uuid();
  h_ann text := repeat('c1', 32); h_bo text := repeat('c2', 32); h_sol text := repeat('c3', 32); h_tia text := repeat('c4', 32);
  exp timestamptz := now() + interval '30 days';
  c1 uuid; c2 uuid; c3 uuid;
  n int; ok boolean; v text; pl jsonb;
  toks2 jsonb; toks3 jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't48-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Quin Question"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;

  execute 'set local role service_role';
  -- e1: Ann signs and Bo approves at the same time, Cy gets a copy; sent by email
  select e.id into e1 from public.create_envelope(a, org_a, 'Supply agreement', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 's.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('cb', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Ann Able","email":"t48-ann@example.test","role":"signer","routing_order":1},
                                          {"name":"Bo Boss","email":"t48-bo@example.test","role":"approver","routing_order":1},
                                          {"name":"Cy Copy","email":"t48-cy@example.test","role":"cc","routing_order":1}]');
  select x.id into ann from public.recipients x where x.envelope_id = e1 and x.role = 'signer';
  select x.id into bo from public.recipients x where x.envelope_id = e1 and x.role = 'approver';
  select x.id into cy from public.recipients x where x.envelope_id = e1 and x.role = 'cc';
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', ann, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  perform public.set_routing_mode(a, e1, 'parallel');   -- Ann and Bo act at the same time
  perform public.send_envelope(a, e1, jsonb_build_array(
    jsonb_build_object('recipient_id', ann, 'token_id', t_ann, 'nonce', repeat('d1', 16), 'token_sha256', h_ann),
    jsonb_build_object('recipient_id', bo, 'token_id', t_bo, 'nonce', repeat('d2', 16), 'token_sha256', h_bo)), exp, 'email');
  perform public.signer_open(h_ann, null, 'ua');
  perform public.signer_open(h_bo, null, 'ua');

  -- T671: a signer asks a question: stored, written to the audit trail with its text, and the sender is told
  c1 := public.signer_comment(t_ann, '  Is clause 4 negotiable?  ', '203.0.113.81', 'ua');
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'comment_added' and x.payload ->> 'comment_id' = c1::text;
  ok := (select c.body = 'Is clause 4 negotiable?' and c.author_kind = 'signer' and c.recipient_id = ann from public.envelope_comments c where c.id = c1)
    and pl ->> 'body' = 'Is clause 4 negotiable?' and pl ->> 'by' = 'signer'
    and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'comment_added' and q.payload ->> 'by' = 'Ann Able');
  if ok then res := res || E'PASS T671 a signer''s question is stored, written to the audit trail with its text, and the sender is told\n';
  else res := res || 'FAIL T671 signer question :: payload=' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T672: one private thread per person; the sender answers in that thread and the person is emailed the answer;
  -- empty or overlong text and copy-only people are refused
  c2 := public.signer_comment(t_bo, 'Who approved the budget?', null, 'ua');
  c3 := public.sender_comment(a, e1, ann, 'Yes, within 10%.');
  n := 0;
  begin perform public.signer_comment(t_ann, '   ', null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_comment(t_ann, repeat('x', 1001), null, 'ua'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.sender_comment(a, e1, cy, 'Hello'); n := n + 1; exception when insufficient_privilege then null; end;
  ok := n = 0
    and (select array_agg(c.body order by c.created_at, c.author_kind desc) from public.envelope_comments c where c.recipient_id = ann) = array['Is clause 4 negotiable?', 'Yes, within 10%.']
    and (select count(*) from public.envelope_comments c where c.recipient_id = bo) = 1
    and (select c.author_kind = 'sender' and c.author_user = a from public.envelope_comments c where c.id = c3)
    and exists (select 1 from public.notification_outbox o where o.recipient_id = ann and o.kind = 'comment_reply' and o.payload ->> 'comment_id' = c3::text)
    and exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type = 'comment_added' and x.payload ->> 'by' = 'sender' and x.actor_id = a);
  if ok then res := res || E'PASS T672 each person has a private thread; the sender''s answer goes into that thread, the audit trail and an email to the person; empty, overlong and copy-only are refused\n';
  else res := res || 'FAIL T672 threads :: n=' || n || E'\n'; end if;
  execute 'reset role';

  -- T673: comments cannot be changed or removed, not even by the server
  ok := not has_table_privilege('authenticated', 'public.envelope_comments', 'insert')
    and not has_table_privilege('authenticated', 'public.envelope_comments', 'update')
    and not has_table_privilege('service_role', 'public.envelope_comments', 'update')
    and not has_table_privilege('service_role', 'public.envelope_comments', 'delete')
    and has_table_privilege('authenticated', 'public.envelope_comments', 'select');
  if ok then res := res || E'PASS T673 comments cannot be edited or deleted (not even by the server); the sender''s side can read them\n';
  else res := res || E'FAIL T673 comment privileges\n'; end if;

  execute 'set local role service_role';
  -- e2: one signer, for scheduling
  select e.id into e2 from public.create_envelope(a, org_a, 'Monthly report', null) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'm.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('cc', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Sol Solo","email":"t48-sol@example.test","role":"signer","routing_order":1}]');
  select x.id into sol from public.recipients x where x.envelope_id = e2;
  toks2 := jsonb_build_array(jsonb_build_object('recipient_id', sol, 'token_id', t_sol, 'nonce', repeat('d3', 16), 'token_sha256', h_sol));

  -- T674: scheduling checks everything sending would check, right away; the time must be 5 minutes to 60 days ahead
  n := 0;
  perform public.save_fields(a, e2, jsonb_build_array(
    jsonb_build_object('document_id', d2, 'recipient_id', sol, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d2, 'recipient_id', sol, 'type', 'radio', 'page', 1, 'x', 0.1, 'y', 0.2, 'w', 0.3, 'h', 0.06, 'options', jsonb_build_object('choices', '["Only one"]'::jsonb))));
  begin perform public.schedule_send(a, e2, now() + interval '2 hours', 30, 'link', toks2); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like 'ES_FIELD_SETUP: a radio field%' then n := n + 10; end if; end;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', sol, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  begin perform public.schedule_send(a, e2, now() + interval '1 minute', 30, 'link', toks2); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.schedule_send(a, e2, now() + interval '61 days', 30, 'link', toks2); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := n = 0 and not exists (select 1 from public.scheduled_sends s where s.envelope_id = e2) and not exists (select 1 from public.recipient_tokens k where k.envelope_id = e2);
  perform public.schedule_send(a, e2, now() + interval '2 hours', 14, 'link', toks2);
  ok := ok and (select s.status = 'scheduled' and s.expires_days = 14 and s.delivery = 'link' from public.scheduled_sends s where s.envelope_id = e2)
    and (select e.status from public.envelopes e where e.id = e2) = 'draft'
    and not exists (select 1 from public.recipient_tokens k where k.envelope_id = e2)
    and exists (select 1 from public.audit_events x where x.envelope_id = e2 and x.event_type = 'send_scheduled');
  if ok then res := res || E'PASS T674 scheduling runs every send check at once (a half set-up field is refused now, not later), only 5 minutes to 60 days ahead; the trial send leaves nothing behind\n';
  else res := res || 'FAIL T674 scheduling checks :: n=' || n || ' last=' || coalesce(v, '?') || E'\n'; end if;

  -- T675: a scheduled draft is locked until it is cancelled
  n := 0;
  begin perform public.save_fields(a, e2, '[]'::jsonb); n := n + 1;
        exception when insufficient_privilege then get stacked diagnostics v = message_text; if v not like 'ES_SCHEDULED%' then n := n + 10; end if; end;
  begin perform public.schedule_send(a, e2, now() + interval '3 hours', 14, 'link', toks2); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.cancel_scheduled_send(a, e2);
  ok := n = 0 and (select s.status from public.scheduled_sends s where s.envelope_id = e2) = 'cancelled';
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', sol, 'type', 'signature', 'page', 1, 'x', 0.2, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  begin perform public.cancel_scheduled_send(a, e2); n := n + 1; exception when invalid_parameter_value then null; end;
  if ok and n = 0 then res := res || E'PASS T675 while scheduled the draft cannot be changed or scheduled again; after cancelling it can be edited\n';
  else res := res || 'FAIL T675 lock while scheduled :: n=' || n || E'\n'; end if;

  -- T676: the worker sends it when it is due, with the link records made at scheduling time
  perform public.schedule_send(a, e2, now() + interval '10 minutes', 7, 'link', toks2);
  update public.scheduled_sends s set send_at = now() - interval '1 minute' where s.envelope_id = e2;
  n := public.run_scheduled_sends(10);
  ok := n >= 1 and (select e.status from public.envelopes e where e.id = e2) = 'sent'
    and (select s.status = 'sent' and s.done_at is not null from public.scheduled_sends s where s.envelope_id = e2)
    and (select k.expires_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute' from public.recipient_tokens k where k.id = t_sol);
  if ok then res := res || E'PASS T676 when it is due, the worker sends it with the link records made at scheduling time; links last the chosen number of days from sending\n';
  else res := res || 'FAIL T676 scheduled run :: n=' || n || E'\n'; end if;

  -- T677: a send that fails at its time leaves the draft as it was, records why, and tells the sender
  select e.id into e3 from public.create_envelope(a, org_a, 'Will fail', null) e;
  select d.id into d3 from public.add_envelope_document(a, e3, 'f.pdf', 'supabase', org_a || '/' || e3 || '/d3', repeat('cd', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e3, '[{"name":"Tia Tardy","email":"t48-tia@example.test","role":"signer","routing_order":1}]');
  select x.id into tia from public.recipients x where x.envelope_id = e3;
  perform public.save_fields(a, e3, jsonb_build_array(jsonb_build_object('document_id', d3, 'recipient_id', tia, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));
  toks3 := jsonb_build_array(jsonb_build_object('recipient_id', tia, 'token_id', t_tia, 'nonce', repeat('d4', 16), 'token_sha256', h_tia));
  perform public.schedule_send(a, e3, now() + interval '10 minutes', 30, 'link', toks3);
  update public.scheduled_sends s set send_at = now() - interval '1 minute' where s.envelope_id = e3;
  execute 'reset role';
  select c.trust_level into v from public.account_controls c where c.user_id = a;
  update public.account_controls set trust_level = 'suspended' where user_id = a;
  execute 'set local role service_role';
  perform public.run_scheduled_sends(10);
  ok := (select e.status from public.envelopes e where e.id = e3) = 'draft'
    and (select s.status = 'failed' and s.error like 'ES_SUSPENDED%' from public.scheduled_sends s where s.envelope_id = e3)
    and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'scheduled_send_failed' and q.payload ->> 'envelope_id' = e3::text)
    and exists (select 1 from public.audit_events x where x.envelope_id = e3 and x.event_type = 'scheduled_send_failed')
    and not exists (select 1 from public.recipient_tokens k where k.envelope_id = e3);
  execute 'reset role';
  update public.account_controls set trust_level = v where user_id = a;
  if ok then res := res || E'PASS T677 a scheduled send that fails at its time leaves the draft as it was, records why, and tells the sender\n';
  else res := res || E'FAIL T677 failed scheduled run\n'; end if;

  -- T678: all of this is server-only; the stored link records are never readable from a browser
  ok := not has_function_privilege('authenticated', 'public.signer_comment(uuid, text, inet, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.sender_comment(uuid, uuid, uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.schedule_send(uuid, uuid, timestamptz, int, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.cancel_scheduled_send(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.run_scheduled_sends(int)', 'execute')
    and has_column_privilege('authenticated', 'public.scheduled_sends', 'send_at', 'select')
    and not has_column_privilege('authenticated', 'public.scheduled_sends', 'tokens', 'select')
    and not has_table_privilege('anon', 'public.envelope_comments', 'select');
  if ok then res := res || E'PASS T678 commenting and scheduling are server-only; the stored link records are not readable from a browser\n';
  else res := res || E'FAIL T678 privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
