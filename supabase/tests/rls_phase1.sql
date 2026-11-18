-- EasySign SQL-level security tests (AT1.1, AT1.9, AT1.10, D-24, D-26).
-- Runs as one DO block and ALWAYS ends by raising an exception that carries the results,
-- so every row it creates (including the two test users) is rolled back. Nothing persists.
-- A result line is "PASS name" or "FAIL name :: detail". The run is green only if no line starts with FAIL.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  org_a uuid; org_b uuid; folder_a uuid; folder_b uuid;
  env_a uuid; doc_a uuid; rcp_a uuid; code_a text; obj_path text;
  n int; t text; v record;
  procedure_dummy int;
  e4 uuid;
  e5 uuid;
  e6 uuid;
  e7 uuid;
  e8 uuid;
  d_today text := to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD');
begin
  -- ---------- setup as the migration role ----------
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-a@example.test', now(), '{"provider":"email"}', '{"full_name":"Alice Test"}', now(), now()),
         (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rls-b@example.test', now(), '{"provider":"email"}', '{"full_name":"Bob Test"}', now(), now());

  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_b from public.memberships m where m.user_id = b and m.role = 'owner';
  select f.id into folder_a from public.folders f where f.org_id = org_a;
  select f.id into folder_b from public.folders f where f.org_id = org_b;

  -- T01 bootstrap trigger
  select count(*) into n from public.profiles p where p.id in (a, b);
  if n = 2 and org_a is not null and org_b is not null and org_a <> org_b and folder_a is not null
     and exists (select 1 from public.account_controls c where c.user_id = a and c.approved = false and c.trust_level = 'restricted' and not c.is_platform_admin)
     and exists (select 1 from public.registration_requests q where q.user_id = a and q.status = 'pending')
     and exists (select 1 from public.audit_events e where e.chain_key = 'org:' || org_a and e.event_type = 'account_registered')
  then res := res || E'PASS T01 new user gets profile, restricted+unapproved controls, own workspace, folder, pending request, audit event\n';
  else res := res || E'FAIL T01 bootstrap :: missing rows\n'; end if;

  -- ---------- act as user A ----------
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  begin perform public.create_envelope(a, org_a, 'direct call', folder_a);
    res := res || E'FAIL T02a a signed-in user called create_envelope directly\n';
  exception when insufficient_privilege then res := res || E'PASS T02a signed-in users cannot call state-changing functions directly (server-only, D-35)\n'; end;

  execute 'set local role service_role';
  begin
    select e.id, e.public_code into env_a, code_a from public.create_envelope(a, org_a, 'NDA test', folder_a) e;
    if code_a ~ '^ES-[0-9]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}-[0-9A-HJKMNP-TV-Z]{2}$' then res := res || E'PASS T02 member creates an envelope and gets a well-formed code\n';
    else res := res || 'FAIL T02 code format :: ' || coalesce(code_a, 'null') || E'\n'; end if;
  exception when others then res := res || 'FAIL T02 create_envelope :: ' || sqlerrm || E'\n';
  end;

  -- add children as the migration role (draft stage)
  execute 'reset role';
  insert into public.envelope_documents (org_id, envelope_id, filename, storage_path, sha256, page_count, size_bytes, page_boxes)
    values (org_b /* deliberately wrong: the guard must overwrite it */, env_a, 'nda.pdf', org_a || '/' || env_a || '/doc1', repeat('ab', 32), 2, 1000, '[]')
    returning id into doc_a;
  insert into public.recipients (org_id, envelope_id, name, email, access_code_hash) values (org_a, env_a, 'Sam Signer', 'sam@example.test', 'secret-hash')
    returning id into rcp_a;
  insert into public.fields (org_id, envelope_id, document_id, recipient_id, type, page, x, y, w, h)
    values (org_a, env_a, doc_a, rcp_a, 'signature', 1, 0.1, 0.1, 0.3, 0.05);
  obj_path := org_a || '/' || env_a || '/doc1';
  insert into storage.objects (bucket_id, name, metadata, version) values ('originals', obj_path, '{"size":1000}', 'v1');

  if (select d.org_id from public.envelope_documents d where d.id = doc_a) = org_a
  then res := res || E'PASS T03 child rows take their tenant from the envelope (spoofed org_id overwritten)\n';
  else res := res || E'FAIL T03 tenant spoof :: org_id not corrected\n'; end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);

  select (select count(*) from public.envelopes) + (select count(*) from public.envelope_documents) + (select count(*) from public.fields)
       + (select count(*) from (select id from public.recipients) r) into n;
  if n = 4 then res := res || E'PASS T04 A reads own envelope, document, recipient, field\n'; else res := res || 'FAIL T04 A own reads :: got ' || n || E'\n'; end if;

  begin execute 'update public.account_controls set is_platform_admin = true, trust_level = ''trusted'', approved = true where user_id = ' || quote_literal(a);
    res := res || E'FAIL T05 A escalated own privileges\n';
  exception when insufficient_privilege then res := res || E'PASS T05 A cannot edit own account controls (admin flag, trust, approval, quotas)\n'; end;

  begin execute 'update public.envelopes set status = ''completed'' where id = ' || quote_literal(env_a);
    res := res || E'FAIL T06 A changed envelope status directly\n';
  exception when insufficient_privilege then res := res || E'PASS T06 A cannot update envelopes directly\n'; end;

  begin execute 'insert into public.fields (org_id, envelope_id, document_id, recipient_id, type, page, x, y, w, h) values ('
      || quote_literal(org_a) || ',' || quote_literal(env_a) || ',' || quote_literal(doc_a) || ',' || quote_literal(rcp_a) || ', ''text'', 1, 0, 0, 0.1, 0.1)';
    res := res || E'FAIL T07 A wrote fields directly\n';
  exception when insufficient_privilege then res := res || E'PASS T07 A cannot write fields except through functions\n'; end;

  begin execute 'select access_code_hash from public.recipients';
    res := res || E'FAIL T08 access_code_hash readable\n';
  exception when insufficient_privilege then res := res || E'PASS T08 access-code hash is not readable even by the owner\n'; end;

  t := '';
  foreach t in array array['platform_settings', 'recipient_tokens', 'notification_outbox', 'org_controls', 'registration_requests', 'email_budget', 'rate_limits', 'usage_counters', 'abuse_reports'] loop
    begin execute 'select count(*) from public.' || t into n;
      res := res || 'FAIL T09 service-only table readable :: ' || t || E'\n';
    exception when insufficient_privilege then null; end;
  end loop;
  res := res || E'PASS T09 nine service-only tables are unreadable by logged-in users (any FAIL T09 line above overrides)\n';

  begin execute 'insert into public.audit_events (id, chain_key, chain_seq, actor_type, event_type, created_at, canonical, prev_hash, event_hash) values (gen_random_uuid(), ''x'', 1, ''user'', ''forged'', now(), ''{}'', decode(repeat(''00'',32),''hex''), decode(repeat(''00'',32),''hex''))';
    res := res || E'FAIL T10 A inserted an audit event\n';
  exception when insufficient_privilege then res := res || E'PASS T10 A cannot insert audit events\n'; end;

  begin perform app_private.audit_append('env:' || env_a, org_a, env_a, null, 'user', a, 'forged');
    res := res || E'FAIL T11 A called audit_append\n';
  exception when insufficient_privilege then res := res || E'PASS T11 A cannot call the audit-append function\n'; end;

  begin perform app_private.sanction();
    res := res || E'FAIL T12 A called sanction()\n';
  exception when insufficient_privilege then res := res || E'PASS T12 A cannot mark a transaction as sanctioned\n'; end;

  begin execute 'insert into public.folders (org_id, parent_id, name, created_by) values (' || quote_literal(org_a) || ',' || quote_literal(folder_b) || ', ''x'', ' || quote_literal(a) || ')';
    res := res || E'FAIL T13 A nested a folder under another workspace''s folder\n';
  exception when others then res := res || E'PASS T13 A cannot attach a folder to another workspace''s folder\n'; end;

  begin execute 'insert into public.folders (org_id, name, created_by) values (' || quote_literal(org_a) || ', ''Contracts'', ' || quote_literal(a) || ')';
    res := res || E'PASS T14 A can create a folder in own workspace\n';
  exception when others then res := res || 'FAIL T14 own folder :: ' || sqlerrm || E'\n'; end;

  -- ---------- act as user B ----------
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);

  select (select count(*) from public.envelopes where org_id = org_a)
       + (select count(*) from public.envelope_documents where org_id = org_a)
       + (select count(*) from (select id from public.recipients where org_id = org_a) r)
       + (select count(*) from public.fields where org_id = org_a)
       + (select count(*) from public.audit_events where org_id = org_a)
       + (select count(*) from public.folders where org_id = org_a)
       + (select count(*) from public.organizations where id = org_a)
       + (select count(*) from public.memberships where org_id = org_a)
       + (select count(*) from public.org_settings where org_id = org_a)
       + (select count(*) from public.profiles where id = a)
       + (select count(*) from public.account_controls where user_id = a)
       + (select count(*) from public.seal_jobs)
       + (select count(*) from public.field_values where org_id = org_a)
       + (select count(*) from public.consents where org_id = org_a)
       + (select count(*) from public.signature_assets where org_id = org_a) into n;
  if n = 0 then res := res || E'PASS T15 B sees zero rows of A across 15 tables\n'; else res := res || 'FAIL T15 cross-tenant read :: rows visible ' || n || E'\n'; end if;

  select count(*) into n from public.envelopes;
  if n = 0 then res := res || E'PASS T16 B''s unfiltered envelope list is empty (no leak without a filter)\n'; else res := res || 'FAIL T16 :: ' || n || E'\n'; end if;

  begin execute 'insert into public.folders (org_id, name, created_by) values (' || quote_literal(org_a) || ', ''intruder'', ' || quote_literal(b) || ')';
    res := res || E'FAIL T18 B created a folder in A''s workspace\n';
  exception when insufficient_privilege then res := res || E'PASS T18 B cannot create a folder in A''s workspace\n'; end;

  execute 'update public.folders set name = ''hacked'' where org_id = ' || quote_literal(org_a);
  get diagnostics n = row_count;
  execute 'delete from public.folders where org_id = ' || quote_literal(org_a);
  get diagnostics procedure_dummy = row_count;
  if n = 0 and procedure_dummy = 0 then res := res || E'PASS T19 B''s update and delete of A''s folders affect zero rows\n'; else res := res || E'FAIL T19 B modified A''s folders\n'; end if;

  begin execute 'select count(*) from storage.objects' into n;
    if n = 0 then res := res || E'PASS T21 B sees no storage objects\n'; else res := res || 'FAIL T21 storage read :: ' || n || E'\n'; end if;
  exception when insufficient_privilege then res := res || E'PASS T21 B cannot read storage objects\n'; end;

  begin execute 'insert into storage.objects (bucket_id, name) values (''originals'', ' || quote_literal(org_a || '/x/y') || ')';
    res := res || E'FAIL T22 B wrote into storage\n';
  exception when others then res := res || E'PASS T22 B cannot write storage objects\n'; end;

  -- ---------- anonymous ----------
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  n := 0;
  foreach t in array array['envelopes', 'recipients', 'profiles', 'audit_events', 'folders', 'organizations'] loop
    begin execute 'select count(*) from public.' || t into procedure_dummy; n := n + 1;
    exception when insufficient_privilege then null; end;
  end loop;
  begin perform public.create_envelope(a, org_a, 'anon', null); n := n + 1;
  exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T23 anonymous role can read no table and call no function\n'; else res := res || 'FAIL T23 anon access :: ' || n || E'\n'; end if;

  -- ---------- service role ----------
  execute 'set local role service_role';
  n := 0;
  begin execute 'update public.audit_events set event_type = ''x'''; n := n + 1; exception when insufficient_privilege then null; end;
  begin execute 'delete from public.audit_events'; n := n + 1; exception when insufficient_privilege then null; end;
  begin execute 'truncate public.audit_events'; n := n + 1; exception when insufficient_privilege then null; end;
  begin execute 'insert into public.audit_events (id, chain_key, chain_seq, actor_type, event_type, created_at, canonical, prev_hash, event_hash) values (gen_random_uuid(), ''x'', 1, ''user'', ''forged'', now(), ''{}'', decode(repeat(''00'',32),''hex''), decode(repeat(''00'',32),''hex''))'; n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T24 service role cannot insert, update, delete or truncate audit events\n'; else res := res || 'FAIL T24 service role audit writes :: ' || n || E'\n'; end if;

  begin execute 'update public.envelopes set status = ''sent'' where id = ' || quote_literal(env_a);
    res := res || E'FAIL T25 service role changed envelope status outside a sanctioned function\n';
  exception when insufficient_privilege then res := res || E'PASS T25 service role cannot change envelope status outside a sanctioned function\n'; end;

  -- the server passes the verified user id; the function itself re-checks that user's membership
  begin perform public.create_envelope(b, org_a, 'intruder', null);
    res := res || E'FAIL T17 an envelope was created in A''s workspace on behalf of B\n';
  exception when insufficient_privilege then res := res || E'PASS T17 create_envelope refuses an actor who is not a member of the workspace\n'; end;

  begin perform public.create_envelope(b, org_b, 'B doc', folder_a);
    res := res || E'FAIL T20 B''s envelope was filed into A''s folder\n';
  exception when foreign_key_violation then res := res || E'PASS T20 an envelope cannot be filed into another workspace''s folder\n'; end;

  begin perform app_private.is_member_of(a, org_a, 'viewer');
    res := res || E'FAIL T36 service role called a private helper directly\n';
  exception when insufficient_privilege then res := res || E'PASS T36 private helpers are not callable, even by the service role\n'; end;

  -- ---------- draft functions (migration 6), still as the service role ----------
  declare
    e2 uuid; e3 uuid; d2 uuid; r2 uuid; h1 text; h2 text; cnt int; fld jsonb; pth text;
  begin
    select e.id into e2 from public.create_envelope(a, org_a, 'Draft function test', null) e;
    pth := org_a || '/' || e2 || '/d1';

    begin perform public.add_envelope_document(b, e2, 'x.pdf', 'supabase', pth, repeat('ab', 32), 2, 1000, '[]', 'pdf');
      res := res || E'FAIL T41 a non-member attached a document\n';
    exception when insufficient_privilege then res := res || E'PASS T41 a non-member cannot attach a document (and learns nothing about whether the envelope exists)\n'; end;

    begin perform public.add_envelope_document(a, e2, 'x.pdf', 'supabase', org_b || '/' || e2 || '/d1', repeat('ab', 32), 2, 1000, '[]', 'pdf');
      res := res || E'FAIL T42 document attached with a storage path from another workspace\n';
    exception when insufficient_privilege then res := res || E'PASS T42 a storage path outside the envelope''s own folder is refused\n'; end;

    select d.id into d2 from public.add_envelope_document(a, e2, 'x.pdf', 'supabase', pth, repeat('ab', 32), 2, 1000, '[]', 'pdf') d;
    begin perform public.add_envelope_document(a, e2, 'y.pdf', 'supabase', org_a || '/' || e2 || '/d2', repeat('cd', 32), 1, 500, '[]', 'pdf');
      res := res || E'FAIL T43 second document attached\n';
    exception when unique_violation then
      if exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e2 and x.event_type = 'document_uploaded')
      then res := res || E'PASS T43 one document per envelope; the upload is in the audit chain\n';
      else res := res || E'FAIL T43 document_uploaded event missing\n'; end if;
    end;

    update public.account_controls set storage_quota_bytes = 1500 where user_id = a;
    select e.id into e3 from public.create_envelope(a, org_a, 'Quota test', null) e;
    begin perform public.add_envelope_document(a, e3, 'big.pdf', 'supabase', org_a || '/' || e3 || '/d1', repeat('ef', 32), 1, 1000, '[]', 'pdf');
      res := res || E'FAIL T44 upload accepted over the storage allowance\n';
    exception when disk_full then res := res || E'PASS T44 an upload over the user''s storage allowance is refused\n'; end;

    select x.id into r2 from public.save_recipients(a, e2, '[{"name":" Sam Signer ","email":"SAM@Example.test","role":"signer","routing_order":1}]') x limit 1;
    if exists (select 1 from public.recipients x where x.id = r2 and x.email = 'sam@example.test' and x.name = 'Sam Signer')
       and (select count(*) from public.recipients x where x.envelope_id = e2) = 1
    then res := res || E'PASS T45 recipients are saved, trimmed and lower-cased\n'; else res := res || E'FAIL T45 save_recipients\n'; end if;

    fld := jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', r2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.1, 'w', 0.3, 'h', 0.05));
    h1 := public.save_fields(a, e2, fld);
    h2 := public.save_fields(a, e2, fld);
    select count(*) into cnt from public.audit_events x where x.chain_key = 'env:' || e2 and x.event_type = 'fields_changed';
    if h1 = h2 and h1 ~ '^[0-9a-f]{64}$' and cnt = 1 and (select e.field_layout_sha256 from public.envelopes e where e.id = e2) = h1
    then res := res || E'PASS T46 fields save; saving the same layout twice writes one audit event, not two\n';
    else res := res || 'FAIL T46 save_fields :: events=' || cnt || E'\n'; end if;

    begin perform public.save_fields(a, e2, jsonb_build_array(jsonb_build_object('document_id', d2, 'recipient_id', r2, 'type', 'text', 'page', 3, 'x', 0.1, 'y', 0.1, 'w', 0.3, 'h', 0.05)));
      res := res || E'FAIL T47 field accepted on a page that does not exist\n';
    exception when invalid_parameter_value then res := res || E'PASS T47 a field on a non-existent page is refused\n'; end;

    begin perform public.save_fields(b, e2, fld);
      res := res || E'FAIL T48 a non-member saved fields\n';
    exception when insufficient_privilege then res := res || E'PASS T48 a non-member cannot save fields\n'; end;

    select count(*) into cnt from public.delete_draft_envelope(a, e2) x where x.storage_path = pth;
    if cnt = 1 and not exists (select 1 from public.envelopes e where e.id = e2) and not exists (select 1 from public.fields f where f.envelope_id = e2)
    then res := res || E'PASS T49 deleting a draft removes it and reports the stored file to clean up\n'; else res := res || E'FAIL T49 delete_draft_envelope\n'; end if;
  end;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  n := 0;
  begin perform public.save_fields(a, env_a, '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.save_recipients(a, env_a, '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.delete_draft_envelope(a, env_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.update_envelope_draft(a, env_a, 'x', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T50 signed-in users cannot call the draft functions directly\n'; else res := res || 'FAIL T50 :: ' || n || E' callable\n'; end if;

  -- ---------- send, sign, seal (migration 7), as the service role ----------
  execute 'set local role service_role';
  declare
    d4 uuid; r4 uuid; f_sig uuid; f_txt uuid; f_date uuid; tok uuid := gen_random_uuid(); tok_hash text := repeat('7a', 32);
    toks jsonb; exp timestamptz := now() + interval '30 days'; job record; ok boolean; cnt int; st text; code4 text; ob record;
  begin
    update public.account_controls set storage_quota_bytes = 52428800, approved = false where user_id = a;
    select e.id, e.public_code into e4, code4 from public.create_envelope(a, org_a, 'Flow test', folder_a) e;
    select d.id into d4 from public.add_envelope_document(a, e4, 'f.pdf', 'supabase', org_a || '/' || e4 || '/d1', repeat('aa', 32), 1, 900, '[]', 'pdf') d;

    begin perform public.send_envelope(a, e4, '[]', exp, 'link');
      res := res || E'FAIL T52 sent with no signer\n';
    exception when invalid_parameter_value then res := res || E'PASS T52 a document cannot be sent without a signer\n'; end;

    select x.id into r4 from public.save_recipients(a, e4, '[{"name":"Sam Signer","email":"sam@example.test","role":"signer","routing_order":1}]') x limit 1;
    toks := jsonb_build_array(jsonb_build_object('recipient_id', r4, 'token_id', tok, 'nonce', repeat('0b', 16), 'token_sha256', tok_hash));

    begin perform public.send_envelope(a, e4, toks, exp, 'email');
      res := res || E'FAIL T53 sent with no signature field\n';
    exception when invalid_parameter_value then res := res || E'PASS T53 a document cannot be sent without a signature field for the signer\n'; end;

    perform public.save_fields(a, e4, jsonb_build_array(
      jsonb_build_object('document_id', d4, 'recipient_id', r4, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.7, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d4, 'recipient_id', r4, 'type', 'date_signed', 'page', 1, 'x', 0.5, 'y', 0.7, 'w', 0.2, 'h', 0.03),
      jsonb_build_object('document_id', d4, 'recipient_id', r4, 'type', 'text', 'page', 1, 'x', 0.5, 'y', 0.8, 'w', 0.2, 'h', 0.03)));
    select f.id into f_sig from public.fields f where f.envelope_id = e4 and f.type = 'signature';
    select f.id into f_txt from public.fields f where f.envelope_id = e4 and f.type = 'text';
    select f.id into f_date from public.fields f where f.envelope_id = e4 and f.type = 'date_signed';

    begin perform public.send_envelope(a, e4, toks, exp, 'email');
      res := res || E'FAIL T54 an unapproved account sent to another person\n';
    exception when insufficient_privilege then res := res || E'PASS T54 AT1.3: in approval mode an unapproved account cannot send to other people\n'; end;

    update public.account_controls set approved = true where user_id = a;
    update public.usage_counters set envelopes_sent = 3 where user_id = a;
    insert into public.usage_counters (day, user_id, envelopes_sent) values ((now() at time zone 'UTC')::date, a, 3) on conflict (day, user_id) do update set envelopes_sent = 3;
    begin perform public.send_envelope(a, e4, toks, exp, 'email');
      res := res || E'FAIL T55 a restricted account sent a 4th document in one day\n';
    exception when configuration_limit_exceeded then res := res || E'PASS T55 AT1.3: a new account is stopped at 3 documents a day\n'; end;
    update public.usage_counters set envelopes_sent = 0 where user_id = a;

    perform public.send_envelope(a, e4, toks, exp, 'email');
    select count(*) into cnt from public.notification_outbox o where o.envelope_id = e4 and o.kind = 'signature_request' and o.priority = 'P0_REQUEST' and o.payload = '{}'::jsonb;
    if (select e.status from public.envelopes e where e.id = e4) = 'sent' and cnt = 1
       and (select x.status from public.recipients x where x.id = r4) = 'sent'
       and (select k.token_sha256 from public.recipient_tokens k where k.id = tok) = decode(tok_hash, 'hex')
       and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e4 and x.event_type = 'envelope_sent')
       and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e4 and x.event_type = 'email_queued')
    then res := res || E'PASS T56 AT1.5: sending stores only the hash of the link; the outbox row carries no link; send and queue are audited\n';
    else res := res || E'FAIL T56 send_envelope result\n'; end if;

    begin perform public.send_envelope(a, e4, toks, exp, 'email');
      res := res || E'FAIL T57 sent twice\n';
    exception when insufficient_privilege then res := res || E'PASS T57 a document cannot be sent twice\n'; end;

    select count(*) into cnt from public.signer_open(repeat('00', 32), '203.0.113.9', 'ua');
    select * into job from public.signer_open(tok_hash, '203.0.113.9', 'ua');
    if cnt = 0 and job.token_id = tok and job.recipient_status = 'viewed' and job.envelope_status = 'in_progress'
    then res := res || E'PASS T58 an unknown link opens nothing; the real link marks the signer as viewed and the envelope in progress\n';
    else res := res || E'FAIL T58 signer_open\n'; end if;

    begin perform public.signer_fill_field(tok, f_txt, 'Acme Ltd', '203.0.113.9', 'ua');
      res := res || E'FAIL T59 field filled before consent\n';
    exception when insufficient_privilege then res := res || E'PASS T59 nothing can be filled in before consent is given\n'; end;

    perform public.signer_consent(tok, 'esign-consent-v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_consent(tok, 'esign-consent-v1', repeat('c1', 32), '203.0.113.9', 'ua');
    select count(*) into cnt from public.consents c where c.recipient_id = r4;
    if cnt = 1 and (select x.status from public.recipients x where x.id = r4) = 'consented'
    then res := res || E'PASS T60 consent is recorded once with its version hash, IP and browser\n'; else res := res || E'FAIL T60 consent\n'; end if;

    n := 0;
    begin perform public.signer_fill_field(tok, f_sig, 'x', null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_fill_field(tok, (select f.id from public.fields f where f.envelope_id = env_a limit 1), 'x', null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_fill_field(gen_random_uuid(), f_txt, 'x', null, null); n := n + 1; exception when insufficient_privilege then null; end;
    if n = 0 then res := res || E'PASS T61 a signer cannot type into a signature field, another envelope''s field, or act with a made-up link id\n';
    else res := res || 'FAIL T61 :: ' || n || E'\n'; end if;

    n := 0;
    begin perform public.signer_fill_field(tok, f_date, '2019-01-01', null, null); n := n + 1; exception when insufficient_privilege then null; end;
    if n = 0 then res := res || E'PASS T75 the signer cannot type into the date field (the system fills it in)\n';
    else res := res || E'FAIL T75 the signer set the date field\n'; end if;

    n := 0;
    begin perform public.reveal_signing_links(b, e4); n := n + 1; exception when insufficient_privilege then null; end;
    select count(*) into cnt from public.reveal_signing_links(a, e4);
    if n = 0 and cnt = 1 and exists (select 1 from public.audit_events x where x.envelope_id = e4 and x.event_type = 'link_revealed' and x.actor_id = a)
    then res := res || E'PASS T78 only a member of the workspace can fetch a signing link, and doing so is written to the audit trail\n';
    else res := res || 'FAIL T78 reveal :: n=' || n || ' rows=' || cnt || E'\n'; end if;

    begin perform public.signer_complete(tok, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
      res := res || E'FAIL T62 completed without a signature\n';
    exception when invalid_parameter_value then res := res || E'PASS T62 the signer cannot finish without creating a signature\n'; end;

    perform public.signer_adopt_signature(tok, 'signature', 'drawn', 'supabase', org_a || '/' || e4 || '/sig1.png', repeat('5a', 32), null, null, '203.0.113.9', 'ua');
    n := 0;
    begin perform public.signer_complete(tok, repeat('d1', 32), '2019-01-01', '203.0.113.9', 'ua'); n := n + 1;
    exception when others then if sqlerrm not like 'ES_DATE%' then n := n + 10; end if; end;
    begin perform public.signer_complete(tok, repeat('d1', 32), '9999-99-99', '203.0.113.9', 'ua'); n := n + 1;
    exception when others then if sqlerrm not like 'invalid completion data%' then n := n + 10; end if; end;
    if n = 0 then res := res || E'PASS T76 a signing date that is not today, or is not a real date, is refused\n';
    else res := res || 'FAIL T76 backdating :: ' || n || E'\n'; end if;

    begin perform public.signer_complete(tok, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
      res := res || E'FAIL T63 completed with a required field empty\n';
    exception when invalid_parameter_value then res := res || E'PASS T63 the signer cannot finish while a required field is empty\n'; end;

    perform public.signer_fill_field(tok, f_txt, '  Acme Ltd  ', '203.0.113.9', 'ua');
    select count(*) into cnt from public.audit_events x where x.envelope_id = e4;
    perform public.signer_fill_field(tok, f_txt, 'Acme Ltd', '203.0.113.9', 'ua');
    if cnt = (select count(*) from public.audit_events x where x.envelope_id = e4)
    then res := res || E'PASS T77 saving an unchanged value writes nothing to the audit trail\n';
    else res := res || E'FAIL T77 unchanged value logged again\n'; end if;
    st := public.signer_complete(tok, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
    if st = 'sealing'
       and (select v2.signature_id from public.field_values v2 where v2.field_id = f_sig) = code4 || '-S1'
       and (select v2.value_text from public.field_values v2 where v2.field_id = f_date) = d_today
       and (select v2.value_text from public.field_values v2 where v2.field_id = f_txt) = 'Acme Ltd'
       and (select x.status from public.recipients x where x.id = r4) = 'signed'
       and exists (select 1 from public.seal_jobs j where j.envelope_id = e4 and j.status = 'queued')
       and (select e.status from public.envelopes e where e.id = e4) = 'in_progress'
    then res := res || E'PASS T64 finishing applies the signature with id <code>-S1, fills the date, marks the signer signed and queues sealing\n';
    else res := res || 'FAIL T64 signer_complete :: ' || coalesce(st, 'null') || E'\n'; end if;

    begin perform public.signer_complete(tok, repeat('d1', 32), d_today, null, null);
      res := res || E'FAIL T65 signed twice\n';
    exception when insufficient_privilege then res := res || E'PASS T65 a signer cannot sign twice\n'; end;

    select * into job from public.claim_seal_job(300);
    select count(*) into cnt from public.claim_seal_job(300);
    if job.envelope_id = e4 and job.attempts = 1 and job.audit_hash ~ '^[0-9a-f]{64}$' and cnt = 0
    then res := res || E'PASS T66 the seal job is claimed once; a second worker gets nothing while the lease is held\n';
    else res := res || E'FAIL T66 claim_seal_job\n'; end if;

    ok := public.complete_seal_job(e4, gen_random_uuid(), repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e4 || '/sealed.pdf', org_a || '/' || e4 || '/cert.pdf', job.audit_seq, job.audit_hash);
    if ok then res := res || E'FAIL T67 a worker with a stale attempt id finalised the envelope\n';
    else res := res || E'PASS T67 a worker whose attempt id is stale cannot finalise (no double sealing)\n'; end if;

    begin perform public.complete_seal_job(e4, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e4 || '/sealed.pdf', org_a || '/' || e4 || '/cert.pdf', job.audit_seq, repeat('ff', 32));
      res := res || E'FAIL T68 sealed with a checkpoint that is not in the chain\n';
    exception when invalid_parameter_value then res := res || E'PASS T68 sealing is refused if the audit checkpoint does not match the chain\n'; end;

    ok := public.complete_seal_job(e4, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e4 || '/sealed.pdf', org_a || '/' || e4 || '/cert.pdf', job.audit_seq, job.audit_hash);
    select count(*) into cnt from public.notification_outbox o where o.envelope_id = e4 and o.kind in ('completion_copy', 'completion_sender') and o.priority = 'P1';
    if ok and cnt = 2
       and exists (select 1 from public.envelopes e where e.id = e4 and e.status = 'completed' and e.final_sha256 = repeat('e2', 32) and e.audit_seal_seq = job.audit_seq and e.folder_id = folder_a and e.sealed_at is not null)
       and exists (select 1 from public.notifications x where x.user_id = a and x.kind = 'envelope_completed')
    then res := res || E'PASS T69 AT1.10: completion records hashes and checkpoint, keeps the chosen folder and queues a copy for every party\n';
    else res := res || 'FAIL T69 complete_seal_job :: ok=' || ok || ' copies=' || cnt || E'\n'; end if;

    begin perform public.signer_fill_field(tok, f_txt, 'changed after completion', null, null);
      res := res || E'FAIL T70 a field changed after completion\n';
    exception when insufficient_privilege then res := res || E'PASS T70 nothing can be changed through the signing link after completion\n'; end;

    select * into ob from public.claim_outbox(1, 120);
    st := public.finish_outbox(ob.id, 'sent', null, 'log-1', null);
    if ob.kind = 'signature_request' and st = 'sent' and public.finish_outbox(ob.id, 'sent', null, 'log-1', null) = 'ignored'
       and exists (select 1 from public.audit_events x where x.chain_key = 'env:' || e4 and x.event_type = 'email_sent')
    then res := res || E'PASS T71 the outbox hands out the signature request first; marking it sent twice has no second effect\n';
    else res := res || 'FAIL T71 outbox :: ' || coalesce(ob.kind, 'none') || ' ' || coalesce(st, 'null') || E'\n'; end if;

    perform public.email_budget_record('P0_REQUEST', a, true);
    perform public.email_budget_record('P0_AUTH', null, false);
    select * into job from public.email_budget_state(a);
    if job.sent_today_shared >= 1 and job.sent_today_auth >= 1 and job.restricted_sent_today >= 1 and job.user_sent_today >= 1 and job.days_left_in_month between 1 and 31
    then res := res || E'PASS T72 email budget counters record by class, by sender and for restricted accounts\n'; else res := res || E'FAIL T72 email budget\n'; end if;
    update public.account_controls set approved = false where user_id = a;
  end;

  -- ---------- several recipients: turns, approval, decline (migration 10, D-52), as the service role ----------
  declare
    d5 uuid; d6 uuid; exp timestamptz := now() + interval '30 days'; cnt int; st text; row5 record; job5 record; ok boolean; code5 text; toks jsonb;
    boss uuid; ccx uuid; s1 uuid; s2 uuid; vw uuid; s3 uuid; x1 uuid; x2 uuid;
    t_boss uuid := gen_random_uuid(); t_s1 uuid := gen_random_uuid(); t_s2 uuid := gen_random_uuid(); t_vw uuid := gen_random_uuid(); t_s3 uuid := gen_random_uuid();
    t_x1 uuid := gen_random_uuid(); t_x2 uuid := gen_random_uuid();
    h_boss text := repeat('b1', 32); h_s1 text := repeat('b2', 32); h_s2 text := repeat('b3', 32); h_vw text := repeat('b4', 32); h_s3 text := repeat('b5', 32);
    h_x1 text := repeat('b6', 32); h_x2 text := repeat('b7', 32);
  begin
    update public.account_controls set approved = true, daily_recipient_cap = 50, daily_envelope_cap = 50 where user_id = a;
    select e.id, e.public_code into e5, code5 from public.create_envelope(a, org_a, 'Routing test', folder_a) e;
    select d.id into d5 from public.add_envelope_document(a, e5, 'f.pdf', 'supabase', org_a || '/' || e5 || '/d1', repeat('ab', 32), 1, 900, '[]', 'pdf') d;
    perform public.save_recipients(a, e5, '[
      {"name":"Boss","email":"boss@example.test","role":"approver","routing_order":1},
      {"name":"Copy","email":"copy@example.test","role":"cc","routing_order":1},
      {"name":"S One","email":"s1@example.test","role":"signer","routing_order":2},
      {"name":"S Two","email":"s2@example.test","role":"signer","routing_order":2},
      {"name":"Viewer","email":"view@example.test","role":"viewer","routing_order":2},
      {"name":"S Three","email":"s3@example.test","role":"signer","routing_order":3}]');
    select x.id into boss from public.recipients x where x.envelope_id = e5 and x.email = 'boss@example.test';
    select x.id into ccx from public.recipients x where x.envelope_id = e5 and x.email = 'copy@example.test';
    select x.id into s1 from public.recipients x where x.envelope_id = e5 and x.email = 's1@example.test';
    select x.id into s2 from public.recipients x where x.envelope_id = e5 and x.email = 's2@example.test';
    select x.id into vw from public.recipients x where x.envelope_id = e5 and x.email = 'view@example.test';
    select x.id into s3 from public.recipients x where x.envelope_id = e5 and x.email = 's3@example.test';
    perform public.save_fields(a, e5, jsonb_build_array(
      jsonb_build_object('document_id', d5, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d5, 'recipient_id', s2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.6, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d5, 'recipient_id', s3, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.7, 'w', 0.3, 'h', 0.07)));
    toks := jsonb_build_array(
      jsonb_build_object('recipient_id', boss, 'token_id', t_boss, 'nonce', repeat('01', 16), 'token_sha256', h_boss),
      jsonb_build_object('recipient_id', s1, 'token_id', t_s1, 'nonce', repeat('02', 16), 'token_sha256', h_s1),
      jsonb_build_object('recipient_id', s2, 'token_id', t_s2, 'nonce', repeat('03', 16), 'token_sha256', h_s2),
      jsonb_build_object('recipient_id', vw, 'token_id', t_vw, 'nonce', repeat('04', 16), 'token_sha256', h_vw),
      jsonb_build_object('recipient_id', s3, 'token_id', t_s3, 'nonce', repeat('05', 16), 'token_sha256', h_s3));

    n := 0;
    begin perform public.send_envelope(a, e5, toks, exp, 'email'); n := n + 1; exception when invalid_parameter_value then null; end; -- two signers share a place, mode is "one after another"
    begin perform public.set_routing_mode(b, e5, 'mixed'); n := n + 1; exception when insufficient_privilege then null; end;           -- not a member
    perform public.set_routing_mode(a, e5, 'mixed');
    begin perform public.send_envelope(a, e5, toks - 4, exp, 'email'); n := n + 1; exception when invalid_parameter_value then null; end; -- one link record missing
    if n = 0 and (select e.status from public.envelopes e where e.id = e5) = 'draft'
    then res := res || E'PASS T83 send refuses a tie in "one after another" and a missing link record; only a member can change the routing\n';
    else res := res || 'FAIL T83 routing validation :: ' || n || E'\n'; end if;

    perform public.send_envelope(a, e5, toks, exp, 'email');
    select count(*) into cnt from public.notification_outbox o where o.envelope_id = e5;
    if cnt = 1 and exists (select 1 from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'approval_request' and o.recipient_id = boss and o.priority = 'P0_REQUEST')
       and (select x.status from public.recipients x where x.id = boss) = 'sent'
       and (select count(*) from public.recipients x where x.envelope_id = e5 and x.id <> boss and x.status = 'created') = 5
       and (select count(*) from public.recipient_tokens k where k.envelope_id = e5) = 5
       and not exists (select 1 from public.recipient_tokens k where k.recipient_id = ccx)
    then res := res || E'PASS T84 AT2.1: on send only the first turn is contacted; later turns wait and a copy-only recipient gets no link\n';
    else res := res || 'FAIL T84 first turn :: outbox=' || cnt || E'\n'; end if;

    select * into row5 from public.signer_open(h_s1, '203.0.113.9', 'ua');
    n := 0;
    begin perform public.signer_consent(t_s1, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_complete(t_s1, repeat('d1', 32), d_today, null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_decline(t_s1, 'no', null, null); n := n + 1; exception when insufficient_privilege then null; end;
    if row5.turn = 'waiting' and n = 0 and (select x.status from public.recipients x where x.id = s1) = 'created'
       and (select e.status from public.envelopes e where e.id = e5) = 'sent'
       and exists (select 1 from public.audit_events x where x.envelope_id = e5 and x.recipient_id = s1 and x.event_type = 'out_of_turn')
    then res := res || E'PASS T85 AT2.1: a valid link used before its turn opens nothing, changes nothing, and is recorded\n';
    else res := res || 'FAIL T85 out of turn :: turn=' || coalesce(row5.turn, 'null') || ' n=' || n || E'\n'; end if;

    select * into row5 from public.signer_open(h_boss, '203.0.113.9', 'ua');
    perform public.signer_consent(t_boss, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    n := 0;
    begin perform public.signer_complete(t_boss, repeat('d1', 32), d_today, null, null); n := n + 1; exception when insufficient_privilege then null; end;
    st := public.signer_approve(t_boss, '203.0.113.9', 'ua');
    if row5.turn = 'now' and n = 0 and st = 'waiting' and (select x.status from public.recipients x where x.id = boss) = 'approved'
       and (select count(*) from public.recipients x where x.id in (s1, s2, vw) and x.status = 'sent') = 3
       and (select x.status from public.recipients x where x.id = s3) = 'created'
       and (select x.status from public.recipients x where x.id = ccx) = 'created'
       and (select count(*) from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'signature_request' and o.recipient_id in (s1, s2)) = 2
       and exists (select 1 from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'view_notice' and o.recipient_id = vw and o.priority = 'P2')
       and not exists (select 1 from public.notification_outbox o where o.envelope_id = e5 and o.recipient_id in (ccx, s3))
    then res := res || E'PASS T86 AT2.1: approver gate. The approver cannot sign, approves, and only then is the next turn (and its viewer) contacted\n';
    else res := res || 'FAIL T86 approver :: ' || coalesce(st, 'null') || ' n=' || n || E'\n'; end if;

    select * into row5 from public.signer_open(h_vw, '203.0.113.9', 'ua');
    n := 0;
    begin perform public.signer_consent(t_vw, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_approve(t_s2, null, null); n := n + 1; exception when insufficient_privilege then null; end; -- a signer cannot "approve"
    perform public.signer_open(h_s2, '203.0.113.9', 'ua');
    perform public.signer_consent(t_s2, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_s2, 'signature', 'drawn', 'supabase', org_a || '/' || e5 || '/sig-s2.png', repeat('5b', 32), null, null, '203.0.113.9', 'ua');
    st := public.signer_complete(t_s2, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
    if row5.turn = 'view' and n = 0 and st = 'waiting' and (select x.status from public.recipients x where x.id = vw) = 'viewed'
       and (select x.status from public.recipients x where x.id = s3) = 'created'
       and not exists (select 1 from public.seal_jobs j where j.envelope_id = e5)
    then
      perform public.signer_open(h_s1, '203.0.113.9', 'ua');
      perform public.signer_consent(t_s1, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
      perform public.signer_adopt_signature(t_s1, 'signature', 'typed', 'supabase', org_a || '/' || e5 || '/sig-s1.png', repeat('5c', 32), 'S One', 'browser-script', '203.0.113.9', 'ua');
      st := public.signer_complete(t_s1, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
      if st = 'waiting' and (select x.status from public.recipients x where x.id = s3) = 'sent'
         and (select v2.signature_id from public.field_values v2 join public.fields f on f.id = v2.field_id where f.recipient_id = s2) = code5 || '-S1'
         and (select v2.signature_id from public.field_values v2 join public.fields f on f.id = v2.field_id where f.recipient_id = s1) = code5 || '-S2'
         and exists (select 1 from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'signature_request' and o.recipient_id = s3)
      then res := res || E'PASS T87 AT2.1: people in the same turn act in any order; the next turn starts only when all have finished; a viewer reads but cannot act\n';
      else res := res || 'FAIL T87 second half :: ' || coalesce(st, 'null') || E'\n'; end if;
    else res := res || 'FAIL T87 first half :: turn=' || coalesce(row5.turn, 'null') || ' st=' || coalesce(st, 'null') || ' n=' || n || E'\n'; end if;

    perform public.signer_open(h_s3, '203.0.113.9', 'ua');
    perform public.signer_consent(t_s3, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_s3, 'signature', 'drawn', 'supabase', org_a || '/' || e5 || '/sig-s3.png', repeat('5d', 32), null, null, '203.0.113.9', 'ua');
    st := public.signer_complete(t_s3, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
    select count(*) into cnt from public.seal_jobs j where j.envelope_id = e5 and j.status = 'queued';
    select * into job5 from public.claim_seal_job(300);
    ok := public.complete_seal_job(e5, job5.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e5 || '/sealed.pdf', org_a || '/' || e5 || '/certificate.pdf', job5.audit_seq, job5.audit_hash);
    if st = 'sealing' and cnt = 1 and job5.envelope_id = e5 and ok and (select e.status from public.envelopes e where e.id = e5) = 'completed'
       and (select count(*) from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'completion_copy') = 6
       and exists (select 1 from public.notification_outbox o where o.envelope_id = e5 and o.kind = 'completion_copy' and o.recipient_id = ccx)
    then res := res || E'PASS T88 AT2.1: the last signature queues sealing exactly once; every party, including copy-only and viewer, is queued a completed copy\n';
    else res := res || 'FAIL T88 completion :: ' || coalesce(st, 'null') || ' jobs=' || cnt || E'\n'; end if;

    -- decline: two signers one after another, links shared by the sender (no request emails)
    select e.id into e6 from public.create_envelope(a, org_a, 'Decline test', folder_a) e;
    select d.id into d6 from public.add_envelope_document(a, e6, 'f.pdf', 'supabase', org_a || '/' || e6 || '/d1', repeat('ac', 32), 1, 900, '[]', 'pdf') d;
    perform public.save_recipients(a, e6, '[{"name":"X One","email":"x1@example.test","role":"signer","routing_order":1},{"name":"X Two","email":"x2@example.test","role":"signer","routing_order":2}]');
    select x.id into x1 from public.recipients x where x.envelope_id = e6 and x.email = 'x1@example.test';
    select x.id into x2 from public.recipients x where x.envelope_id = e6 and x.email = 'x2@example.test';
    perform public.save_fields(a, e6, jsonb_build_array(
      jsonb_build_object('document_id', d6, 'recipient_id', x1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d6, 'recipient_id', x2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.6, 'w', 0.3, 'h', 0.07)));
    perform public.send_envelope(a, e6, jsonb_build_array(
      jsonb_build_object('recipient_id', x1, 'token_id', t_x1, 'nonce', repeat('06', 16), 'token_sha256', h_x1),
      jsonb_build_object('recipient_id', x2, 'token_id', t_x2, 'nonce', repeat('07', 16), 'token_sha256', h_x2)), exp, 'link');
    perform public.signer_open(h_x1, '203.0.113.9', 'ua');
    perform public.signer_decline(t_x1, '  Wrong price  ', '203.0.113.9', 'ua');
    select count(*) into cnt from public.signer_open(h_x2, '203.0.113.9', 'ua');
    n := 0;
    begin perform public.signer_consent(t_x1, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_decline(t_x2, null, null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.reveal_signing_links(a, e6); n := n + 1; exception when insufficient_privilege then null; end;
    if cnt = 0 and n = 0 and (select e.status from public.envelopes e where e.id = e6) = 'declined'
       and (select x.status || '|' || coalesce(x.decline_reason, '') from public.recipients x where x.id = x1) = 'declined|Wrong price'
       and (select x.status from public.recipients x where x.id = x2) = 'skipped'
       and (select count(*) from public.recipient_tokens k where k.envelope_id = e6 and k.revoked_at is null) = 0
       and not exists (select 1 from public.seal_jobs j where j.envelope_id = e6)
       and not exists (select 1 from public.notification_outbox o where o.envelope_id = e6 and o.kind in ('signature_request', 'completion_copy'))
       and exists (select 1 from public.notification_outbox o where o.envelope_id = e6 and o.kind = 'declined_sender' and o.to_user_id = a)
       and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'envelope_declined')
       and not exists (select 1 from public.audit_events x where x.envelope_id = e6 and x.payload::text like '%Wrong price%')
    then res := res || E'PASS T89 AT2.1: a decline stops the document for everyone at once: links revoked, the next person skipped, the sender told, nothing sealed\n';
    else res := res || 'FAIL T89 decline :: open=' || cnt || ' n=' || n || E'\n'; end if;

    update public.account_controls set approved = false, daily_recipient_cap = 5, daily_envelope_cap = 3 where user_id = a;
  end;

  -- ---------- void, send again, correct a recipient (migration 11: AT2.2, AT2.3), as the service role ----------
  declare
    d7 uuid; d8 uuid; e9 uuid; d9 uuid; r9 uuid; exp timestamptz := now() + interval '30 days'; cnt int; st text; st2 text; row7 record; code8 text;
    v1 uuid; v2 uuid; v3 uuid; c1 uuid; c2 uuid; c3 uuid;
    t_v1 uuid := gen_random_uuid(); t_v2 uuid := gen_random_uuid(); t_v3 uuid := gen_random_uuid();
    t_c1 uuid := gen_random_uuid(); t_c2 uuid := gen_random_uuid(); t_c3 uuid := gen_random_uuid(); t_c2new uuid := gen_random_uuid(); t_r9 uuid := gen_random_uuid();
    h_v1 text := repeat('c1', 32); h_v2 text := repeat('c2', 32); h_v3 text := repeat('c3', 32);
    h_c1 text := repeat('c4', 32); h_c2 text := repeat('c5', 32); h_c3 text := repeat('c6', 32); h_c2new text := repeat('c7', 32); h_r9 text := repeat('c8', 32);
    newtok jsonb;
  begin
    update public.account_controls set approved = true, daily_recipient_cap = 50, daily_envelope_cap = 50 where user_id = a;

    -- e7: two signers together, then a third; requests go by email
    select e.id into e7 from public.create_envelope(a, org_a, 'Void test', folder_a) e;
    select d.id into d7 from public.add_envelope_document(a, e7, 'f.pdf', 'supabase', org_a || '/' || e7 || '/d1', repeat('ad', 32), 1, 900, '[]', 'pdf') d;
    perform public.save_recipients(a, e7, '[{"name":"V One","email":"v1@example.test","role":"signer","routing_order":1},{"name":"V Two","email":"v2@example.test","role":"signer","routing_order":1},{"name":"V Three","email":"v3@example.test","role":"signer","routing_order":2}]');
    select x.id into v1 from public.recipients x where x.envelope_id = e7 and x.email = 'v1@example.test';
    select x.id into v2 from public.recipients x where x.envelope_id = e7 and x.email = 'v2@example.test';
    select x.id into v3 from public.recipients x where x.envelope_id = e7 and x.email = 'v3@example.test';
    perform public.save_fields(a, e7, jsonb_build_array(
      jsonb_build_object('document_id', d7, 'recipient_id', v1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d7, 'recipient_id', v2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.6, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d7, 'recipient_id', v3, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.7, 'w', 0.3, 'h', 0.07)));
    perform public.set_routing_mode(a, e7, 'mixed');
    perform public.send_envelope(a, e7, jsonb_build_array(
      jsonb_build_object('recipient_id', v1, 'token_id', t_v1, 'nonce', repeat('11', 16), 'token_sha256', h_v1),
      jsonb_build_object('recipient_id', v2, 'token_id', t_v2, 'nonce', repeat('12', 16), 'token_sha256', h_v2),
      jsonb_build_object('recipient_id', v3, 'token_id', t_v3, 'nonce', repeat('13', 16), 'token_sha256', h_v3)), exp, 'email');
    perform public.signer_open(h_v1, '203.0.113.9', 'ua');
    perform public.signer_consent(t_v1, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_v1, 'signature', 'drawn', 'supabase', org_a || '/' || e7 || '/sig-v1.png', repeat('6a', 32), null, null, '203.0.113.9', 'ua');
    perform public.signer_complete(t_v1, repeat('d1', 32), d_today, '203.0.113.9', 'ua');

    n := 0;
    begin perform public.void_envelope(b, e7, 'not mine'); n := n + 1; exception when insufficient_privilege then null; end;
    perform public.void_envelope(a, e7, '  Sent by mistake  ');
    select count(*) into cnt from public.signer_open(h_v2, '203.0.113.9', 'ua');
    if n = 0 and cnt = 0
       and (select e.status || '|' || coalesce(e.void_reason, '') || '|' || (e.voided_at is not null)::text from public.envelopes e where e.id = e7) = 'voided|Sent by mistake|true'
       and (select count(*) from public.recipient_tokens k where k.envelope_id = e7 and k.revoked_at is null) = 0
       and (select count(distinct k.revoked_at) from public.recipient_tokens k where k.envelope_id = e7) = 1
       and (select string_agg(x.status, ',' order by x.email) from public.recipients x where x.envelope_id = e7) = 'signed,skipped,skipped'
       and not exists (select 1 from public.seal_jobs j where j.envelope_id = e7)
       and not exists (select 1 from public.notification_outbox o where o.envelope_id = e7 and o.kind = 'signature_request' and o.status in ('queued', 'deferred'))
       and (select count(*) from public.notification_outbox o where o.envelope_id = e7 and o.kind = 'voided_notice' and o.recipient_id in (v1, v2)) = 2
       and not exists (select 1 from public.notification_outbox o where o.envelope_id = e7 and o.recipient_id = v3)
       and exists (select 1 from public.audit_events x where x.envelope_id = e7 and x.event_type = 'envelope_voided' and x.actor_id = a and (x.payload ->> 'links_revoked')::int = 3)
       and not exists (select 1 from public.audit_events x where x.envelope_id = e7 and x.payload::text like '%mistake%')
    then res := res || E'PASS T91 AT2.2: void revokes every link at the same instant, skips whoever was waiting, cancels unsent requests, tells the people already contacted; a non-member cannot void\n';
    else res := res || 'FAIL T91 void :: n=' || n || ' open=' || cnt || E'\n'; end if;

    n := 0;
    begin perform public.void_envelope(a, e7, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.void_envelope(a, e5, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.void_envelope(a, e6, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.signer_consent(t_v2, 'v1', repeat('c1', 32), null, null); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.resend_request(a, e7, v2); n := n + 1; exception when insufficient_privilege then null; end;
    begin perform public.correct_recipient(a, e7, v2, 'New', 'new@example.test', null); n := n + 1; exception when insufficient_privilege then null; end;
    begin update public.envelopes set status = 'sent' where id = e7; n := n + 1; exception when insufficient_privilege then null; end;
    begin update public.envelopes set status = 'voided' where id = e5; n := n + 1; exception when insufficient_privilege then null; end;
    if n = 0 and (select e.status from public.envelopes e where e.id = e5) = 'completed'
    then res := res || E'PASS T92 AT2.2: a voided, completed or declined document cannot be voided, changed or reopened\n';
    else res := res || 'FAIL T92 terminal states :: ' || n || E'\n'; end if;

    -- e8: three signers one after another, by email. The second has started when their address is corrected.
    select e.id, e.public_code into e8, code8 from public.create_envelope(a, org_a, 'Correct test', folder_a) e;
    select d.id into d8 from public.add_envelope_document(a, e8, 'f.pdf', 'supabase', org_a || '/' || e8 || '/d1', repeat('ae', 32), 1, 900, '[]', 'pdf') d;
    perform public.save_recipients(a, e8, '[{"name":"C One","email":"c1@example.test","role":"signer","routing_order":1},{"name":"C Two","email":"c2@example.test","role":"signer","routing_order":2},{"name":"C Three","email":"c3@example.test","role":"signer","routing_order":3}]');
    select x.id into c1 from public.recipients x where x.envelope_id = e8 and x.email = 'c1@example.test';
    select x.id into c2 from public.recipients x where x.envelope_id = e8 and x.email = 'c2@example.test';
    select x.id into c3 from public.recipients x where x.envelope_id = e8 and x.email = 'c3@example.test';
    perform public.save_fields(a, e8, jsonb_build_array(
      jsonb_build_object('document_id', d8, 'recipient_id', c1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d8, 'recipient_id', c2, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.6, 'w', 0.3, 'h', 0.07),
      jsonb_build_object('document_id', d8, 'recipient_id', c3, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.7, 'w', 0.3, 'h', 0.07)));
    perform public.send_envelope(a, e8, jsonb_build_array(
      jsonb_build_object('recipient_id', c1, 'token_id', t_c1, 'nonce', repeat('14', 16), 'token_sha256', h_c1),
      jsonb_build_object('recipient_id', c2, 'token_id', t_c2, 'nonce', repeat('15', 16), 'token_sha256', h_c2),
      jsonb_build_object('recipient_id', c3, 'token_id', t_c3, 'nonce', repeat('16', 16), 'token_sha256', h_c3)), exp, 'email');
    perform public.signer_open(h_c1, '203.0.113.9', 'ua');
    perform public.signer_consent(t_c1, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_c1, 'signature', 'drawn', 'supabase', org_a || '/' || e8 || '/sig-c1.png', repeat('6b', 32), null, null, '203.0.113.9', 'ua');
    perform public.signer_complete(t_c1, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
    perform public.signer_open(h_c2, '203.0.113.9', 'ua');
    perform public.signer_consent(t_c2, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_c2, 'signature', 'drawn', 'supabase', org_a || '/' || e8 || '/sig-c2-old.png', repeat('6c', 32), null, null, '203.0.113.9', 'ua');
    newtok := jsonb_build_object('token_id', t_c2new, 'nonce', repeat('17', 16), 'token_sha256', h_c2new);

    n := 0;
    begin perform public.correct_recipient(b, e8, c2, 'X', 'x@example.test', newtok); n := n + 1; exception when insufficient_privilege then null; end;                 -- not a member
    begin perform public.correct_recipient(a, e8, c1, 'X', 'new1@example.test', newtok); n := n + 1; exception when insufficient_privilege then null; end;             -- already signed
    begin perform public.correct_recipient(a, e8, c2, 'C Two', 'c3@example.test', newtok); n := n + 1; exception when invalid_parameter_value then null; end;          -- already on the document
    begin perform public.correct_recipient(a, e8, c2, 'C Two', 'not-an-email', newtok); n := n + 1; exception when invalid_parameter_value then null; end;
    begin perform public.correct_recipient(a, e8, c2, 'C Two', 'c2new@example.test', null); n := n + 1; exception when invalid_parameter_value then null; end;         -- no new link record
    st := public.correct_recipient(a, e8, c2, ' C Two Corrected ', 'C2New@Example.test', newtok);
    select count(*) into cnt from public.signer_open(h_c2, '203.0.113.9', 'ua');
    select * into row7 from public.signer_open(h_c2new, '203.0.113.9', 'ua');
    if n = 0 and st = 'email_changed' and cnt = 0 and row7.turn = 'now' and row7.recipient_status = 'viewed'
       and (select x.name || '|' || x.email || '|' || (x.consented_at is null)::text from public.recipients x where x.id = c2) = 'C Two Corrected|c2new@example.test|true'
       and (select k.revoked_at is not null from public.recipient_tokens k where k.id = t_c2)
       and exists (select 1 from public.recipient_tokens k where k.id = t_c2new and k.recipient_id = c2 and k.revoked_at is null and k.token_sha256 = decode(h_c2new, 'hex'))
       and not exists (select 1 from public.consents q where q.recipient_id = c2 and q.withdrawn_at is null)
       and exists (select 1 from public.consents q where q.recipient_id = c2 and q.withdrawn_at is not null)
       and not exists (select 1 from public.signature_assets s where s.recipient_id = c2)
       and (select o.status from public.notification_outbox o where o.idempotency_key = 'request:' || c2 || ':1') = 'dead'
       and (select o.status || '|' || o.priority from public.notification_outbox o where o.idempotency_key = 'request:' || c2 || ':2') = 'queued|P0_REQUEST'
       and exists (select 1 from public.audit_events x where x.envelope_id = e8 and x.recipient_id = c2 and x.event_type = 'recipient_corrected' and x.actor_id = a
                     and (x.payload ->> 'link_reissued')::boolean and (x.payload ->> 'progress_reset')::boolean)
       and not exists (select 1 from public.audit_events x where x.envelope_id = e8 and x.payload::text like '%c2new%')
       -- earlier and later people are untouched
       and (select x.status from public.recipients x where x.id = c1) = 'signed'
       and (select k.revoked_at is null from public.recipient_tokens k where k.id = t_c1)
       and (select v2.signature_id from public.field_values v2 join public.fields f on f.id = v2.field_id where f.recipient_id = c1) = code8 || '-S1'
       and (select x.status from public.recipients x where x.id = c3) = 'created'
       and (select k.revoked_at is null from public.recipient_tokens k where k.id = t_c3)
    then res := res || E'PASS T93 AT2.3: correcting an email revokes the old link, issues a new one, undoes what the old address had started, re-sends the request, records it, and leaves everyone else untouched\n';
    else res := res || 'FAIL T93 correct :: n=' || n || ' st=' || coalesce(st, 'null') || ' old=' || cnt || ' turn=' || coalesce(row7.turn, 'null') || E'\n'; end if;

    perform public.signer_consent(t_c2new, 'v1', repeat('c1', 32), '203.0.113.9', 'ua');
    perform public.signer_adopt_signature(t_c2new, 'signature', 'drawn', 'supabase', org_a || '/' || e8 || '/sig-c2-new.png', repeat('6d', 32), null, null, '203.0.113.9', 'ua');
    st := public.signer_complete(t_c2new, repeat('d1', 32), d_today, '203.0.113.9', 'ua');
    st2 := public.correct_recipient(a, e8, c3, 'C Three Renamed', 'c3@example.test', null);
    if st = 'waiting' and st2 = 'name_changed' and public.correct_recipient(a, e8, c3, 'C Three Renamed', 'c3@example.test', null) = 'unchanged'
       and (select v2.signature_id from public.field_values v2 join public.fields f on f.id = v2.field_id where f.recipient_id = c2) = code8 || '-S2'
       and (select x.name || '|' || x.status from public.recipients x where x.id = c3) = 'C Three Renamed|sent'
       and (select count(*) from public.recipient_tokens k where k.recipient_id = c3) = 1
       and (select k.revoked_at is null from public.recipient_tokens k where k.id = t_c3)
    then res := res || E'PASS T94 AT2.3: the corrected person signs with the new link; a name-only correction keeps the same link\n';
    else res := res || 'FAIL T94 :: ' || coalesce(st, 'null') || ' ' || coalesce(st2, 'null') || E'\n'; end if;

    n := 0;
    begin perform public.resend_request(a, e8, c3); n := n + 1; exception when configuration_limit_exceeded then null; end;   -- asked a moment ago
    begin perform public.resend_request(a, e8, c1); n := n + 1; exception when invalid_parameter_value then null; end;       -- already signed
    begin perform public.resend_request(b, e8, c3); n := n + 1; exception when insufficient_privilege then null; end;        -- not a member
    update public.notification_outbox set created_at = now() - interval '1 hour' where recipient_id = c3;
    perform public.resend_request(a, e8, c3);
    if n = 0 and (select o.priority || '|' || o.kind || '|' || o.status from public.notification_outbox o where o.idempotency_key = 'request:' || c3 || ':2') = 'P1|signature_request|queued'
       and exists (select 1 from public.audit_events x where x.envelope_id = e8 and x.recipient_id = c3 and x.event_type = 'request_resent' and x.actor_id = a)
       and (select count(*) from public.recipient_tokens k where k.recipient_id = c3 and k.revoked_at is null) = 1
    then res := res || E'PASS T95 a request can be sent again to someone whose turn it is, with the same link, but not within ten minutes, not to someone who finished, and not by an outsider\n';
    else res := res || 'FAIL T95 resend :: ' || n || E'\n'; end if;

    -- correcting a recipient must not be a way round approval mode
    update public.account_controls set approved = false where user_id = a;
    select e.id into e9 from public.create_envelope(a, org_a, 'Self then external', folder_a) e;
    select d.id into d9 from public.add_envelope_document(a, e9, 'f.pdf', 'supabase', org_a || '/' || e9 || '/d1', repeat('af', 32), 1, 900, '[]', 'pdf') d;
    select x.id into r9 from public.save_recipients(a, e9, '[{"name":"Alice Test","email":"rls-a@example.test","role":"signer","routing_order":1,"is_sender":true}]') x limit 1;
    perform public.save_fields(a, e9, jsonb_build_array(jsonb_build_object('document_id', d9, 'recipient_id', r9, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07)));
    perform public.send_envelope(a, e9, jsonb_build_array(jsonb_build_object('recipient_id', r9, 'token_id', t_r9, 'nonce', repeat('18', 16), 'token_sha256', h_r9)), exp, 'link');
    n := 0;
    begin perform public.correct_recipient(a, e9, r9, 'Outside Person', 'outside@example.test', jsonb_build_object('token_id', gen_random_uuid(), 'nonce', repeat('19', 16), 'token_sha256', repeat('c9', 32))); n := n + 1;
    exception when insufficient_privilege then null; end;
    if n = 0 and (select e.self_sign from public.envelopes e where e.id = e9) and (select x.email from public.recipients x where x.id = r9) = 'rls-a@example.test'
    then res := res || E'PASS T96 AT1.3: an unapproved account cannot turn a self-signed document into one for someone else by correcting the recipient\n';
    else res := res || 'FAIL T96 approval bypass :: ' || n || E'\n'; end if;

    update public.account_controls set approved = false, daily_recipient_cap = 5, daily_envelope_cap = 3 where user_id = a;
  end;

  -- ---------- storage immutability and freezing (migration role) ----------
  execute 'reset role';
  begin update storage.objects set metadata = '{"size":2}', version = 'v2' where bucket_id = 'originals' and name = obj_path;
    res := res || E'FAIL T26 original overwritten\n';
  exception when insufficient_privilege then res := res || E'PASS T26 an original cannot be overwritten (AT1.10)\n'; end;

  perform app_private.sanction();
  update public.envelopes set status = 'sent', sent_at = now() where id = env_a;
  perform set_config('easysign.sanctioned', '', true);

  begin delete from storage.objects where bucket_id = 'originals' and name = obj_path;
    res := res || E'FAIL T27 original of a sent envelope deleted\n';
  exception when insufficient_privilege then res := res || E'PASS T27 the original of a sent envelope cannot be deleted\n'; end;

  n := 0;
  begin update public.fields set x = 0.5 where envelope_id = env_a; n := n + 1; exception when insufficient_privilege then null; end;
  begin delete from public.recipients where envelope_id = env_a; n := n + 1; exception when insufficient_privilege then null; end;
  begin update public.envelope_documents set sha256 = repeat('cd', 32) where envelope_id = env_a; n := n + 1; exception when insufficient_privilege then null; end;
  begin update public.envelopes set title = 'changed after send' where id = env_a; n := n + 1; exception when insufficient_privilege then null; end;
  begin delete from public.envelopes where id = env_a; n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T28 after send: fields, recipients, document, title are frozen and the envelope cannot be deleted\n'; else res := res || 'FAIL T28 freeze :: ' || n || E' change(s) got through\n'; end if;

  begin perform app_private.sanction(); update public.envelopes set status = 'completed' where id = env_a;
    res := res || E'FAIL T29 envelope completed without a sealed file\n';
  exception when check_violation then res := res || E'PASS T29 an envelope cannot be marked completed without a sealed file and hashes\n'; end;
  perform set_config('easysign.sanctioned', '', true);

  n := 0;
  begin perform public.save_fields(a, env_a, '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.save_recipients(a, env_a, '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.update_envelope_draft(a, env_a, 'new title', '', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.delete_draft_envelope(a, env_a); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T51 once sent, the owner cannot edit fields, recipients or details, or delete the envelope\n'; else res := res || 'FAIL T51 :: ' || n || E' edit(s) got through after send\n'; end if;

  select * into v from app_private.audit_verify('env:' || e4);
  if v.ok and v.events >= 12 then res := res || 'PASS T73 AT1.9: the full send-sign-seal chain verifies end to end (' || v.events || E' events)\n';
  else res := res || 'FAIL T73 flow chain :: ' || coalesce(v.reason, '?') || ' events=' || v.events || E'\n'; end if;
  if (select v2.ok from app_private.audit_verify('env:' || e5) v2) and (select v2.ok from app_private.audit_verify('env:' || e6) v2)
  then res := res || E'PASS T90 the audit chains of the multi-recipient and the declined document verify\n';
  else res := res || E'FAIL T90 multi-recipient chains\n'; end if;
  if (select v2.ok from app_private.audit_verify('env:' || e7) v2) and (select v2.ok from app_private.audit_verify('env:' || e8) v2)
  then res := res || E'PASS T97 the audit chains of the voided and the corrected document verify\n';
  else res := res || E'FAIL T97 void/correct chains\n'; end if;

  begin
    perform app_private.sanction();
    update public.envelopes set title = 'changed after completion' where id = e4;
    res := res || E'FAIL T74 a completed envelope was modified\n';
  exception when insufficient_privilege then res := res || E'PASS T74 AT2.2: a completed envelope cannot be modified, even by a sanctioned function\n'; end;
  perform set_config('easysign.sanctioned', '', true);

  -- ---------- audit chain ----------
  perform app_private.audit_append('env:' || env_a, org_a, env_a, rcp_a, 'signer', null, 'link_opened', '{"n":1}', '203.0.113.7', 'test-agent');
  perform app_private.audit_append('env:' || env_a, org_a, env_a, rcp_a, 'signer', null, 'consent_given', '{"version":"v1"}', '2001:db8::1', 'test-agent');
  select * into v from app_private.audit_verify('env:' || env_a);
  if v.ok and v.events = 3 then res := res || E'PASS T30 untouched chain verifies (3 events, gapless)\n'; else res := res || 'FAIL T30 verify :: ' || coalesce(v.reason, '?') || ' events=' || v.events || E'\n'; end if;

  begin update public.audit_events set payload = '{"n":2}' where chain_key = 'env:' || env_a and chain_seq = 2;
    res := res || E'FAIL T31 audit row updated by the database owner with triggers on\n';
  exception when insufficient_privilege then res := res || E'PASS T31 even the database owner is stopped by the append-only trigger\n'; end;

  -- AT1.9: a determined owner disables the trigger and edits a row; the verifier must catch it
  alter table public.audit_events disable trigger audit_no_update_delete;
  update public.audit_events set payload = '{"n":2}' where chain_key = 'env:' || env_a and chain_seq = 2;
  select * into v from app_private.audit_verify('env:' || env_a);
  if not v.ok and v.broken_seq = 2 then res := res || E'PASS T32 tampered payload detected at event 2 (column no longer matches hashed text)\n'; else res := res || E'FAIL T32 tamper not detected\n'; end if;

  update public.audit_events set payload = '{"n":1}', canonical = replace(canonical, 'link_opened', 'recipient_signed'), event_type = 'recipient_signed' where chain_key = 'env:' || env_a and chain_seq = 2;
  select * into v from app_private.audit_verify('env:' || env_a);
  if not v.ok and v.broken_seq = 2 and v.reason like '%hash%' then res := res || E'PASS T33 rewritten event text detected (hash mismatch)\n'; else res := res || E'FAIL T33 rewrite not detected\n'; end if;

  delete from public.audit_events where chain_key = 'env:' || env_a and chain_seq = 2;
  select * into v from app_private.audit_verify('env:' || env_a);
  if not v.ok and v.reason like '%sequence%' then res := res || E'PASS T34 deleted event detected (sequence gap)\n'; else res := res || E'FAIL T34 deletion not detected\n'; end if;
  alter table public.audit_events enable trigger audit_no_update_delete;

  -- ---------- public codes (AT1.8, database generator) ----------
  select count(*) as total, count(distinct c) as uniq, count(*) filter (where c !~ '^ES-[0-9]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}-[0-9A-HJKMNP-TV-Z]{2}$') as bad
    into v from (select app_private.gen_public_code() c from generate_series(1, 100000)) s;
  if v.total = 100000 and v.uniq = 100000 and v.bad = 0 then res := res || E'PASS T35 100,000 database-generated codes: all well-formed, zero collisions\n';
  else res := res || 'FAIL T35 codes :: total=' || v.total || ' unique=' || v.uniq || ' malformed=' || v.bad || E'\n'; end if;

  -- ---------- bootstrap administrator (migration 5) ----------
  declare
    c uuid := gen_random_uuid();
  begin
    update public.platform_settings set value = '"rls-admin@example.test"' where key = 'bootstrap_admin_email';
    if not found then insert into public.platform_settings (key, value) values ('bootstrap_admin_email', '"rls-admin@example.test"'); end if;
    insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'RLS-Admin@example.test', null, '{"provider":"email"}', '{}', now(), now());
    if exists (select 1 from public.account_controls k where k.user_id = c and (k.is_platform_admin or k.approved)) then
      res := res || E'FAIL T37 admin rights granted before the email was confirmed\n';
    else
      update auth.users set email_confirmed_at = now() where id = c;
      update auth.users set email_confirmed_at = now() where id = a; -- an ordinary user confirming must gain nothing
      if exists (select 1 from public.account_controls k where k.user_id = c and k.is_platform_admin and k.approved and k.trust_level = 'trusted')
         and not exists (select 1 from public.account_controls k where k.user_id = a and (k.is_platform_admin or k.approved))
      then res := res || E'PASS T37 the named administrator is promoted only once their email is confirmed; other users gain nothing\n';
      else res := res || E'FAIL T37 bootstrap admin promotion\n'; end if;
    end if;
  end;

  -- ---------- rate limiter (migration 5) ----------
  execute 'set local role service_role';
  n := 0;
  for i in 1..5 loop
    if public.rate_limit_hit('test_bucket', 'key-1', 3, 3600) then n := n + 1; end if;
  end loop;
  if n = 3 and public.rate_limit_hit('test_bucket', 'key-2', 3, 3600) then res := res || E'PASS T38 rate limiter allows 3 of 5 calls for one key and keeps other keys separate\n';
  else res := res || 'FAIL T38 rate limiter :: allowed ' || n || E'\n'; end if;
  execute 'set local role authenticated';
  begin perform public.rate_limit_hit('test_bucket', 'key-1', 3, 3600);
    res := res || E'FAIL T39 a signed-in user called the rate limiter\n';
  exception when insufficient_privilege then res := res || E'PASS T39 the rate limiter is server-only\n'; end;
  execute 'reset role';
  if exists (select 1 from public.rate_limits r where r.bucket = 'test_bucket' and position('key-1' in encode(r.key_hash, 'escape')) > 0)
  then res := res || E'FAIL T40 rate-limit key stored in clear\n';
  else res := res || E'PASS T40 rate-limit keys are stored only as hashes\n'; end if;

  -- ---------- administrator approval and download events (migration 9) ----------
  update public.account_controls set approved = false where user_id = b;
  n := 0;
  begin perform public.admin_list_accounts(a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.admin_set_approval(a, b, true); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 and not exists (select 1 from public.account_controls k where k.user_id = b and k.approved)
  then res := res || E'PASS T79 someone who is not an administrator can neither list accounts nor approve one\n';
  else res := res || 'FAIL T79 non-admin :: ' || n || E'\n'; end if;

  update public.account_controls set is_platform_admin = true where user_id = a;
  perform public.admin_set_approval(a, b, true);
  perform public.admin_set_approval(a, b, true); -- repeating it changes nothing
  select count(*) into n from public.audit_events x where x.chain_key = 'org:' || org_b and x.event_type = 'account_approved' and x.actor_id = a;
  if n = 1 and exists (select 1 from public.account_controls k where k.user_id = b and k.approved)
     and exists (select 1 from public.registration_requests q where q.user_id = b and q.status = 'approved' and q.decided_by = a)
     and (select count(*) from public.admin_list_accounts(a) l where l.account_id in (a, b)) = 2
  then res := res || E'PASS T80 an administrator approves an account once; who decided is recorded, and it is in that workspace''s audit trail\n';
  else res := res || 'FAIL T80 approve :: events=' || n || E'\n'; end if;

  n := 0;
  begin perform public.admin_set_approval(a, a, false); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.admin_set_approval(a, b, false);
  if n = 0 and not exists (select 1 from public.account_controls k where k.user_id = b and k.approved)
     and exists (select 1 from public.registration_requests q where q.user_id = b and q.status = 'rejected')
  then res := res || E'PASS T81 approval can be taken away again, but not from an administrator account\n';
  else res := res || 'FAIL T81 un-approve :: ' || n || E'\n'; end if;

  n := 0;
  begin perform public.record_download(b, null, e4, 'sealed', null, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.record_download(a, null, env_a, 'sealed', null, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.record_download(null, gen_random_uuid(), e4, 'sealed', null, null); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.record_download(a, null, e4, 'sealed', '203.0.113.9', 'ua');
  perform public.record_download(null, (select k.id from public.recipient_tokens k where k.envelope_id = e4 limit 1), e4, 'certificate', '203.0.113.9', 'ua');
  if n = 0 and (select count(*) from public.audit_events x where x.envelope_id = e4 and x.event_type = 'document_downloaded') = 2
     and (select v2.ok from app_private.audit_verify('env:' || e4) v2)
  then res := res || E'PASS T82 downloads of the completed file are recorded for members and signers; outsiders, unfinished documents and made-up links are refused\n';
  else res := res || 'FAIL T82 downloads :: ' || n || E'\n'; end if;
  update public.account_controls set is_platform_admin = false where user_id = a;

  -- five sample codes for the Node cross-check (same check algorithm on both sides)
  select string_agg(app_private.gen_public_code(), ',') into t from generate_series(1, 5);
  res := res || 'INFO sample codes: ' || t || E'\n';

  raise exception E'RLS_TEST_RESULTS\n%', res;
end
$test$;
