-- YouNMeSign SQL tests for Phase 4 slice 7: delegate and reassign (AT4.6, D-83). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  org_a uuid; e1 uuid; d1 uuid; e2 uuid; d2 uuid; ann uuid; cy uuid; solo uuid;
  t_ann uuid := gen_random_uuid(); t_cy uuid := gen_random_uuid(); t_solo uuid := gen_random_uuid();
  t_dan uuid := gen_random_uuid(); t_eve uuid := gen_random_uuid(); t_eva uuid := gen_random_uuid(); t_x uuid := gen_random_uuid();
  h_ann text := repeat('b1', 32); h_cy text := repeat('b2', 32); h_solo text := repeat('b3', 32);
  h_dan text := repeat('b4', 32); h_eve text := repeat('b5', 32); h_eva text := repeat('b6', 32);
  body text := 'Slice 7 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  f_ann_txt uuid; f_cy_txt uuid;
  hid uuid; n int; ok boolean; v text; st text; pl jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't47-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Hal Handoff"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  body_sha := public.register_consent_version('s47-v1', body);

  execute 'set local role service_role';
  -- e1: Ann (turn 1) then Cy (turn 2); hand-offs allowed; each has a prefilled greeting with merge text
  select e.id into e1 from public.create_envelope(a, org_a, 'Service contract', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'c.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c9', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Ann Able","email":"t47-ann@example.test","role":"signer","routing_order":1},
                                          {"name":"Cy Clerk","email":"t47-cy@example.test","role":"signer","routing_order":2}]');
  select x.id into ann from public.recipients x where x.envelope_id = e1 and x.routing_order = 1;
  select x.id into cy from public.recipients x where x.envelope_id = e1 and x.routing_order = 2;
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', ann, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d1, 'recipient_id', ann, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.2, 'w', 0.3, 'h', 0.03, 'options', jsonb_build_object('prefill', 'For {{name}}')),
    jsonb_build_object('document_id', d1, 'recipient_id', cy, 'type', 'signature', 'page', 1, 'x', 0.5, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d1, 'recipient_id', cy, 'type', 'text', 'page', 1, 'x', 0.5, 'y', 0.2, 'w', 0.3, 'h', 0.03, 'options', jsonb_build_object('prefill', 'Dear {{first_name}}'))));
  select f.id into f_ann_txt from public.fields f where f.recipient_id = ann and f.type = 'text';
  select f.id into f_cy_txt from public.fields f where f.recipient_id = cy and f.type = 'text';
  -- e2: one signer, hand-offs not allowed
  select e.id into e2 from public.create_envelope(a, org_a, 'No hand-offs', null) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'n.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('ca', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Sol Solo","email":"t47-sol@example.test","role":"signer","routing_order":1}]');
  select x.id into solo from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', solo, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06)));

  -- T661: hand-offs are allowed per document, only while it is a draft
  perform public.set_delegation(a, e1, true);
  perform public.send_envelope(a, e1, jsonb_build_array(
    jsonb_build_object('recipient_id', ann, 'token_id', t_ann, 'nonce', repeat('a1', 16), 'token_sha256', h_ann),
    jsonb_build_object('recipient_id', cy, 'token_id', t_cy, 'nonce', repeat('a2', 16), 'token_sha256', h_cy)), exp, 'link');
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', solo, 'token_id', t_solo, 'nonce', repeat('a3', 16), 'token_sha256', h_solo)), exp, 'link');
  n := 0;
  begin perform public.set_delegation(a, e2, true); n := n + 1; exception when others then null; end;
  if n = 0 and (select e.allow_delegation from public.envelopes e where e.id = e1) and not (select e.allow_delegation from public.envelopes e where e.id = e2)
  then res := res || E'PASS T661 hand-offs are allowed per document, and the setting cannot be changed once it is sent\n';
  else res := res || 'FAIL T661 delegation setting :: n=' || n || E'\n'; end if;

  -- T662: a signer cannot hand off a document whose sender did not allow it
  perform public.signer_open(h_solo, null, 'ua');
  n := 0;
  begin perform public.signer_delegate(t_solo, 'Zed Zero', 't47-zed@example.test', null,
          jsonb_build_object('token_id', t_x, 'nonce', repeat('a9', 16), 'token_sha256', repeat('b9', 32)), null, 'ua'); n := n + 1;
        exception when insufficient_privilege then get stacked diagnostics v = message_text; if v not like 'ES_NOT_ALLOWED%' then n := n + 10; end if; end;
  if n = 0 and (select x.name from public.recipients x where x.id = solo) = 'Sol Solo'
  then res := res || E'PASS T662 a signer cannot hand off a document the sender did not allow to be handed off\n';
  else res := res || 'FAIL T662 delegation not allowed :: n=' || n || E'\n'; end if;

  -- T663: Ann, half-way (consented, signature made), hands her part to Dan: fresh link, old one revoked, her progress cleared,
  -- the sender's prefilled value merged again for Dan, one handoff record, one audit event, and the sender is told
  perform public.signer_open(h_ann, null, 'ua');
  perform public.signer_consent(t_ann, 's47-v1', body_sha, '203.0.113.71', 'ua');
  perform public.signer_adopt_signature(t_ann, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig-ann.png', repeat('7a', 32), null, null, null, 'ua');
  hid := public.signer_delegate(t_ann, 'Dan Delegate', 'T47-Dan@Example.test', 'I am on leave; Dan has authority',
           jsonb_build_object('token_id', t_dan, 'nonce', repeat('a4', 16), 'token_sha256', h_dan), '203.0.113.71', 'ua');
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'recipient_delegated';
  ok := (select k.revoked_at is not null from public.recipient_tokens k where k.id = t_ann)
    and (select k.revoked_at is null and k.recipient_id = ann from public.recipient_tokens k where k.id = t_dan)
    and (select x.name = 'Dan Delegate' and x.email = 't47-dan@example.test' and x.status = 'sent' and x.consented_at is null from public.recipients x where x.id = ann)
    and not exists (select 1 from public.consents c where c.recipient_id = ann and c.withdrawn_at is null)
    and not exists (select 1 from public.signature_assets s where s.recipient_id = ann)
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_ann_txt) = 'For Dan Delegate'
    and exists (select 1 from public.recipient_handoffs h where h.id = hid and h.by_kind = 'signer' and h.by_user is null and h.from_name = 'Ann Able'
                  and h.from_email = 't47-ann@example.test' and h.to_name = 'Dan Delegate' and h.to_email = 't47-dan@example.test' and h.reason = 'I am on leave; Dan has authority')
    and pl ->> 'from_name' = 'Ann Able' and pl ->> 'to_name' = 'Dan Delegate' and (pl ->> 'old_link_revoked')::boolean and (pl ->> 'progress_reset')::boolean
    and (pl ->> 'prefilled_again')::int = 1 and pl ->> 'handoff_id' = hid::text
    and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'recipient_delegated' and q.payload ->> 'to' = 'Dan Delegate');
  if ok then res := res || E'PASS T663 a signer hands off: fresh link, old one revoked, their consent and signature cleared, the sender''s prefilled value merged again for the new person, the handoff recorded and audited, the sender told\n';
  else res := res || 'FAIL T663 signer hand-off :: payload=' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T664: the old link no longer works for anything
  n := 0;
  begin perform public.signer_fill_field(t_ann, f_ann_txt, 'x', null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_complete(t_ann, repeat('d8', 32), today, null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  select count(*) into n from (select 1 from public.signer_open(h_ann, null, 'ua')) q where true; -- revoked: opens nothing
  if n = 0 then res := res || E'PASS T664 the old link opens nothing and can no longer fill in or sign\n';
  else res := res || 'FAIL T664 old link still works :: n=' || n || E'\n'; end if;

  -- T665: the new person signs with the new link; the next person's turn comes
  perform public.signer_open(h_dan, null, 'ua');
  perform public.signer_consent(t_dan, 's47-v1', body_sha, '203.0.113.72', 'ua');
  perform public.signer_adopt_signature(t_dan, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig-dan.png', repeat('7b', 32), null, null, null, 'ua');
  st := public.signer_complete(t_dan, repeat('d8', 32), today, null, 'ua');
  if st = 'waiting' and (select x.status from public.recipients x where x.id = ann) = 'signed' and (select x.status from public.recipients x where x.id = cy) = 'sent'
  then res := res || E'PASS T665 the new person signs with the fresh link and the document moves on\n';
  else res := res || 'FAIL T665 new person signing :: st=' || coalesce(st, '?') || E'\n'; end if;

  -- T666: the sender reassigns Cy to Eve: the same guarantees, recorded as the sender's; finished people and the same address are refused
  execute 'reset role';
  execute 'set local role service_role';
  n := 0;
  begin perform public.reassign_recipient(a, e1, ann, 'Fay', 't47-fay@example.test', null,
          jsonb_build_object('token_id', t_x, 'nonce', repeat('a9', 16), 'token_sha256', repeat('b9', 32))); n := n + 1;
        exception when insufficient_privilege then get stacked diagnostics v = message_text; if v not like 'ES_ALREADY_DONE%' then n := n + 10; end if; end;
  begin perform public.reassign_recipient(a, e1, cy, 'Cy Clerk', 'T47-CY@example.test', null,
          jsonb_build_object('token_id', t_x, 'nonce', repeat('a9', 16), 'token_sha256', repeat('b9', 32))); n := n + 1;
        exception when invalid_parameter_value then null; end;
  hid := public.reassign_recipient(a, e1, cy, 'Eve Example', 't47-eve@example.test', 'Cy has left the company',
           jsonb_build_object('token_id', t_eve, 'nonce', repeat('a5', 16), 'token_sha256', h_eve));
  select x.payload into pl from public.audit_events x where x.envelope_id = e1 and x.event_type = 'recipient_reassigned';
  ok := n = 0
    and (select k.revoked_at is not null from public.recipient_tokens k where k.id = t_cy)
    and (select k.revoked_at is null from public.recipient_tokens k where k.id = t_eve)
    and (select x.name from public.recipients x where x.id = cy) = 'Eve Example'
    and (select v2.value_text from public.field_values v2 where v2.field_id = f_cy_txt) = 'Dear Eve'
    and exists (select 1 from public.recipient_handoffs h where h.id = hid and h.by_kind = 'sender' and h.by_user = a and h.from_name = 'Cy Clerk' and h.to_name = 'Eve Example')
    and (select x.actor_type = 'user' and x.actor_id = a from public.audit_events x where x.envelope_id = e1 and x.event_type = 'recipient_reassigned')
    and pl ->> 'reason' = 'Cy has left the company';
  if ok then res := res || E'PASS T666 the sender reassigns an unfinished person: fresh link, old one revoked, prefilled value merged for the new person, recorded as the sender''s; finished people and the same address are refused\n';
  else res := res || 'FAIL T666 sender reassign :: n=' || n || ' payload=' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T667: correcting an address keeps the sender's prefilled values (they used to be cleared with the old person's answers)
  v := public.correct_recipient(a, e1, cy, 'Eva Example', 't47-eva@example.test',
         jsonb_build_object('token_id', t_eva, 'nonce', repeat('a6', 16), 'token_sha256', h_eva));
  if v = 'email_changed' and (select v2.value_text from public.field_values v2 where v2.field_id = f_cy_txt) = 'Dear Eva'
  then res := res || E'PASS T667 correcting an address keeps the sender''s prefilled value, merged for the corrected person\n';
  else res := res || 'FAIL T667 correct_recipient and prefill :: v=' || coalesce(v, '?') || ' value=' || coalesce((select v2.value_text from public.field_values v2 where v2.field_id = f_cy_txt), 'null') || E'\n'; end if;
  execute 'reset role';

  -- T668: all of this is server-only; signed-in users can read handoffs of documents they may see, never write them
  ok := not has_function_privilege('authenticated', 'public.reassign_recipient(uuid, uuid, uuid, text, text, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.signer_delegate(uuid, text, text, text, jsonb, inet, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.set_delegation(uuid, uuid, boolean)', 'execute')
    and not has_function_privilege('service_role', 'app_private.handoff_core(public.envelopes, public.recipients, text, text, text, jsonb, text, uuid, inet, text)', 'execute')
    and has_table_privilege('authenticated', 'public.recipient_handoffs', 'select')
    and not has_table_privilege('authenticated', 'public.recipient_handoffs', 'insert')
    and not has_table_privilege('anon', 'public.recipient_handoffs', 'select');
  if ok then res := res || E'PASS T668 reassigning, handing off and the setting are server-only; the sender''s side can read handoffs, nobody can write them from a browser\n';
  else res := res || E'FAIL T668 privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
