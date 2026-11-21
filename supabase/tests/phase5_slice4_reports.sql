-- YouNMeSign SQL tests for Phase 5 slice 4: reports (AT5.4, D-93). A seeded dataset with answers computed by hand.
-- Self-contained; one transaction; always rolled back.
--
-- Period: 2026-03-01 to 2026-03-31 (UTC, both days included). Workspace A: Ana (owner), Max (member), Vic (viewer).
-- Templates: Lease, NDA. Documents (sent -> outcome):
--   d1 Ana, Lease : sent 03-02 10:00, completed 03-03 10:00 (24 h)
--   d2 Ana, Lease : sent 03-05 09:00, completed 03-05 21:00 (12 h)
--   d3 Ana, none  : sent 03-10 08:00, declined 03-11 08:00
--   d4 Max, NDA   : sent 03-15 12:00, voided 03-16 12:00
--   d5 Max, none  : sent 02-20 12:00 (before), completed 03-01 00:00 exactly (counts; 8.5 days = 204 h)
--   d6 Max, NDA   : sent 03-20 00:00, expired 03-31 23:59:59 (counts)
--   d7 Ana, NDA   : sent 03-31 23:00 (counts), completed 04-01 00:00 (after: does not count)
--   d8 Ana, Lease : sent 02-01, still in progress (nothing)
--   d9 Ana        : a draft (nothing)
--   d10 Max, none : sent 04-01 00:00 exactly (after: nothing)
--   d11 Ana, none : declined 02-27 (before), touched again in March (nothing)
--   dx another workspace, sent 03-10 (never counted)
-- Workspace totals: sent 6 (d1 d2 d3 d4 d6 d7), completed 3 (d1 d2 d5), declined 1, voided 1, expired 1,
--   average hours to complete (24 + 12 + 204) / 3 = 80.0
-- By person: Ana sent 4, completed 2, declined 1, average 18.0; Max sent 2, completed 1, voided 1, expired 1, average 204.0
-- By template: Lease sent 2, completed 2, average 18.0; NDA sent 3, voided 1, expired 1, no average;
--   no template: sent 1, completed 1, declined 1, average 204.0
do $test$
declare
  res text := '';
  ana uuid := gen_random_uuid(); max_ uuid := gen_random_uuid(); vic uuid := gen_random_uuid(); oth uuid := gen_random_uuid();
  org_a uuid; org_o uuid; t_lease uuid := gen_random_uuid(); t_nda uuid := gen_random_uuid(); r_lease uuid := gen_random_uuid(); r_nda uuid := gen_random_uuid();
  d uuid[] := array[]::uuid[]; dx uuid; v uuid; n int; ok boolean; j jsonb; x jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (ana, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't55-ana@example.test', now(), '{"provider":"email"}', '{"full_name":"Ana Owner"}', now(), now()),
         (max_, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't55-max@example.test', now(), '{"provider":"email"}', '{"full_name":"Max Member"}', now(), now()),
         (vic, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't55-vic@example.test', now(), '{"provider":"email"}', '{"full_name":"Vic Viewer"}', now(), now()),
         (oth, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't55-oth@example.test', now(), '{"provider":"email"}', '{"full_name":"Oli Other"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = ana and m.role = 'owner';
  select m.org_id into org_o from public.memberships m where m.user_id = oth and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, max_, 'member'), (org_a, vic, 'viewer');
  insert into public.templates (id, org_id, created_by, name, filename, storage_backend, storage_path, sha256, page_count, size_bytes)
  values (t_lease, org_a, ana, 'Lease', 'l.pdf', 'supabase', org_a || '/tpl-' || t_lease || '/document.pdf', repeat('1', 64), 1, 100),
         (t_nda, org_a, ana, 'NDA', 'n.pdf', 'supabase', org_a || '/tpl-' || t_nda || '/document.pdf', repeat('2', 64), 1, 100);
  insert into public.template_roles (id, template_id, label, role, routing_order, position)
  values (r_lease, t_lease, 'Tenant', 'signer', 1, 0), (r_nda, t_nda, 'Party', 'signer', 1, 0);

  -- eleven documents in workspace A and one elsewhere, all made the normal way, then given their history
  for i in 1..11 loop
    select e.id into v from public.create_envelope(case when i in (4, 5, 6, 10) then max_ else ana end, org_a, 'Report doc ' || i, null) e;
    d := d || v;
  end loop;
  select e.id into dx from public.create_envelope(oth, org_o, 'Elsewhere', null) e;
  perform app_private.sanction();
  insert into public.recipients (org_id, envelope_id, name, email, role, routing_order, is_sender, template_role_id)
  select org_a, d[i], 'Person ' || i, 't55-p' || i || '@example.test', 'signer', 1, false,
         case when i in (1, 2, 8) then r_lease when i in (4, 6, 7) then r_nda end
    from generate_series(1, 11) i where i <> 9;
  update public.envelopes e set status = 'completed', final_sha256 = repeat('f', 64), sealed_at = now(), sealed_storage_path = 'x/sealed.pdf', audit_seal_hash = repeat('a', 64), sent_at = '2026-03-02 10:00Z', completed_at = '2026-03-03 10:00Z' where e.id = d[1];
  update public.envelopes e set status = 'completed', final_sha256 = repeat('f', 64), sealed_at = now(), sealed_storage_path = 'x/sealed.pdf', audit_seal_hash = repeat('a', 64), sent_at = '2026-03-05 09:00Z', completed_at = '2026-03-05 21:00Z' where e.id = d[2];
  update public.envelopes e set status = 'declined', sent_at = '2026-03-10 08:00Z' where e.id = d[3];
  update public.recipients r set status = 'declined', completed_at = '2026-03-11 08:00Z' where r.envelope_id = d[3];
  update public.envelopes e set status = 'voided', sent_at = '2026-03-15 12:00Z', voided_at = '2026-03-16 12:00Z' where e.id = d[4];
  update public.envelopes e set status = 'completed', final_sha256 = repeat('f', 64), sealed_at = now(), sealed_storage_path = 'x/sealed.pdf', audit_seal_hash = repeat('a', 64), sent_at = '2026-02-20 12:00Z', completed_at = '2026-03-01 00:00Z' where e.id = d[5];
  update public.envelopes e set status = 'expired', sent_at = '2026-03-20 00:00Z', expired_at = '2026-03-31 23:59:59Z' where e.id = d[6];
  update public.envelopes e set status = 'completed', final_sha256 = repeat('f', 64), sealed_at = now(), sealed_storage_path = 'x/sealed.pdf', audit_seal_hash = repeat('a', 64), sent_at = '2026-03-31 23:00Z', completed_at = '2026-04-01 00:00Z' where e.id = d[7];
  update public.envelopes e set status = 'in_progress', sent_at = '2026-02-01 00:00Z' where e.id = d[8];
  update public.envelopes e set status = 'sent', sent_at = '2026-04-01 00:00Z' where e.id = d[10];
  update public.envelopes e set status = 'declined', sent_at = '2026-02-25 00:00Z', updated_at = '2026-03-12 00:00Z' where e.id = d[11];
  update public.recipients r set status = 'declined', completed_at = '2026-02-27 00:00Z' where r.envelope_id = d[11];
  update public.envelopes e set status = 'completed', final_sha256 = repeat('f', 64), sealed_at = now(), sealed_storage_path = 'x/sealed.pdf', audit_seal_hash = repeat('a', 64), sent_at = '2026-03-10 00:00Z', completed_at = '2026-03-11 00:00Z' where e.id = dx;
  perform set_config('easysign.sanctioned', '', true);
  execute 'set local role service_role';

  -- T751: workspace totals match the hand-computed answers
  j := public.report_summary(ana, org_a, '2026-03-01', '2026-03-31');
  ok := j ->> 'scope' = 'workspace' and j -> 'totals' = '{"sent": 6, "completed": 3, "declined": 1, "voided": 1, "expired": 1, "avg_hours_to_complete": 80.0}'::jsonb;
  if ok then res := res || E'PASS T751 workspace totals for a period match the hand-computed answers (6 sent, 3 completed, 1 declined, 1 voided, 1 expired, 80.0 hours)\n';
  else res := res || 'FAIL T751 totals :: ' || (j -> 'totals')::text || E'\n'; end if;

  -- T752: by person
  ok := jsonb_array_length(j -> 'by_person') = 2
    and (j -> 'by_person' -> 0) = ('{"id": "' || ana || '", "name": "Ana Owner", "sent": 4, "completed": 2, "declined": 1, "voided": 0, "expired": 0, "avg_hours_to_complete": 18.0}')::jsonb
    and (j -> 'by_person' -> 1) = ('{"id": "' || max_ || '", "name": "Max Member", "sent": 2, "completed": 1, "declined": 0, "voided": 1, "expired": 1, "avg_hours_to_complete": 204.0}')::jsonb;
  if ok then res := res || E'PASS T752 the report by person matches the hand-computed answers\n';
  else res := res || 'FAIL T752 by person :: ' || (j -> 'by_person')::text || E'\n'; end if;

  -- T753: by template (documents not from a template last)
  ok := jsonb_array_length(j -> 'by_template') = 3
    and (j -> 'by_template' -> 0) = ('{"id": "' || t_nda || '", "name": "NDA", "sent": 3, "completed": 0, "declined": 0, "voided": 1, "expired": 1, "avg_hours_to_complete": null}')::jsonb
    and (j -> 'by_template' -> 1) = ('{"id": "' || t_lease || '", "name": "Lease", "sent": 2, "completed": 2, "declined": 0, "voided": 0, "expired": 0, "avg_hours_to_complete": 18.0}')::jsonb
    and (j -> 'by_template' -> 2) = ('{"id": null, "name": null, "sent": 1, "completed": 1, "declined": 1, "voided": 0, "expired": 0, "avg_hours_to_complete": 204.0}')::jsonb;
  if ok then res := res || E'PASS T753 the report by template matches the hand-computed answers\n';
  else res := res || 'FAIL T753 by template :: ' || (j -> 'by_template')::text || E'\n'; end if;

  -- T754: period edges: a one-day period, an empty period, and the day after
  x := public.report_summary(ana, org_a, '2026-03-31', '2026-03-31');   -- d6 expired, d7 sent
  ok := x -> 'totals' = '{"sent": 1, "completed": 0, "declined": 0, "voided": 0, "expired": 1, "avg_hours_to_complete": null}'::jsonb;
  x := public.report_summary(ana, org_a, '2026-04-01', '2026-04-01');   -- d7 completed (1 h), d10 sent
  ok := ok and x -> 'totals' = '{"sent": 1, "completed": 1, "declined": 0, "voided": 0, "expired": 0, "avg_hours_to_complete": 1.0}'::jsonb;
  x := public.report_summary(ana, org_a, '2025-01-01', '2025-12-31');
  ok := ok and x -> 'totals' = '{"sent": 0, "completed": 0, "declined": 0, "voided": 0, "expired": 0, "avg_hours_to_complete": null}'::jsonb
    and x -> 'by_person' = '[]'::jsonb and x -> 'by_template' = '[]'::jsonb;
  if ok then res := res || E'PASS T754 period edges: the first and last day are included, the next day is not; an empty period is all zeros\n';
  else res := res || 'FAIL T754 edges :: ' || x::text || E'\n'; end if;

  -- T755: a member sees only their own documents; a viewer sees the workspace; outsiders and bad periods are refused
  x := public.report_summary(max_, org_a, '2026-03-01', '2026-03-31');
  ok := x ->> 'scope' = 'own' and x -> 'totals' = '{"sent": 2, "completed": 1, "declined": 0, "voided": 1, "expired": 1, "avg_hours_to_complete": 204.0}'::jsonb
    and jsonb_array_length(x -> 'by_person') = 1 and (public.report_summary(vic, org_a, '2026-03-01', '2026-03-31') -> 'totals') = (j -> 'totals');
  n := 0;
  begin perform public.report_summary(oth, org_a, '2026-03-01', '2026-03-31'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.report_summary(null, org_a, '2026-03-01', '2026-03-31'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.report_summary(ana, org_a, '2026-03-31', '2026-03-01'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.report_summary(ana, org_a, '2023-01-01', '2026-03-01'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.report_summary(ana, org_a, null, '2026-03-01'); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := ok and n = 0 and (public.report_summary(oth, org_o, '2026-03-01', '2026-03-31') -> 'totals' ->> 'completed') = '1';
  execute 'reset role';
  ok := ok and not has_function_privilege('authenticated', 'public.report_summary(uuid, uuid, date, date)', 'execute')
    and not has_function_privilege('anon', 'public.report_summary(uuid, uuid, date, date)', 'execute');
  if ok then res := res || E'PASS T755 members see their own documents only, viewers the workspace; other workspaces and bad periods are refused; not callable from the browser\n';
  else res := res || 'FAIL T755 access :: n=' || n || ' ' || coalesce(x::text, '') || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
