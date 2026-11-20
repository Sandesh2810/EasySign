-- YouNMeSign SQL tests for migration 25: retention, legal hold, deletion (AT3.6). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- owner of workspace A
  m uuid := gen_random_uuid();   -- a member (not owner) of workspace A
  adm uuid := gen_random_uuid(); -- platform admin
  org_a uuid; folder_a uuid; e1 uuid; e2 uuid; d1 uuid; d2 uuid; s1 uuid; s2 uuid; f1 uuid;
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid();
  h1 text := repeat('f1', 32); h2 text := repeat('f2', 32);
  body text := 'Slice 6 consent wording'; body_sha text;
  exp timestamptz := now() + interval '30 days';
  today text := to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');
  job record; ok boolean; n int; cnt int; i int; st text; t text; files jsonb; code1 text; r record; v jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's16-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Olga Owner"}', now(), now()),
         (m, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's16-member@example.test', now(), '{"provider":"email"}', '{"full_name":"Max Member"}', now(), now()),
         (adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's16-admin@example.test', now(), '{"provider":"email"}', '{"full_name":"Ada Admin"}', now(), now());
  select x.org_id into org_a from public.memberships x where x.user_id = a and x.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  insert into public.memberships (org_id, user_id, role) values (org_a, m, 'member');
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  update public.account_controls set is_platform_admin = true where user_id = adm;
  body_sha := public.register_consent_version('s16-v1', body);

  execute 'set local role service_role';
  -- e1: completed and sealed, one signer with a typed value and a signature
  select e.id, e.public_code into e1, code1 from public.create_envelope(a, org_a, 'Confidential: Harbour lease', folder_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'harbour-lease.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('e9', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Rhea Renter","email":"s16-rhea@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.1, 'w', 0.3, 'h', 0.05),
    jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  select f.id into f1 from public.fields f where f.recipient_id = s1 and f.type = 'text';
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('81', 16), 'token_sha256', h1)), exp, 'link');
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 's16-v1', body_sha, '203.0.113.30', 'ua');
  perform public.signer_fill_field(t1, f1, 'Harbour Holdings Ltd', null, 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('5c', 32), null, null, null, 'ua');
  st := public.signer_complete(t1, repeat('d1', 32), today, null, 'ua');
  -- other documents may have sealing jobs waiting (the worker is not running); skip to this one (rolled back anyway)
  for i in 1..50 loop
    select * into job from public.claim_seal_job(300);
    exit when job.envelope_id is null or job.envelope_id = e1;
  end loop;
  ok := public.complete_seal_job(e1, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e1 || '/sealed.pdf', org_a || '/' || e1 || '/cert.pdf', job.audit_seq, job.audit_hash, repeat('ab', 32));
  -- e2: still open
  select e.id into e2 from public.create_envelope(a, org_a, 'Open one', folder_a) e;
  select d.id into d2 from public.add_envelope_document(a, e2, 'g.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('ea', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e2, '[{"name":"Otto Open","email":"s16-otto@example.test","role":"signer","routing_order":1}]');
  select x.id into s2 from public.recipients x where x.envelope_id = e2;
  perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', s2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.3, 'h', 0.07)));
  perform public.send_envelope(a, e2, jsonb_build_array(jsonb_build_object('recipient_id', s2, 'token_id', t2, 'nonce', repeat('82', 16), 'token_sha256', h2)), exp, 'link');

  -- T531: the retention period is the owner's to set (0 to 30 years), audited
  n := 0;
  begin perform public.set_retention_years(m, org_a, 1); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_retention_years(a, org_a, 31); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_retention_years(adm, org_a, 1); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 and st = 'sealing' and ok
     and coalesce((select o.retention_years from public.org_controls o where o.org_id = org_a), 7) = 7
  then res := res || E'PASS T531 the retention period defaults to 7 years and only the workspace owner can change it (0 to 30 years)\n';
  else res := res || 'FAIL T531 retention :: n=' || n || ' st=' || coalesce(st, '?') || ' sealed=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T532: legal hold: owner or platform admin, with a reason, on finished documents only; audited both ways
  n := 0;
  begin perform public.set_legal_hold(m, e1, true, 'dispute'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_legal_hold(a, e1, true, '  '); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_legal_hold(a, e2, true, 'dispute'); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.set_legal_hold(adm, e1, true, 'Court order 12/2026');
  perform public.set_legal_hold(a, e1, false, null);
  perform public.set_legal_hold(a, e1, true, 'Dispute with tenant');
  select * into r from public.envelopes e where e.id = e1;
  if n = 0 and r.legal_hold and r.legal_hold_reason = 'Dispute with tenant' and r.legal_hold_set_by = a
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'legal_hold_set') = 2
     and exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type = 'legal_hold_set' and x.actor_type = 'admin' and x.actor_id = adm)
     and exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type = 'legal_hold_released')
     and not exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.payload::text ilike '%tenant%')
  then res := res || E'PASS T532 a legal hold needs the owner or the platform admin and a reason, applies to finished documents, and is audited when set and released\n';
  else res := res || 'FAIL T532 legal hold :: n=' || n || E'\n'; end if;

  -- T533 AT3.6: a legal hold blocks deletion, even with no retention period left
  perform public.set_retention_years(a, org_a, 0);
  n := 0;
  begin perform public.begin_envelope_deletion(a, e1, null, 'ua'); n := n + 1;
  exception when insufficient_privilege then get stacked diagnostics t = message_text; end;
  if n = 0 and t like 'ES_LEGAL_HOLD%' and (select e.deletion_started_at from public.envelopes e where e.id = e1) is null
     and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'retention_changed' and (x.payload ->> 'to_years')::int = 0)
  then res := res || E'PASS T533 AT3.6: a legal hold blocks deletion even when the retention period is over\n';
  else res := res || 'FAIL T533 hold blocks :: n=' || n || ' msg=' || coalesce(t, '?') || E'\n'; end if;

  -- T534: the retention period blocks deletion until it has passed; open documents and non-owners cannot delete
  perform public.set_legal_hold(a, e1, false, null);
  perform public.set_retention_years(a, org_a, 7);
  n := 0; t := null;
  begin perform public.begin_envelope_deletion(a, e1, null, 'ua'); n := n + 1;
  exception when insufficient_privilege then get stacked diagnostics t = message_text; end;
  cnt := 0;
  perform public.set_retention_years(a, org_a, 0);
  begin perform public.begin_envelope_deletion(a, e2, null, 'ua'); cnt := cnt + 1; exception when insufficient_privilege then null; end;
  begin perform public.begin_envelope_deletion(m, e1, null, 'ua'); cnt := cnt + 1; exception when insufficient_privilege then null; end;
  begin perform public.begin_envelope_deletion(adm, e1, null, 'ua'); cnt := cnt + 1; exception when insufficient_privilege then null; end;
  begin perform public.finish_envelope_deletion(a, e1, 0, null, 'ua'); cnt := cnt + 1; exception when insufficient_privilege then null; end;
  if n = 0 and t like 'ES_RETENTION%' and cnt = 0
  then res := res || E'PASS T534 nothing can be deleted before the retention period ends; open documents, members, the admin, and a finish without a start are refused\n';
  else res := res || 'FAIL T534 retention blocks :: n=' || n || ' cnt=' || cnt || ' msg=' || coalesce(t, '?') || E'\n'; end if;

  -- T535 AT3.6: storage and database together: stored originals stay undeletable until the owner starts the deletion
  execute 'reset role';
  insert into storage.objects (bucket_id, name) values ('originals', org_a || '/' || e1 || '/d1');
  -- what the Storage API sets for its own deletes, so that only our originals_immutable trigger decides below
  perform set_config('storage.allow_delete_query', 'true', true);
  n := 0; t := null;
  begin delete from storage.objects o where o.bucket_id = 'originals' and o.name = org_a || '/' || e1 || '/d1'; n := n + 1;
  exception when insufficient_privilege then get stacked diagnostics t = message_text; end;
  execute 'set local role service_role';
  files := public.begin_envelope_deletion(a, e1, '203.0.113.31', 'ua-delete');
  execute 'reset role';
  delete from storage.objects o where o.bucket_id = 'originals' and o.name = org_a || '/' || e1 || '/d1';
  get diagnostics cnt = row_count;
  execute 'set local role service_role';
  if n = 0 and t = 'original documents of sent envelopes cannot be deleted' and cnt = 1 and jsonb_array_length(files) = 4
     and files @> jsonb_build_array(jsonb_build_object('bucket', 'originals', 'path', org_a || '/' || e1 || '/d1'))
     and files @> jsonb_build_array(jsonb_build_object('bucket', 'sealed', 'path', org_a || '/' || e1 || '/sealed.pdf'))
     and files @> jsonb_build_array(jsonb_build_object('bucket', 'sealed', 'path', org_a || '/' || e1 || '/cert.pdf'))
     and files @> jsonb_build_array(jsonb_build_object('bucket', 'signatures', 'path', org_a || '/' || e1 || '/sig.png'))
     and public.begin_envelope_deletion(a, e1, null, 'ua') = files   -- repeatable until finished
     and exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type = 'deletion_started' and x.actor_id = a)
  then res := res || E'PASS T535 AT3.6: an original stays undeletable in storage until the owner starts the deletion; the start lists every stored file and can be repeated\n';
  else res := res || 'FAIL T535 storage :: blocked-before=' || (n = 0) || ' by=' || coalesce(t, '?') || ' removed-after=' || cnt || ' files=' || coalesce(files::text, 'null') || E'\n'; end if;

  -- T536 AT3.6: finishing removes the content, keeps the fingerprints and the chain, and leaves a tombstone
  perform public.finish_envelope_deletion(a, e1, 4, '203.0.113.31', 'ua-delete');
  select * into r from public.audit_events x where x.envelope_id = e1 and x.event_type = 'envelope_deleted';
  v := public.verify_lookup(code1, 'ip-s16');
  n := 0;
  begin perform public.begin_envelope_deletion(a, e1, null, 'ua'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_legal_hold(a, e1, true, 'too late'); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0
     and (select e.title from public.envelopes e where e.id = e1) = 'Deleted document'
     and (select e.deleted_at from public.envelopes e where e.id = e1) is not null
     and (select e.final_sha256 from public.envelopes e where e.id = e1) = repeat('e2', 32)
     and not exists (select 1 from public.field_values x where x.envelope_id = e1)
     and not exists (select 1 from public.signature_assets x where x.recipient_id = s1)
     and not exists (select 1 from public.consents x where x.envelope_id = e1)
     and (select x.name || ' ' || x.email from public.recipients x where x.id = s1) like 'Removed removed-%@deleted.invalid'
     and (select d.filename from public.envelope_documents d where d.id = d1) = 'deleted.pdf'
     and r.actor_id = a and r.ip = '203.0.113.31'::inet and (r.payload ->> 'files_removed')::int = 4
     -- two values: the typed text, and the signature field's own value (written when the signer finishes)
     and (r.payload ->> 'values_removed')::int = 2 and (r.payload ->> 'signatures_removed')::int = 1 and (r.payload ->> 'consents_removed')::int = 1
     and r.payload ->> 'final_sha256' = repeat('e2', 32)
     and v ->> 'status' = 'completed' and v ->> 'final_sha256' = repeat('e2', 32)
     -- the permanent audit trail keeps the title in its creation event (known limitation, D-71); nothing else names the document or a person
     and (select x.payload ->> 'title' from public.audit_events x where x.envelope_id = e1 and x.event_type = 'envelope_created') = 'Confidential: Harbour lease'
     and not exists (select 1 from public.audit_events x where x.envelope_id = e1 and x.event_type <> 'envelope_created' and (x.payload::text ilike '%harbour%' or x.payload::text ilike '%rhea%'))
  then res := res || E'PASS T536 AT3.6: deletion removes values, signatures, consents, names, emails, title and file names, keeps the fingerprints and the audit chain, and leaves a tombstone event; /verify still answers; only the creation event keeps the title\n';
  else res := res || 'FAIL T536 finish :: again-refused=' || (n = 0) || ' tombstone=' || coalesce(r.payload::text, 'none') || ' verify=' || coalesce(v::text, 'null') || E'\n'; end if;

  -- T537: server-only; nothing can be changed directly; chains verify after deletion
  n := 0;
  foreach t in array array['public.set_retention_years(uuid, uuid, integer)', 'public.set_legal_hold(uuid, uuid, boolean, text)',
                           'public.begin_envelope_deletion(uuid, uuid, inet, text)', 'public.finish_envelope_deletion(uuid, uuid, integer, inet, text)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') or not has_function_privilege('service_role', t, 'execute') then n := n + 1; end if;
  end loop;
  execute 'reset role';
  begin update public.envelopes set legal_hold = true where id = e2; n := n + 1; exception when insufficient_privilege then null; end;
  begin update public.envelopes set title = 'x' where id = e1; n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 and (select x.ok from app_private.audit_verify('env:' || e1) x) and (select x.ok from app_private.audit_verify('org:' || org_a) x)
  then res := res || E'PASS T537 the functions are server-only, hold and deletion columns cannot be changed directly, and the audit chains verify after deletion\n';
  else res := res || 'FAIL T537 privileges or chains :: ' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
