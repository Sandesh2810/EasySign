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

  -- five sample codes for the Node cross-check (same check algorithm on both sides)
  select string_agg(app_private.gen_public_code(), ',') into t from generate_series(1, 5);
  res := res || 'INFO sample codes: ' || t || E'\n';

  raise exception E'RLS_TEST_RESULTS\n%', res;
end
$test$;
