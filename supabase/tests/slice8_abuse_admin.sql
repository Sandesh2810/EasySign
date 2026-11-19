-- EasySign SQL tests for Phase 2 slice 8 (migration 17): abuse reports, suspension ("on hold"), account limits,
-- platform usage (AT2.10). Self-contained: creates its own users and document. Runs as one DO block and ALWAYS
-- ends by raising an exception that carries the results, so everything it creates is rolled back.
-- A result line is "PASS name" or "FAIL name :: detail". Green only if SUMMARY says failed=0.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- a sender
  b uuid := gen_random_uuid();   -- the platform administrator
  org_a uuid; folder_a uuid; e1 uuid; d1 uuid; s1 uuid; rep uuid; oid uuid;
  t1 uuid := gen_random_uuid(); h1 text := repeat('a7', 32);
  n int; st text; st2 text; r record; i int; t text;
begin
  -- ---------- setup as the migration role ----------
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's8-sender@example.test', now(), '{"provider":"email"}', '{"full_name":"Sara Sender"}', now(), now()),
         (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's8-admin@example.test', now(), '{"provider":"email"}', '{"full_name":"Adam Admin"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  update public.account_controls set approved = true where user_id = a;
  update public.account_controls set approved = true, is_platform_admin = true, trust_level = 'trusted' where user_id = b;

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Hold test', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('c3', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Vic Tim","email":"s8-signer@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('51', 16), 'token_sha256', h1)), now() + interval '30 days', 'email');
  select o.id into oid from public.notification_outbox o where o.envelope_id = e1 and o.kind = 'signature_request';

  -- T201 AT2.10: a report flags the document for the administrators
  n := 0;
  begin perform public.report_abuse(gen_random_uuid(), 'looks like a scam', null, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.report_abuse(t1, ' x ', null, null); n := n + 1; exception when invalid_parameter_value then null; end;
  st := public.report_abuse(t1, '  I never dealt with this person. Looks like a SCAM-7781.  ', '203.0.113.9', 'ua');
  st2 := public.report_abuse(t1, 'again', '203.0.113.9', 'ua');
  select x.id into rep from public.abuse_reports x where x.envelope_id = e1;
  if n = 0 and st = 'reported' and st2 = 'already'
     and (select count(*) from public.abuse_reports x where x.envelope_id = e1) = 1
     and (select x.status || '|' || x.reporter_email || '|' || x.reason || '|' || (x.recipient_id = s1)::text from public.abuse_reports x where x.id = rep)
         = 'open|s8-signer@example.test|I never dealt with this person. Looks like a SCAM-7781.|true'
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'abuse_reported' and x.recipient_id = s1) = 1
     and not exists (select 1 from public.audit_events x where x.envelope_id = e1 and x::text like '%SCAM-7781%')
     and (select count(*) from public.notifications q where q.kind = 'abuse_report' and q.user_id = b and q.payload ->> 'report_id' = rep::text) = 1
     and not exists (select 1 from public.notifications q where q.kind = 'abuse_report' and q.user_id = a)
  then res := res || E'PASS T201 AT2.10: anyone with a link can report a document once; the report is stored for the administrators, who are told; the audit trail records that a report was made but not its text\n';
  else res := res || 'FAIL T201 report :: n=' || n || ' ' || coalesce(st, '?') || '/' || coalesce(st2, '?') || E'\n'; end if;

  -- T202: only an administrator can read reports or act on accounts
  n := 0;
  begin perform public.admin_list_abuse_reports(a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_resolve_abuse_report(a, rep, 'dismissed', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_suspension(a, b, true, 'x'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_limits(a, a, 100, 100, true); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_list_accounts(a); n := n + 1; exception when insufficient_privilege then null; end;
  select * into r from public.admin_list_abuse_reports(b) v where v.report_id = rep;
  if n = 0 and r.report_status = 'open' and r.envelope_title = 'Hold test' and r.sender_email = 's8-sender@example.test' and r.sender_open_reports = 1
     and r.reporter_name = 'Vic Tim' and r.sender_trust = 'restricted'
     and (select v.open_reports::text || '|' || v.open_documents from public.admin_list_accounts(b) v where v.account_id = a) = '1|1'
     and (select x.status from public.abuse_reports x where x.id = rep) = 'open'
  then res := res || E'PASS T202 only an administrator can list reports, close them, suspend accounts or change limits; the list shows the document, the sender and how many open reports the sender has\n';
  else res := res || 'FAIL T202 admin only :: ' || n || E'\n'; end if;

  -- T203 AT2.10: suspending the sender
  n := 0;
  begin perform public.admin_set_suspension(b, b, true, 'self'); n := n + 1; exception when insufficient_privilege then null; end;                 -- not an administrator, not yourself
  begin perform public.admin_set_suspension(b, gen_random_uuid(), true, null); n := n + 1; exception when insufficient_privilege then null; end;
  st := public.admin_set_suspension(b, a, true, '  Reported as phishing, case PH-4412  ');
  st2 := public.admin_set_suspension(b, a, true, 'again');
  if n = 0 and st = 'suspended' and st2 = 'unchanged'
     and (select c.trust_level || '|' || c.trust_before_suspension || '|' || c.suspended_reason || '|' || (c.suspended_at is not null)::text from public.account_controls c where c.user_id = a)
         = 'suspended|restricted|Reported as phishing, case PH-4412|true'
     and (select count(*) from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'account_suspended' and x.actor_id = b) = 1
     and not exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x::text like '%PH-4412%')
     and (select count(*) from public.notifications q where q.user_id = a and q.kind = 'account_suspended') = 1
     and (select v.trust || '|' || (v.suspended_since is not null)::text from public.admin_list_accounts(b) v where v.account_id = a) = 'suspended|true'
  then res := res || E'PASS T203 AT2.10: an administrator suspends an account once, with a reason kept for administrators only; an administrator account cannot be suspended; the account holder is told\n';
  else res := res || 'FAIL T203 suspend :: n=' || n || ' ' || coalesce(st, '?') || '/' || coalesce(st2, '?') || E'\n'; end if;

  -- T204 AT2.10: while the sender is suspended the open document is on hold
  n := 0;
  select * into r from public.signer_open(h1, '203.0.113.9', 'ua');
  begin perform public.signer_consent(t1, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_decline(t1, 'no', null, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.signer_auth_state(t1); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_envelope(a, org_a, 'while suspended', folder_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.resend_request(a, e1, s1); n := n + 1; exception when insufficient_privilege then null; end;
  for i in 1..5 loop perform public.claim_outbox(50, 120); end loop;
  if n = 0 and r.turn = 'held'
     and (select x.status from public.recipients x where x.id = s1) = 'sent'
     and (select e.status from public.envelopes e where e.id = e1) = 'sent'
     and (select count(*) from public.recipient_tokens k where k.envelope_id = e1 and k.revoked_at is null) = 1
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'link_on_hold') = 1
     and (select o.status || '|' || o.attempts from public.notification_outbox o where o.id = oid) = 'queued|0'
     and public.report_abuse(t1, 'still suspicious', null, null) = 'already'
  then res := res || E'PASS T204 AT2.10: while the sender is suspended a link opens nothing and nothing can be signed, declined or re-sent; the attempt is recorded; emails about the document wait; nothing is cancelled; the sender cannot create documents\n';
  else res := res || 'FAIL T204 on hold :: n=' || n || ' turn=' || coalesce(r.turn, '?') || E'\n'; end if;

  -- T205: lifting the suspension lets everything continue
  st := public.admin_set_suspension(b, a, false, null);
  st2 := public.admin_set_suspension(b, a, false, null);
  for i in 1..40 loop
    perform public.claim_outbox(50, 120);
    exit when (select o.status from public.notification_outbox o where o.id = oid) = 'sending';
  end loop;
  select * into r from public.signer_open(h1, '203.0.113.9', 'ua');
  perform public.signer_consent(t1, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
  if st = 'lifted' and st2 = 'unchanged' and r.turn = 'now'
     and (select c.trust_level || '|' || (c.trust_before_suspension is null)::text || '|' || (c.suspended_at is null)::text || '|' || (c.suspended_reason is null)::text
            from public.account_controls c where c.user_id = a) = 'restricted|true|true|true'
     and (select o.status from public.notification_outbox o where o.id = oid) = 'sending'
     and (select x.status from public.recipients x where x.id = s1) = 'consented'
     and (select count(*) from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'account_suspension_lifted') = 1
     and (select count(*) from public.notifications q where q.user_id = a and q.kind = 'account_suspension_lifted') = 1
  then res := res || E'PASS T205 lifting the suspension restores the earlier trust level; the held email goes out and the same link works again\n';
  else res := res || 'FAIL T205 lift :: ' || coalesce(st, '?') || '/' || coalesce(st2, '?') || ' turn=' || coalesce(r.turn, '?') || E'\n'; end if;

  -- T206: limits and the "trusted" mark
  n := 0;
  begin perform public.admin_set_limits(b, a, -1, 5, false); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_limits(b, a, 5, 5000, false); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.admin_set_limits(b, a, 5, 5, null); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.admin_set_limits(b, a, 20, 50, true);
  perform public.admin_set_limits(b, a, 20, 50, true);                         -- the same again writes nothing
  st := (select c.daily_envelope_cap || '|' || c.daily_recipient_cap || '|' || c.admin_trusted || '|' || c.trust_level from public.account_controls c where c.user_id = a);
  perform public.admin_set_suspension(b, a, true, null);
  perform public.admin_set_limits(b, a, 20, 50, false);                        -- while suspended: stays suspended
  st2 := (select c.trust_level || '|' || c.trust_before_suspension from public.account_controls c where c.user_id = a);
  perform public.admin_set_suspension(b, a, false, null);
  if n = 0 and st = '20|50|true|trusted' and st2 = 'suspended|restricted'
     and (select c.trust_level from public.account_controls c where c.user_id = a) = 'restricted'
     and (select count(*) from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'account_limits_changed') = 2
     and (select v.documents_per_day || '|' || v.people_per_day || '|' || v.is_trusted from public.admin_list_accounts(b) v where v.account_id = a) = '20|50|false'
  then res := res || E'PASS T206 an administrator can change the daily limits within bounds and mark an account trusted; changing them does not lift a suspension; every real change is in the audit trail\n';
  else res := res || 'FAIL T206 limits :: n=' || n || ' ' || coalesce(st, '?') || ' ' || coalesce(st2, '?') || E'\n'; end if;

  -- T207: closing a report
  n := 0;
  begin perform public.admin_resolve_abuse_report(b, rep, 'deleted', null); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.admin_resolve_abuse_report(b, gen_random_uuid(), 'dismissed', null); n := n + 1; exception when insufficient_privilege then null; end;
  st := public.admin_resolve_abuse_report(b, rep, 'actioned', '  spoke to the sender  ');
  st2 := public.admin_resolve_abuse_report(b, rep, 'dismissed', null);
  -- called on its own line: a function's changes are not visible to other parts of the statement that calls it
  t := public.report_abuse(t1, 'it happened again', null, null);
  if n = 0 and st = 'actioned' and st2 = 'unchanged'
     and (select x.status || '|' || x.note || '|' || (x.decided_by = b)::text || '|' || (x.decided_at is not null)::text from public.abuse_reports x where x.id = rep) = 'actioned|spoke to the sender|true|true'
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'abuse_report_closed' and x.actor_id = b) = 1
     and t = 'reported'
     and (select count(*) from public.abuse_reports x where x.envelope_id = e1) = 2
  then res := res || E'PASS T207 an administrator closes a report once, as handled or dismissed, with a note; after that the same person can report the document again\n';
  else res := res || 'FAIL T207 close report :: n=' || n || ' ' || coalesce(st, '?') || '/' || coalesce(st2, '?') || E'\n'; end if;

  -- T208: usage numbers, and everything here is server-only
  n := 0;
  select * into r from public.platform_usage();
  if r.db_bytes < 1000000 or r.storage_bytes < 0 or r.user_count < 2 or r.emails_today < 0 or r.emails_month < r.emails_today then n := n + 1; end if;
  foreach t in array array['public.report_abuse(uuid, text, inet, text)', 'public.admin_list_abuse_reports(uuid)', 'public.admin_resolve_abuse_report(uuid, uuid, text, text)',
                           'public.admin_set_suspension(uuid, uuid, boolean, text)', 'public.admin_set_limits(uuid, uuid, int, int, boolean)', 'public.admin_list_accounts(uuid)',
                           'public.platform_usage()', 'public.signer_open(text, inet, text)', 'public.claim_outbox(int, int)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  foreach t in array array['app_private.sender_on_hold(uuid)', 'app_private.require_signer(uuid)', 'app_private.signer_gate(uuid)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  if has_table_privilege('authenticated', 'public.abuse_reports', 'select') or has_table_privilege('anon', 'public.abuse_reports', 'select')
     or has_column_privilege('authenticated', 'public.account_controls', 'trust_level', 'update') then n := n + 1; end if;
  if n = 0 then res := res || E'PASS T208 platform usage is reported; every function of this slice is server-only and the reports table is closed to signed-in users\n';
  else res := res || 'FAIL T208 usage and privileges :: ' || n || E'\n'; end if;

  -- T209: the audit chains still verify
  execute 'reset role';
  if (select v2.ok from app_private.audit_verify('env:' || e1) v2) and (select v2.ok from app_private.audit_verify('org:' || org_a) v2)
  then res := res || E'PASS T209 the audit chains of the reported, held and resumed document and of the suspended workspace verify\n';
  else res := res || E'FAIL T209 chains\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
