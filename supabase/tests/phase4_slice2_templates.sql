-- YouNMeSign SQL tests for Phase 4 slice 2: templates (AT4.1, D-77). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  o uuid := gen_random_uuid(); ad uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); vw uuid := gen_random_uuid(); x uuid := gen_random_uuid();
  org_a uuid; e_src uuid; d_src uuid; r_ten uuid; r_land uuid; e_m1 uuid; d_m1 uuid; r_m1 uuid;
  t_a uuid := gen_random_uuid(); t_p uuid := gen_random_uuid(); t_bad uuid := gen_random_uuid();
  role_ten uuid; role_land uuid; f_lock uuid;
  started jsonb; e_new uuid; e_new2 uuid; d_new uuid; n int; c int; ok boolean; v text; j jsonb; layout jsonb; before_fields jsonb; before_people jsonb;
  exp timestamptz := now() + interval '30 days';
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (o,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't42-owner@example.test',  now(), '{"provider":"email"}', '{"full_name":"Oona Owner"}', now(), now()),
         (ad, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't42-admin@example.test',  now(), '{"provider":"email"}', '{"full_name":"Ari Admin"}', now(), now()),
         (m1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't42-m1@example.test',     now(), '{"provider":"email"}', '{"full_name":"Mae Member"}', now(), now()),
         (vw, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't42-viewer@example.test', now(), '{"provider":"email"}', '{"full_name":"Val Viewer"}', now(), now()),
         (x,  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't42-out@example.test',    now(), '{"provider":"email"}', '{"full_name":"Xan Out"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = o and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, ad, 'admin'), (org_a, m1, 'member'), (org_a, vw, 'viewer');
  update public.account_controls set approved = true, daily_envelope_cap = 50, daily_recipient_cap = 50 where user_id in (o, ad, m1, vw, x);

  execute 'set local role service_role';
  -- the owner's lease: Tenant (signature + text) and Landlord (signature)
  select e.id into e_src from public.create_envelope(o, org_a, 'Lease for Flat 4', null) e;
  select d.id into d_src from public.add_envelope_document(o, e_src, 'lease.pdf', 'supabase', org_a || '/' || e_src || '/d1', repeat('a4', 32), 2, 4000, '[]', 'pdf') d;
  perform public.save_recipients(o, e_src, '[{"name":"Tia Tenant","email":"t42-tia@example.test","role":"signer","routing_order":1},
                                            {"name":"Leo Landlord","email":"t42-leo@example.test","role":"signer","routing_order":2}]');
  select y.id into r_ten from public.recipients y where y.envelope_id = e_src and y.routing_order = 1;
  select y.id into r_land from public.recipients y where y.envelope_id = e_src and y.routing_order = 2;
  perform public.save_fields(o, e_src, jsonb_build_array(
    jsonb_build_object('document_id', d_src, 'recipient_id', r_ten, 'type', 'signature', 'page', 2, 'x', 0.1, 'y', 0.8, 'w', 0.3, 'h', 0.06),
    jsonb_build_object('document_id', d_src, 'recipient_id', r_ten, 'type', 'text', 'page', 1, 'x', 0.1, 'y', 0.3, 'w', 0.4, 'h', 0.04),
    jsonb_build_object('document_id', d_src, 'recipient_id', r_land, 'type', 'signature', 'page', 2, 'x', 0.55, 'y', 0.8, 'w', 0.3, 'h', 0.06)));

  -- T611: making a template from a document; the file's place is fixed; only people who may handle the document
  n := 0;
  begin perform public.template_create(o, t_bad, e_src, 'Wrong place', true, '[]', org_a || '/' || e_src || '/d1'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_create(m1, t_bad, e_src, 'Not mine', true, '[]', org_a || '/tpl-' || t_bad || '/document.pdf'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_create(x, t_bad, e_src, 'Outsider', true, '[]', org_a || '/tpl-' || t_bad || '/document.pdf'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_create(o, t_bad, e_src, '   ', true, '[]', org_a || '/tpl-' || t_bad || '/document.pdf'); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.template_create(o, t_a, e_src, 'Standard lease', true,
    jsonb_build_array(jsonb_build_object('recipient_id', r_ten, 'label', 'Tenant'), jsonb_build_object('recipient_id', r_land, 'label', 'Landlord')),
    org_a || '/tpl-' || t_a || '/document.pdf');
  select r.id into role_ten from public.template_roles r where r.template_id = t_a and r.label = 'Tenant';
  select r.id into role_land from public.template_roles r where r.template_id = t_a and r.label = 'Landlord';
  if n = 0 and role_ten is not null and role_land is not null
     and (select count(*) from public.template_fields f where f.template_id = t_a) = 3
     and (select count(*) from public.template_fields f where f.template_id = t_a and f.role_id = role_ten) = 2
     and (select r.routing_order from public.template_roles r where r.id = role_land) = 2
     and exists (select 1 from public.audit_events a where a.org_id = org_a and a.event_type = 'template_created' and a.payload ->> 'template_id' = t_a::text
                  and a.payload::text not ilike '%tia%' and a.payload::text not ilike '%lease%')
  then res := res || E'PASS T611 a template copies the layout with roles instead of people; only someone who may handle the document can make one; the audit trail has no names or titles\n';
  else res := res || 'FAIL T611 create :: n=' || n || E'\n'; end if;

  -- a member's own personal template
  select e.id into e_m1 from public.create_envelope(m1, org_a, 'Mae NDA', null) e;
  select d.id into d_m1 from public.add_envelope_document(m1, e_m1, 'nda.pdf', 'supabase', org_a || '/' || e_m1 || '/d1', repeat('b4', 32), 1, 900, '[]', 'pdf') d;
  perform public.save_recipients(m1, e_m1, '[{"name":"Ned","email":"t42-ned@example.test","role":"signer","routing_order":1}]');
  select y.id into r_m1 from public.recipients y where y.envelope_id = e_m1;
  perform public.save_fields(m1, e_m1, jsonb_build_array(jsonb_build_object('document_id', d_m1, 'recipient_id', r_m1, 'type', 'signature', 'page', 1, 'x', 0.1, 'y', 0.5, 'w', 0.3, 'h', 0.06)));
  perform public.template_create(m1, t_p, e_m1, 'My NDA', false, '[]', org_a || '/tpl-' || t_p || '/document.pdf');

  -- T612: who sees and who may edit
  select count(*) into c from public.template_list(m1, org_a);
  ok := (select l.can_edit from public.template_list(m1, org_a) l where l.id = t_a) = false
        and (select l.can_edit from public.template_list(m1, org_a) l where l.id = t_p) = true
        and not exists (select 1 from public.template_list(o, org_a) l where l.id = t_p)        -- personal: only its creator
        and (select l.can_edit from public.template_list(ad, org_a) l where l.id = t_a) = true
        and (select r.label from public.template_roles r where r.template_id = t_p) = 'Signer 1';
  n := 0;
  begin perform public.template_list(vw, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_list(x, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_get(o, t_p); n := n + 1; exception when insufficient_privilege then null; end;
  if c = 2 and ok and n = 0
  then res := res || E'PASS T612 a shared template is seen by every member and edited by its creator, the owner and administrators; a personal one only by its creator; viewers and outsiders see none\n';
  else res := res || 'FAIL T612 visibility :: m1 sees ' || c || ' ok=' || coalesce(ok::text, '?') || ' n=' || n || E'\n'; end if;

  -- T613: editing: a member cannot change a shared template; an administrator can, including locking a field
  select f.id into f_lock from public.template_fields f where f.template_id = t_a and f.role_id = role_ten and f.type = 'signature';
  n := 0;
  begin perform public.template_update(m1, t_a, 'Hijacked', true, '[]', '{}'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.template_update(ad, t_a, '', true, '[]', '{}'); n := n + 1; exception when invalid_parameter_value then null; end;
  perform public.template_update(ad, t_a, 'Standard lease (2027)', true, jsonb_build_array(jsonb_build_object('role_id', role_ten, 'label', 'Tenant')), array[f_lock]);
  if n = 0 and (select t.name from public.templates t where t.id = t_a) = 'Standard lease (2027)'
     and (select count(*) from public.template_fields f where f.template_id = t_a and f.locked) = 1
     and (select f.locked from public.template_fields f where f.id = f_lock)
  then res := res || E'PASS T613 editing a shared template: refused for a member, allowed for an administrator; one field locked\n';
  else res := res || 'FAIL T613 edit :: n=' || n || E'\n'; end if;

  -- T614: using a template: each role becomes one person; the fields follow their role; the lock comes along
  n := 0;
  begin perform public.template_start(m1, t_a, 'x', '[]'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.template_start(m1, t_a, 'x', jsonb_build_array(jsonb_build_object('role_id', role_ten, 'name', 'A', 'email', 'not-an-address'),
                                                                     jsonb_build_object('role_id', role_land, 'name', 'B', 'email', 'b@example.test'))); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.template_start(vw, t_a, 'x', '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  started := public.template_start(m1, t_a, 'Lease for Flat 9', jsonb_build_array(
    jsonb_build_object('role_id', role_land, 'name', 'Lara Landlord', 'email', 'T42-Lara@Example.test'),
    jsonb_build_object('role_id', role_ten, 'name', 'Tom Tenant', 'email', 't42-tom@example.test')));
  e_new := (started ->> 'envelope_id')::uuid;
  begin perform public.template_finish(m1, e_new, t_a, org_a || '/' || e_src || '/document.pdf'); n := n + 1; exception when insufficient_privilege then null; end;  -- not this draft's folder
  perform public.template_finish(m1, e_new, t_a, org_a || '/' || e_new || '/document.pdf');
  select d.id into d_new from public.envelope_documents d where d.envelope_id = e_new;
  ok := (select e.sender_id from public.envelopes e where e.id = e_new) = m1
        and (select e.title from public.envelopes e where e.id = e_new) = 'Lease for Flat 9'
        and (select y.email from public.recipients y where y.envelope_id = e_new and y.routing_order = 2) = 't42-lara@example.test'
        and (select y.name from public.recipients y where y.envelope_id = e_new and y.routing_order = 1) = 'Tom Tenant'
        and (select count(*) from public.fields f join public.recipients y on y.id = f.recipient_id where f.envelope_id = e_new and y.name = 'Tom Tenant') = 2
        and (select count(*) from public.fields f where f.envelope_id = e_new and f.locked) = 1
        and (select f.type from public.fields f where f.envelope_id = e_new and f.locked) = 'signature'
        and (select e.field_layout_sha256 from public.envelopes e where e.id = e_new) is not null;
  if n = 0 and ok
  then res := res || E'PASS T614 a template becomes a new draft: one person per role, each role''s fields go to that person, the locked field stays locked; bad input and viewers are refused\n';
  else res := res || 'FAIL T614 use :: n=' || n || ' ok=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T615 (AT4.1): locked fields cannot be moved, resized or removed; their holder cannot be removed or change role
  select jsonb_agg(jsonb_build_object('document_id', f.document_id, 'recipient_id', f.recipient_id, 'type', f.type, 'page', f.page,
                                      'x', f.x, 'y', f.y, 'w', f.w, 'h', f.h, 'required', f.required, 'locked', f.locked) order by f.page, f.y, f.x)
    into layout from public.fields f where f.envelope_id = e_new;
  n := 0;
  -- move the locked field
  begin perform public.save_fields(m1, e_new, (select jsonb_agg(case when (q ->> 'locked')::boolean then q || jsonb_build_object('x', 0.2) else q end) from jsonb_array_elements(layout) q));
        n := n + 1; exception when insufficient_privilege then null; end;
  -- resize it
  begin perform public.save_fields(m1, e_new, (select jsonb_agg(case when (q ->> 'locked')::boolean then q || jsonb_build_object('w', 0.5) else q end) from jsonb_array_elements(layout) q));
        n := n + 1; exception when insufficient_privilege then null; end;
  -- remove it
  begin perform public.save_fields(m1, e_new, (select jsonb_agg(q) from jsonb_array_elements(layout) q where not (q ->> 'locked')::boolean));
        n := n + 1; exception when insufficient_privilege then null; end;
  -- trying to clear the lock from the client does nothing: the field is matched and locked again
  perform public.save_fields(m1, e_new, (select jsonb_agg(q || jsonb_build_object('locked', false)) from jsonb_array_elements(layout) q));
  ok := (select count(*) from public.fields f where f.envelope_id = e_new and f.locked) = 1;
  -- unlocked fields can be moved and new ones added
  perform public.save_fields(m1, e_new, (select jsonb_agg(case when (q ->> 'locked')::boolean then q else q || jsonb_build_object('y', 0.35) end) from jsonb_array_elements(layout) q)
    || jsonb_build_array(jsonb_build_object('document_id', d_new, 'recipient_id', (select y.id from public.recipients y where y.envelope_id = e_new and y.routing_order = 2),
                                            'type', 'date_signed', 'page', 2, 'x', 0.55, 'y', 0.9, 'w', 0.2, 'h', 0.04)));
  ok := ok and (select count(*) from public.fields f where f.envelope_id = e_new) = 4 and (select count(*) from public.fields f where f.envelope_id = e_new and f.locked) = 1;
  -- the tenant holds the locked field: cannot be removed or become a copy-only person; a new email is fine
  begin perform public.save_recipients(m1, e_new, (select jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name, 'email', y.email, 'role', y.role, 'routing_order', y.routing_order))
                                                     from public.recipients y where y.envelope_id = e_new and y.routing_order = 2));
        n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.save_recipients(m1, e_new, (select jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name, 'email', y.email,
                                                     'role', case when y.routing_order = 1 then 'cc' else y.role end, 'routing_order', y.routing_order))
                                                     from public.recipients y where y.envelope_id = e_new));
        n := n + 1; exception when insufficient_privilege then null; end;
  perform public.save_recipients(m1, e_new, (select jsonb_agg(jsonb_build_object('id', y.id, 'name', y.name,
                                               'email', case when y.routing_order = 1 then 't42-tom.new@example.test' else y.email end, 'role', y.role, 'routing_order', y.routing_order))
                                               from public.recipients y where y.envelope_id = e_new));
  ok := ok and (select y.email from public.recipients y where y.envelope_id = e_new and y.routing_order = 1) = 't42-tom.new@example.test'
           and (select count(*) from public.fields f where f.envelope_id = e_new and f.locked) = 1;
  if n = 0 and ok
  then res := res || E'PASS T615 AT4.1 a locked field cannot be moved, resized or removed (and the lock cannot be cleared from outside); unlocked fields can change; its holder cannot be removed or made copy-only\n';
  else res := res || 'FAIL T615 locked fields :: n=' || n || ' ok=' || coalesce(ok::text, '?') || E'\n'; end if;

  -- T616 (AT4.1): template edits and deletion do not alter documents made from it (sent or draft)
  perform public.send_envelope(m1, e_new, (select jsonb_agg(jsonb_build_object('recipient_id', y.id, 'token_id', gen_random_uuid(), 'nonce', repeat('7' || y.routing_order, 16),
                                                                               'token_sha256', repeat('e' || y.routing_order, 32)))
                                             from public.recipients y where y.envelope_id = e_new), exp, 'link');
  started := public.template_start(o, t_a, null, jsonb_build_array(
    jsonb_build_object('role_id', role_land, 'name', 'Lou', 'email', 't42-lou@example.test'), jsonb_build_object('role_id', role_ten, 'name', 'Tess', 'email', 't42-tess@example.test')));
  e_new2 := (started ->> 'envelope_id')::uuid;
  perform public.template_finish(o, e_new2, t_a, org_a || '/' || e_new2 || '/document.pdf');
  select jsonb_agg(to_jsonb(f) - 'created_at' order by f.id) into before_fields from public.fields f where f.envelope_id in (e_new, e_new2);
  select jsonb_agg(to_jsonb(y) order by y.id) into before_people from public.recipients y where y.envelope_id in (e_new, e_new2);
  perform public.template_update(o, t_a, 'Renamed lease', false, jsonb_build_array(jsonb_build_object('role_id', role_ten, 'label', 'Resident')), '{}');
  v := public.template_delete(o, t_a);
  ok := (select jsonb_agg(to_jsonb(f) - 'created_at' order by f.id) from public.fields f where f.envelope_id in (e_new, e_new2)) = before_fields
        and (select jsonb_agg(to_jsonb(y) order by y.id) from public.recipients y where y.envelope_id in (e_new, e_new2)) = before_people
        and (select e.status from public.envelopes e where e.id = e_new) = 'sent'
        and (select e.title from public.envelopes e where e.id = e_new2) = 'Standard lease (2027)'
        and v = org_a || '/tpl-' || t_a || '/document.pdf'
        and not exists (select 1 from public.template_list(ad, org_a) l where l.id = t_a);
  n := 0;
  begin perform public.template_start(m1, t_a, 'after delete', '[]'); n := n + 1; exception when insufficient_privilege then null; end;
  if ok and n = 0
  then res := res || E'PASS T616 AT4.1 renaming, unlocking and deleting a template changes nothing in the sent document or the draft made from it; a deleted template can no longer be used\n';
  else res := res || 'FAIL T616 independence :: ok=' || coalesce(ok::text, '?') || ' n=' || n || E'\n'; end if;
  execute 'reset role';

  -- T617: nothing here is reachable from the browser
  ok := not has_table_privilege('authenticated', 'public.templates', 'select') and not has_table_privilege('anon', 'public.template_fields', 'select')
    and not has_function_privilege('authenticated', 'public.template_start(uuid, uuid, text, jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.template_create(uuid, uuid, uuid, text, boolean, jsonb, text)', 'execute')
    and has_function_privilege('service_role', 'public.template_finish(uuid, uuid, uuid, text)', 'execute');
  if ok then res := res || E'PASS T617 templates are server-only\n';
  else res := res || E'FAIL T617 something about templates is reachable from the browser\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
