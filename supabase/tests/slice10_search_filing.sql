-- EasySign SQL tests for Phase 2 slice 10 (migration 18): search and filters, moving between folders, filing rules,
-- and search speed on 10,000 documents (AT2.8 filing, AT2.12 search). Self-contained; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();   -- member of workspace A
  b uuid := gen_random_uuid();   -- another workspace
  org_a uuid; org_b uuid; done_a uuid; leases uuid; e1 uuid; e2 uuid; e3 uuid; d1 uuid; s1 uuid; rule uuid;
  t1 uuid := gen_random_uuid(); h1 text := repeat('b7', 32);
  n int; cnt int; st text; job record; r record; t0 timestamptz; ms numeric; worst numeric := 0; i int; q text;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's10-a@example.test', now(), '{"provider":"email"}', '{"full_name":"Ann Alpha"}', now(), now()),
         (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's10-b@example.test', now(), '{"provider":"email"}', '{"full_name":"Bob Beta"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  select m.org_id into org_b from public.memberships m where m.user_id = b and m.role = 'owner';
  select f.id into done_a from public.folders f where f.org_id = org_a;               -- the default "Completed" folder
  insert into public.folders (org_id, name, created_by) values (org_a, 'Leases', a) returning id into leases;
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;

  execute 'set local role service_role';
  select e.id into e1 from public.create_envelope(a, org_a, 'Lease 2027 Main Street', done_a) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'f.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('d4', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Quincy Tenant","email":"quincy.tenant@example.test","role":"signer","routing_order":1}]');
  select x.id into s1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(jsonb_build_object('document_id', d1, 'recipient_id', s1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.07)));
  select e.id into e2 from public.create_envelope(a, org_a, 'Board minutes', done_a) e;
  select e.id into e3 from public.create_envelope(b, org_b, 'Lease for Bob', null) e;

  -- T301: filing rule; only members; checks
  n := 0;
  begin perform public.set_filing_rule(b, org_a, leases, 'lease', 0); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_filing_rule(a, org_a, leases, 'x', 0); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_filing_rule(a, org_a, (select f.id from public.folders f where f.org_id = org_b limit 1), 'lease', 0); n := n + 1; exception when insufficient_privilege then null; end;
  rule := public.set_filing_rule(a, org_a, leases, '  LEASE ', 0);
  if n = 0 and (select x.title_contains || '|' || (x.folder_id = leases)::text from public.filing_rules x where x.id = rule) = 'LEASE|true'
     and (select count(*) from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'filing_rule_added') = 1
  then res := res || E'PASS T301 only a member can add a filing rule, into one of their own folders, with 2 to 100 characters to look for; it is in the audit trail\n';
  else res := res || 'FAIL T301 rule :: ' || n || E'\n'; end if;

  -- T302 AT2.8: completing a document files it by the rule; others keep their folder
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', s1, 'token_id', t1, 'nonce', repeat('61', 16), 'token_sha256', h1)), now() + interval '30 days', 'link');
  perform public.signer_open(h1, null, 'ua');
  perform public.signer_consent(t1, 'v1', repeat('c1', 32), null, 'ua');
  perform public.signer_adopt_signature(t1, 'signature', 'drawn', 'supabase', org_a || '/' || e1 || '/sig.png', repeat('8a', 32), null, null, null, 'ua');
  perform public.signer_complete(t1, repeat('d1', 32), to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD'), null, 'ua');
  for i in 1..30 loop
    select * into job from public.claim_seal_job(300);
    exit when job.envelope_id = e1 or job.envelope_id is null;
  end loop;
  if job.envelope_id = e1 then
    perform public.complete_seal_job(e1, job.attempt_id, repeat('e1', 32), repeat('e2', 32), 'supabase', org_a || '/' || e1 || '/sealed.pdf', org_a || '/' || e1 || '/cert.pdf', job.audit_seq, job.audit_hash);
  end if;
  if (select e.status || '|' || (e.folder_id = leases)::text from public.envelopes e where e.id = e1) = 'completed|true'
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'envelope_filed') = 1
     and (select e.folder_id from public.envelopes e where e.id = e2) = done_a
     and (select e.folder_id from public.envelopes e where e.id = e3) is null
  then res := res || E'PASS T302 AT2.8: when a document is completed, a rule whose words are in its title files it into that folder (recorded); other documents keep their folder\n';
  else res := res || 'FAIL T302 filing :: ' || coalesce((select e.status || ' ' || coalesce(e.folder_id::text, 'none') from public.envelopes e where e.id = e1), '?') || E'\n'; end if;

  -- T303: moving a document; completed documents can still be moved; nobody else can
  n := 0;
  begin perform public.move_to_folder(b, e1, null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.move_to_folder(a, e1, (select f.id from public.folders f where f.org_id = org_b limit 1)); n := n + 1; exception when insufficient_privilege then null; end;
  -- each call on its own line: a function's changes are not visible to other parts of the statement that calls it
  st := public.move_to_folder(a, e1, done_a)::text;
  st := st || '|' || public.move_to_folder(a, e1, done_a)::text;
  if n = 0 and st = 'true|false'
     and (select e.folder_id from public.envelopes e where e.id = e1) = done_a
     and (select count(*) from public.audit_events x where x.envelope_id = e1 and x.event_type = 'envelope_moved') = 1
  then res := res || E'PASS T303 a member can move a document, even a completed one, to another of the workspace''s folders; outsiders and other workspaces'' folders are refused\n';
  else res := res || 'FAIL T303 move :: ' || n || E'\n'; end if;

  -- T304: search and filters
  n := 0;
  if (select count(*) from public.search_envelopes(a, 'lease', 'all', null, 50, 0)) <> 1 then n := n + 1; end if;                -- not Bob's lease
  if (select count(*) from public.search_envelopes(a, 'QUINCY', 'all', null, 50, 0)) <> 1 then n := n + 1; end if;               -- a person's name
  if (select count(*) from public.search_envelopes(a, 'tenant@example', 'all', null, 50, 0)) <> 1 then n := n + 1; end if;       -- an email
  if (select count(*) from public.search_envelopes(a, (select right(e.public_code, 7) from public.envelopes e where e.id = e2), 'all', null, 50, 0)) <> 1 then n := n + 1; end if;
  if (select count(*) from public.search_envelopes(a, '%', 'all', null, 50, 0)) <> 0 then n := n + 1; end if;                    -- a wildcard is just a character
  if (select count(*) from public.search_envelopes(a, '', 'completed', null, 50, 0)) <> 1 then n := n + 1; end if;
  if (select count(*) from public.search_envelopes(a, '', 'draft', null, 50, 0)) <> 1 then n := n + 1; end if;
  if (select count(*) from public.search_envelopes(a, '', 'all', leases, 50, 0)) <> 0 then n := n + 1; end if;
  if (select count(*) from public.search_envelopes(a, '', 'all', done_a, 50, 0)) <> 2 then n := n + 1; end if;
  if (select string_agg(x.people, ',') from public.search_envelopes(a, 'lease', 'all', null, 50, 0) x) <> 'Quincy Tenant' then n := n + 1; end if;
  if (select max(x.total_count) from public.search_envelopes(a, '', 'all', null, 1, 0) x) <> 2 then n := n + 1; end if;
  if (select count(*) from public.search_envelopes(b, 'board', 'all', null, 50, 0)) <> 0 then n := n + 1; end if;
  begin perform public.search_envelopes(a, '', 'everything', null, 50, 0); n := n + 1; exception when invalid_parameter_value then null; end;
  if n = 0 then res := res || E'PASS T304 search finds a document by title, code, person or email, only in the user''s own workspaces; filters by state and folder; wildcards are taken literally\n';
  else res := res || 'FAIL T304 search :: ' || n || E'\n'; end if;

  -- T305 AT2.12: search over 10,000 documents answers in under 300 ms
  execute 'reset role';
  insert into public.envelopes (org_id, sender_id, folder_id, public_code, title, status)
    select org_a, a, case when g % 3 = 0 then leases else done_a end, app_private.gen_public_code(), 'Seeded agreement ' || g || ' ' || md5(g::text), 'draft'
      from generate_series(1, 10000) g;
  insert into public.recipients (org_id, envelope_id, name, email, role, routing_order)
    select e.org_id, e.id, 'Person ' || left(md5(e.id::text), 8), 'p' || left(md5(e.id::text), 10) || '@example.test', 'signer', 1
      from public.envelopes e where e.org_id = org_a and e.title like 'Seeded agreement %';
  analyze public.envelopes;
  analyze public.recipients;
  execute 'set local role service_role';
  foreach q in array array['', 'agreement 4242', 'zzz-nothing-matches', 'person', '@example.test'] loop
    t0 := clock_timestamp();
    perform * from public.search_envelopes(a, q, 'all', null, 50, 0);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    worst := greatest(worst, ms);
  end loop;
  t0 := clock_timestamp();
  perform * from public.search_envelopes(a, 'agreement', 'all', leases, 50, 0);
  worst := greatest(worst, extract(epoch from clock_timestamp() - t0) * 1000);
  select count(*) into cnt from public.envelopes e where e.org_id = org_a;
  if cnt >= 10000 and worst < 300 then res := res || 'PASS T305 AT2.12: search over ' || cnt || ' documents answers in under 300 ms (slowest of six searches ' || round(worst) || E' ms)\n';
  else res := res || 'FAIL T305 search speed :: ' || cnt || ' documents, slowest ' || round(worst) || E' ms\n'; end if;

  -- T306: server-only; rules readable by members only
  n := 0;
  foreach q in array array['public.set_filing_rule(uuid, uuid, uuid, text, int)', 'public.delete_filing_rule(uuid, uuid)', 'public.move_to_folder(uuid, uuid, uuid)', 'public.search_envelopes(uuid, text, text, uuid, int, int)'] loop
    if has_function_privilege('authenticated', q, 'execute') or has_function_privilege('anon', q, 'execute') or not has_function_privilege('service_role', q, 'execute') then n := n + 1; end if;
  end loop;
  if has_function_privilege('service_role', 'app_private.file_on_complete()', 'execute') or has_table_privilege('authenticated', 'public.filing_rules', 'insert')
     or has_table_privilege('anon', 'public.filing_rules', 'select') then n := n + 1; end if;
  begin perform public.delete_filing_rule(b, rule); n := n + 1; exception when insufficient_privilege then null; end;
  st := public.delete_filing_rule(a, rule)::text;
  if st <> 'true' or exists (select 1 from public.filing_rules x where x.id = rule) then n := n + 1; end if;
  if n = 0 then res := res || E'PASS T306 the new functions are server-only; signed-in users cannot write filing rules directly; only a member removes a rule\n';
  else res := res || 'FAIL T306 privileges :: ' || n || E'\n'; end if;

  execute 'reset role';
  if (select v2.ok from app_private.audit_verify('env:' || e1) v2) and (select v2.ok from app_private.audit_verify('org:' || org_a) v2)
  then res := res || E'PASS T307 the audit chains of the filed and moved document and of the workspace verify\n';
  else res := res || E'FAIL T307 chains\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
