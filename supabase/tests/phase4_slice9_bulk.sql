-- YouNMeSign SQL tests for Phase 4 slice 9: bulk send (AT4.2, D-85). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  org_a uuid; tpl uuid := gen_random_uuid(); tpl2 uuid := gen_random_uuid(); role1 uuid; role2 uuid;
  b1 uuid; b2 uuid; e1 uuid; d1 uuid; r1 uuid;
  claimed jsonb; claimed2 jsonb; drafts jsonb;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid;
  n int; ok boolean; v text; pl jsonb;
  rows jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't49-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Bea Bulk"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't49-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Oz Outside"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id = a;
  -- a one-person template with a named number field, and a two-person template
  insert into public.templates (id, org_id, created_by, name, filename, storage_backend, storage_path, sha256, page_count, size_bytes)
    values (tpl, org_a, a, 'Lease renewal', 'lease.pdf', 'supabase', org_a || '/tpl-' || tpl || '/document.pdf', repeat('cf', 32), 1, 900),
           (tpl2, org_a, a, 'Two people', 'two.pdf', 'supabase', org_a || '/tpl-' || tpl2 || '/document.pdf', repeat('d0', 32), 1, 900);
  insert into public.template_roles (template_id, label, role, routing_order, position) values (tpl, 'Tenant', 'signer', 1, 1) returning id into role1;
  insert into public.template_roles (template_id, label, role, routing_order, position) values (tpl2, 'A', 'signer', 1, 1), (tpl2, 'B', 'signer', 2, 2);
  insert into public.template_fields (template_id, role_id, type, page, x, y, w, h, required, options)
    values (tpl, role1, 'signature', 1, 0.1, 0.8, 0.3, 0.06, true, '{}'),
           (tpl, role1, 'number', 1, 0.1, 0.2, 0.2, 0.03, true, '{"name":"rent","decimals":0,"min":1}');
  -- claiming takes the oldest due rows of the whole database: park every other active batch for this test
  -- (a real or end-to-end batch may be running at the same time); rolled back with everything else at the end
  update public.bulk_batches b set status = 'done', finished_at = now() where b.status = 'active';

  execute 'set local role service_role';
  -- T681: every row is checked; good rows wait to be sent, the others are kept with their reason
  rows := '[{"row_no":1,"name":"Ann Able","email":"T49-ann@example.test","values":{"rent":"1200"}},
            {"row_no":2,"name":"Ben Bold","email":"t49-ben@example.test","values":{}},
            {"row_no":3,"name":"","email":"t49-x@example.test","values":{}},
            {"row_no":4,"name":"Cy","email":"not-an-email","values":{}},
            {"row_no":5,"name":"Dee","email":"t49-ann@example.test","values":{}},
            {"row_no":6,"name":"Eve","email":"t49-eve@example.test","values":{"rent":"abc"}},
            {"row_no":7,"name":"Fay","email":"t49-fay@example.test","values":{"colour":"red"}},
            {"row_no":8,"name":"Gil","email":"t49-gil@example.test","values":{"rent":"900"}},
            {"row_no":9,"name":"Hal","email":"t49-hal@example.test","values":{}}]';
  b1 := public.create_bulk_batch(a, tpl, 'link', 30, rows);
  select string_agg(i.row_no || ':' || i.status || ':' || coalesce(i.reason, ''), ' | ' order by i.row_no) into v from public.bulk_items i where i.batch_id = b1;
  ok := v = '1:pending: | 2:pending: | 3:invalid:The name is empty. | 4:invalid:"not-an-email" is not a valid email address. | 5:invalid:The same email address is already on row 1. | 6:invalid:rent: enter a number, like 12 or 12.50 | 7:invalid:"colour" is not a named field of this template. | 8:pending: | 9:pending:'
    and (select i.email from public.bulk_items i where i.batch_id = b1 and i.row_no = 1) = 't49-ann@example.test'
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'bulk_batch_created'
                  and (x.payload ->> 'valid')::int = 4 and (x.payload ->> 'invalid')::int = 5);
  if ok then res := res || E'PASS T681 every row is checked again: good rows wait to be sent, the others are kept with their reason (empty name, bad email, duplicate, bad value, unknown field)\n';
  else res := res || 'FAIL T681 row checks :: ' || coalesce(v, 'null') || E'\n'; end if;

  -- T682: only one-person templates; 1 to 500 rows; row numbers unique; an outsider cannot use the template
  n := 0;
  begin perform public.create_bulk_batch(a, tpl2, 'link', 30, '[{"row_no":1,"name":"A","email":"t49-a@example.test"}]'); n := n + 1;
        exception when invalid_parameter_value then get stacked diagnostics v = message_text; if v not like '%exactly one person%' then n := n + 10; end if; end;
  begin perform public.create_bulk_batch(a, tpl, 'link', 30, '[]'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_bulk_batch(a, tpl, 'link', 30, (select jsonb_agg(jsonb_build_object('row_no', g, 'name', 'N', 'email', 'n' || g || '@example.test')) from generate_series(1, 501) g)); n := n + 1;
        exception when invalid_parameter_value then null; end;
  begin perform public.create_bulk_batch(a, tpl, 'link', 30, '[{"row_no":1,"name":"A","email":"t49-a@example.test"},{"row_no":1,"name":"B","email":"t49-b@example.test"}]'); n := n + 1;
        exception when invalid_parameter_value then null; end;
  begin perform public.create_bulk_batch(outsider, tpl, 'link', 30, '[{"row_no":1,"name":"A","email":"t49-a@example.test"}]'); n := n + 1; exception when insufficient_privilege then null; end;
  if n = 0 then res := res || E'PASS T682 bulk send needs a one-person template, 1 to 500 rows with unique numbers, and access to the template\n';
  else res := res || 'FAIL T682 batch limits :: n=' || n || E'\n'; end if;

  -- T683: the worker claims rows under a lease: claimed rows are not handed out twice
  claimed := public.claim_bulk_items(2);
  claimed2 := public.claim_bulk_items(5);
  ok := jsonb_array_length(claimed) = 2 and jsonb_array_length(claimed2) = 2
    and (claimed -> 0 ->> 'row_no')::int = 1 and (claimed -> 1 ->> 'row_no')::int = 2
    and (claimed2 -> 0 ->> 'row_no')::int = 8 and (claimed2 -> 1 ->> 'row_no')::int = 9
    and (claimed -> 0 ->> 'attempts')::int = 1 and claimed -> 0 ->> 'created_by' = a::text and claimed -> 0 -> 'values' ->> 'rent' = '1200'
    and jsonb_array_length(public.claim_bulk_items(5)) = 0;
  i1 := (claimed -> 0 ->> 'id')::uuid; i2 := (claimed -> 1 ->> 'id')::uuid; i3 := (claimed2 -> 0 ->> 'id')::uuid; i4 := (claimed2 -> 1 ->> 'id')::uuid;
  if ok then res := res || E'PASS T683 rows are claimed under a lease, in order, each handed out once, with what the worker needs\n';
  else res := res || 'FAIL T683 claiming :: ' || coalesce(claimed::text, 'null') || E'\n'; end if;

  -- T684: a row remembers its draft once (a retry continues it; it cannot be swapped)
  select e.id into e1 from public.create_envelope(a, org_a, 'Lease renewal - Ann', null) e;
  select d.id into d1 from public.add_envelope_document(a, e1, 'l.pdf', 'supabase', org_a || '/' || e1 || '/d1', repeat('ce', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(a, e1, '[{"name":"Ann Able","email":"t49-ann@example.test","role":"signer","routing_order":1}]');
  select x.id into r1 from public.recipients x where x.envelope_id = e1;
  perform public.save_fields(a, e1, jsonb_build_array(
    jsonb_build_object('document_id', d1, 'recipient_id', r1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d1, 'recipient_id', r1, 'type', 'number', 'page', 1, 'x', 0.1, 'y', 0.2, 'w', 0.2, 'h', 0.03, 'options', jsonb_build_object('name', 'rent', 'decimals', 0, 'min', 1))));
  perform public.set_bulk_item_envelope(i1, e1);
  perform public.set_bulk_item_envelope(i1, gen_random_uuid());
  if (select i.envelope_id from public.bulk_items i where i.id = i1) = e1
  then res := res || E'PASS T684 a row remembers the draft it made, once; it cannot be replaced (so a retry never makes a second document)\n';
  else res := res || E'FAIL T684 the remembered draft changed\n'; end if;

  -- T685: the row's values become prefilled values, checked like a signer's answer; drafts only
  n := 0;
  begin perform public.bulk_apply_values(e1, '{"rent":"0"}'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.bulk_apply_values(e1, '{"colour":"red"}'); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.bulk_apply_values(e1, '{"rent":"1200"}');
  ok := (select f.options ->> 'prefill' from public.fields f where f.envelope_id = e1 and f.type = 'number') = '1200';
  perform public.send_envelope(a, e1, jsonb_build_array(jsonb_build_object('recipient_id', r1, 'token_id', gen_random_uuid(), 'nonce', repeat('e1', 16), 'token_sha256', repeat('e2', 32))),
    now() + interval '30 days', 'link');
  begin perform public.bulk_apply_values(e1, '{"rent":"5"}'); n := n + 1; exception when insufficient_privilege then null; end;
  ok := ok and (select v2.value_text from public.field_values v2 join public.fields f on f.id = v2.field_id where f.envelope_id = e1 and f.type = 'number') = '1200';
  if n = 0 and ok then res := res || E'PASS T685 a row''s values become the document''s prefilled values (stored when sent), checked like answers; only on drafts\n';
  else res := res || 'FAIL T685 applying values :: n=' || n || E'\n'; end if;

  -- T686: finishing rows: waiting rows come back at their time; the batch closes when nothing is left and the sender is told
  perform public.finish_bulk_item(i1, 'sent', null, null);
  perform public.finish_bulk_item(i2, 'pending', 'Waiting for the next day''s email allowance.', now() + interval '1 day');
  ok := jsonb_array_length(public.claim_bulk_items(5)) = 0
    and (select b.status from public.bulk_batches b where b.id = b1) = 'active';
  perform public.finish_bulk_item(i3, 'failed', 'Something specific.', null);
  perform public.finish_bulk_item(i4, 'sent', null, null);
  update public.bulk_items i set not_before = now() - interval '1 minute' where i.id = i2;
  claimed := public.claim_bulk_items(5);
  perform public.finish_bulk_item(i2, 'sent', null, null);
  ok := ok and jsonb_array_length(claimed) = 1 and (claimed -> 0 ->> 'attempts')::int = 2
    and (select b.status = 'done' and b.finished_at is not null from public.bulk_batches b where b.id = b1)
    and exists (select 1 from public.notifications q where q.user_id = a and q.kind = 'bulk_done' and (q.payload ->> 'sent')::int = 3 and (q.payload ->> 'failed')::int = 6);
  if ok then res := res || E'PASS T686 a waiting row comes back only at its time (with its attempts counted); the batch closes when nothing is left and the sender is told what was sent and what was not\n';
  else res := res || E'FAIL T686 finishing rows\n'; end if;

  -- T687: cancelling stops every row not started, returns their drafts for removal, leaves rows in progress to finish;
  -- only the batch's maker or an owner/administrator can do it
  b2 := public.create_bulk_batch(a, tpl, 'email', 14, '[{"row_no":1,"name":"Ivy","email":"t49-ivy@example.test"},{"row_no":2,"name":"Jo","email":"t49-jo@example.test"},{"row_no":3,"name":"Kit","email":"t49-kit@example.test"}]');
  claimed := public.claim_bulk_items(1);                                   -- row 1 is being worked on
  update public.bulk_items i set envelope_id = e1 where i.batch_id = b2 and i.row_no = 2;   -- pretend row 2 already has a (sent) document
  n := 0;
  begin perform public.cancel_bulk_batch(outsider, b2); n := n + 1; exception when insufficient_privilege then null; end;
  drafts := public.cancel_bulk_batch(a, b2);
  ok := n = 0 and drafts = '[]'::jsonb   -- e1 is sent, so it is not a draft to remove
    and (select string_agg(i.row_no || ':' || i.status, ',' order by i.row_no) from public.bulk_items i where i.batch_id = b2) = '1:pending,2:cancelled,3:cancelled'
    and (select b.status from public.bulk_batches b where b.id = b2) = 'cancelled';
  perform public.finish_bulk_item((claimed -> 0 ->> 'id')::uuid, 'pending', 'waiting', now() + interval '1 day');
  ok := ok and (select i.status from public.bulk_items i where i.batch_id = b2 and i.row_no = 1) = 'cancelled'
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'bulk_batch_cancelled');
  begin perform public.cancel_bulk_batch(a, b2); n := n + 1; exception when invalid_parameter_value then null; end;
  if ok and n = 0 then res := res || E'PASS T687 cancelling stops every row not yet started (a row in progress that would wait is cancelled too), keeps sent documents, and is limited to the batch''s maker or an owner/administrator\n';
  else res := res || 'FAIL T687 cancel :: n=' || n || ' drafts=' || coalesce(drafts::text, 'null') || E'\n'; end if;

  -- T688: the view shows counts and every row with its reason; outsiders see nothing
  pl := public.bulk_batch_view(a, b1);
  n := 0;
  begin perform public.bulk_batch_view(outsider, b1); n := n + 1; exception when insufficient_privilege then null; end;
  ok := n = 0 and (pl -> 'counts' ->> 'sent')::int = 3 and (pl -> 'counts' ->> 'invalid')::int = 5 and (pl -> 'counts' ->> 'failed')::int = 1
    and jsonb_array_length(pl -> 'items') = 9 and pl -> 'items' -> 2 ->> 'reason' = 'The name is empty.'
    and jsonb_array_length(public.bulk_batch_list(a)) >= 2 and jsonb_array_length(public.bulk_batch_list(outsider)) = 0;
  execute 'reset role';
  ok := ok and not has_function_privilege('authenticated', 'public.create_bulk_batch(uuid, uuid, text, int, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.claim_bulk_items(int)', 'execute')
    and not has_function_privilege('authenticated', 'public.cancel_bulk_batch(uuid, uuid)', 'execute')
    and not has_table_privilege('authenticated', 'public.bulk_items', 'select');
  if ok then res := res || E'PASS T688 the batch view shows counts and every row with its reason to its maker; outsiders see nothing; everything is server-only\n';
  else res := res || 'FAIL T688 view and privileges :: ' || coalesce(pl::text, 'null') || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
