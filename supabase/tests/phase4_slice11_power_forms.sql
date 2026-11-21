-- YouNMeSign SQL tests for Phase 4 slice 11: PowerForms, public links to a template (AT4.3, D-87). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); outsider uuid := gen_random_uuid(); fresh uuid := gen_random_uuid();
  org_a uuid; tpl uuid := gen_random_uuid(); tpl2 uuid := gen_random_uuid(); role1 uuid;
  f1 uuid; f2 uuid; pl jsonb; b jsonb; n int; ok boolean; v text;
  slug1 text := 'AAAAAAAAAAAAAAAAAAAA01'; slug2 text := 'BBBBBBBBBBBBBBBBBBBB02';
  ip text := repeat('1a', 32); em1 text := repeat('e1', 32); em2 text := repeat('e2', 32);
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't50-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Pia Public"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't50-mem@example.test', now(), '{"provider":"email"}', '{"full_name":"Max Member"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't50-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Oz Outside"}', now(), now()),
         (fresh, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't50-fresh@example.test', now(), '{"provider":"email"}', '{"full_name":"Fay Fresh"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, mem, 'member'), (org_a, fresh, 'member');
  update public.account_controls set approved = true where user_id in (a, mem);
  insert into public.templates (id, org_id, created_by, name, filename, storage_backend, storage_path, sha256, page_count, size_bytes)
    values (tpl, org_a, a, 'Volunteer waiver', 'w.pdf', 'supabase', org_a || '/tpl-' || tpl || '/document.pdf', repeat('cf', 32), 1, 900),
           (tpl2, org_a, a, 'Two people', 'two.pdf', 'supabase', org_a || '/tpl-' || tpl2 || '/document.pdf', repeat('d0', 32), 1, 900);
  insert into public.template_roles (template_id, label, role, routing_order, position) values (tpl, 'Volunteer', 'signer', 1, 1) returning id into role1;
  insert into public.template_roles (template_id, label, role, routing_order, position) values (tpl2, 'A', 'signer', 1, 1), (tpl2, 'B', 'signer', 2, 2);
  insert into public.template_fields (template_id, role_id, type, page, x, y, w, h, required, options) values (tpl, role1, 'signature', 1, 0.1, 0.8, 0.3, 0.06, true, '{}');

  execute 'set local role service_role';
  -- T701: a form needs a one-signer template the person may use, an approved account, a title and a sane limit
  n := 0;
  begin perform public.create_power_form(outsider, tpl, 'Sign up', 10, false, 'CCCCCCCCCCCCCCCCCCCC03'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_power_form(fresh, tpl, 'Sign up', 10, false, 'CCCCCCCCCCCCCCCCCCCC03'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.create_power_form(a, tpl2, 'Two', 10, false, 'CCCCCCCCCCCCCCCCCCCC03'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_power_form(a, tpl, '  ', 10, false, 'CCCCCCCCCCCCCCCCCCCC03'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_power_form(a, tpl, 'Sign up', 0, false, 'CCCCCCCCCCCCCCCCCCCC03'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.create_power_form(a, tpl, 'Sign up', 10, false, 'not a slug'); n := n + 1; exception when check_violation then null; end;
  f1 := public.create_power_form(a, tpl, ' Volunteer sign-up ', 3, false, slug1);
  f2 := public.create_power_form(mem, tpl, 'Second form', 50, true, slug2);
  ok := n = 0 and (select f.title = 'Volunteer sign-up' and f.status = 'active' and f.org_id = org_a from public.power_forms f where f.id = f1)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'power_form_created' and (x.payload ->> 'form_id')::uuid = f1);
  if ok then res := res || E'PASS T701 a public form needs a one-signer template the person may use, an approved account, a title and a daily limit of 1 to 500\n';
  else res := res || 'FAIL T701 create :: n=' || n || E'\n'; end if;

  -- T702: the public page sees only an open form: its title, who it is from and whether an email check applies
  pl := public.power_form_public(slug1);
  ok := pl ->> 'title' = 'Volunteer sign-up' and pl ->> 'owner_name' = 'Pia Public' and (pl ->> 'email_check')::boolean = false and pl ? 'org_name'
    and not pl ? 'template_id' and not pl ? 'slug'
    and public.power_form_public('ZZZZZZZZZZZZZZZZZZZZZZ') is null and public.power_form_public('../x') is null;
  if ok then res := res || E'PASS T702 the public page sees only an open form''s title, owner and whether an email check applies; unknown links see nothing\n';
  else res := res || 'FAIL T702 public view :: ' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T703: each submission is recorded and handed what the app needs to make the document
  b := public.power_form_begin(slug1, ip, em1);
  ok := (b ->> 'template_id')::uuid = tpl and (b ->> 'role_id')::uuid = role1 and (b ->> 'owner_id')::uuid = a and (b ->> 'form_id')::uuid = f1
    and (select s.status from public.power_form_submissions s where s.id = (b ->> 'submission_id')::uuid) = 'started';
  if ok then res := res || E'PASS T703 a submission is recorded and gets the template, its one role and the owner to make the document as\n';
  else res := res || 'FAIL T703 begin :: ' || coalesce(b::text, 'null') || E'\n'; end if;

  -- T704: the daily limit counts every submission that did not fail; at the limit the form is full for today
  perform public.power_form_finish((b ->> 'submission_id')::uuid, null, false, 'could not make the document');
  perform public.power_form_begin(slug1, ip, em2);
  perform public.power_form_begin(slug1, ip, repeat('e3', 32));
  perform public.power_form_begin(slug1, ip, repeat('e4', 32));   -- third that did not fail: the limit (3) is reached
  n := 0;
  begin perform public.power_form_begin(slug1, ip, repeat('e5', 32)); n := n + 1; exception when invalid_parameter_value then v := sqlerrm; end;
  ok := n = 0 and v like 'ES_FORM_FULL:%';
  if ok then res := res || E'PASS T704 the daily limit counts submissions that did not fail; at the limit the form says it is full for today\n';
  else res := res || 'FAIL T704 daily limit :: n=' || n || ' ' || coalesce(v, 'null') || E'\n'; end if;

  -- T705: one email address can use a form 3 times a day
  perform public.power_form_begin(slug2, ip, em1);
  perform public.power_form_begin(slug2, ip, em1);
  perform public.power_form_begin(slug2, ip, em1);
  n := 0;
  begin perform public.power_form_begin(slug2, ip, em1); n := n + 1; exception when invalid_parameter_value then v := sqlerrm; end;
  perform public.power_form_begin(slug2, ip, em2);   -- another address still can
  ok := n = 0 and v like 'ES_FORM_EMAIL_LIMIT:%';
  if ok then res := res || E'PASS T705 one email address can use a form 3 times a day; other addresses still can\n';
  else res := res || 'FAIL T705 per email :: n=' || n || ' ' || coalesce(v, 'null') || E'\n'; end if;

  -- T706: pausing closes the form (public page and submissions); only its maker or an owner/administrator can do it;
  -- a suspended owner's form closes too
  n := 0;
  begin perform public.set_power_form_status(outsider, f2, 'paused'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_power_form_status(fresh, f2, 'paused'); n := n + 1; exception when insufficient_privilege then null; end;
  perform public.set_power_form_status(a, f2, 'paused');      -- the owner of the workspace may pause a member's form
  ok := public.power_form_public(slug2) is null;
  begin perform public.power_form_begin(slug2, ip, repeat('e9', 32)); n := n + 1; exception when invalid_parameter_value then v := sqlerrm; end;
  ok := ok and n = 0 and v like 'ES_FORM_CLOSED:%';
  perform public.set_power_form_status(mem, f2, 'active');
  execute 'reset role';
  update public.account_controls set trust_level = 'suspended' where user_id = mem;
  execute 'set local role service_role';
  begin perform public.power_form_begin(slug2, ip, repeat('ea', 32)); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := ok and n = 0 and public.power_form_public(slug2) is not null   -- the page still shows; submitting is refused
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'power_form_paused');
  if ok then res := res || E'PASS T706 pausing closes a form; only its maker or an owner/administrator can pause it; a suspended owner''s form takes no submissions\n';
  else res := res || 'FAIL T706 pause :: n=' || n || ' ' || coalesce(v, 'null') || E'\n'; end if;

  -- T707: the list shows the forms with counts to anyone who may use the template, and who may manage each
  pl := public.power_form_list(mem, tpl);
  n := 0;
  begin perform public.power_form_list(outsider, tpl); n := n + 1; exception when insufficient_privilege then null; end;
  ok := n = 0 and jsonb_array_length(pl) = 2
    and (select (x ->> 'can_manage')::boolean from jsonb_array_elements(pl) x where (x ->> 'id')::uuid = f1) = false
    and (select (x ->> 'can_manage')::boolean from jsonb_array_elements(pl) x where (x ->> 'id')::uuid = f2) = true;
  if ok then res := res || E'PASS T707 the list shows a template''s forms with their counts, and who may manage each, to people who may use the template\n';
  else res := res || 'FAIL T707 list :: ' || coalesce(pl::text, 'null') || E'\n'; end if;

  -- T708: everything is server-only; nobody signed in or anonymous can read the tables
  execute 'reset role';
  ok := not has_function_privilege('anon', 'public.power_form_begin(text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.create_power_form(uuid, uuid, text, int, boolean, text)', 'execute')
    and not has_function_privilege('anon', 'public.power_form_public(text)', 'execute')
    and not has_table_privilege('anon', 'public.power_forms', 'select')
    and not has_table_privilege('authenticated', 'public.power_form_submissions', 'select');
  if ok then res := res || E'PASS T708 public forms are handled only by the server\n';
  else res := res || E'FAIL T708 privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
