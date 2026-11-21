-- YouNMeSign SQL tests for Phase 4 slice 12: workspace branding (AT4.8, D-88). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); outsider uuid := gen_random_uuid();
  org_a uuid; n int; ok boolean; v text; old text;
  logo text;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't51-owner@example.test', now(), '{"provider":"email"}', '{"full_name":"Bo Brand"}', now(), now()),
         (adm, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't51-adm@example.test', now(), '{"provider":"email"}', '{"full_name":"Ada Admin"}', now(), now()),
         (mem, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't51-mem@example.test', now(), '{"provider":"email"}', '{"full_name":"Mo Member"}', now(), now()),
         (outsider, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't51-out@example.test', now(), '{"provider":"email"}', '{"full_name":"Oz Outside"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  insert into public.memberships (org_id, user_id, role) values (org_a, adm, 'admin'), (org_a, mem, 'member');
  logo := org_a || '/logo/' || gen_random_uuid() || '.png';

  -- T711: the contrast rule gives the published values
  ok := app_private.wcag_contrast('#000000', '#FFFFFF') = 21 and app_private.wcag_contrast('#FFFFFF', '#FFFFFF') = 1
    and app_private.wcag_contrast('#777777', '#FFFFFF') = 4.47 and app_private.wcag_contrast('#2F5D50', '#FFFFFF') >= 4.5;
  if ok then res := res || E'PASS T711 the contrast rule gives the published WCAG values (rounded down)\n';
  else res := res || 'FAIL T711 contrast :: 777777=' || app_private.wcag_contrast('#777777', '#FFFFFF') || E'\n'; end if;

  execute 'set local role service_role';
  -- T712: owners and administrators set a readable colour and a footer; it is stored normalised and audited
  perform public.set_org_branding(a, org_a, '#2f5d50', 'light', 'Acme Lettings Ltd, 1 High Street');
  perform public.set_org_branding(adm, org_a, '#2F5D50', 'light', 'Acme Lettings Ltd, 1 High Street');
  ok := (select b.brand_color = '#2F5D50' and b.text_on_brand = 'light' and b.email_footer = 'Acme Lettings Ltd, 1 High Street' and b.updated_by = adm from public.org_branding b where b.org_id = org_a)
    and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'branding_changed');
  if ok then res := res || E'PASS T712 the owner or an administrator sets a readable brand colour and footer; stored normalised and audited\n';
  else res := res || E'FAIL T712 set branding\n'; end if;

  -- T713: unreadable combinations are refused, and so are malformed colours and footers
  n := 0;
  begin perform public.set_org_branding(a, org_a, '#FFD400', 'light', null); n := n + 1; exception when invalid_parameter_value then v := sqlerrm; end;
  begin perform public.set_org_branding(a, org_a, '#777777', 'light', null); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_org_branding(a, org_a, '#2F5D50', 'dark', null); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_org_branding(a, org_a, 'red', 'light', null); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_org_branding(a, org_a, '#2F5D50', 'light', repeat('x', 501)); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_org_branding(a, org_a, '#2F5D50', 'light', 'bell' || chr(7)); n := n + 1; exception when invalid_parameter_value then null; end;
  ok := n = 0 and v like 'ES_CONTRAST:%' and (select b.brand_color from public.org_branding b where b.org_id = org_a) = '#2F5D50';
  if ok then res := res || E'PASS T713 unreadable colour combinations are refused (and malformed colours and footers); nothing changes\n';
  else res := res || 'FAIL T713 refused :: n=' || n || ' ' || coalesce(v, 'null') || E'\n'; end if;

  -- T714: members and outsiders cannot change it
  n := 0;
  begin perform public.set_org_branding(mem, org_a, '#000000', 'light', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_org_branding(outsider, org_a, '#000000', 'light', null); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.set_org_logo(mem, org_a, logo, repeat('ab', 32), 'image/png'); n := n + 1; exception when insufficient_privilege then null; end;
  begin perform public.clear_org_branding(outsider, org_a); n := n + 1; exception when insufficient_privilege then null; end;
  ok := n = 0;
  if ok then res := res || E'PASS T714 members and outsiders cannot change a workspace''s branding\n';
  else res := res || 'FAIL T714 roles :: n=' || n || E'\n'; end if;

  -- T715: a logo can be set, replaced and removed (the old path is handed back for removal); only in its own workspace's folder
  old := public.set_org_logo(a, org_a, logo, repeat('ab', 32), 'image/png');
  ok := old is null;
  old := public.set_org_logo(a, org_a, org_a || '/logo/' || gen_random_uuid() || '.jpg', repeat('cd', 32), 'image/jpeg');
  ok := ok and old = logo;
  n := 0;
  begin perform public.set_org_logo(a, org_a, gen_random_uuid() || '/logo/' || gen_random_uuid() || '.png', repeat('ab', 32), 'image/png'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.set_org_logo(a, org_a, org_a || '/../x.png', repeat('ab', 32), 'image/png'); n := n + 1; exception when invalid_parameter_value or check_violation then null; end;
  ok := ok and n = 0 and exists (select 1 from public.audit_events x where x.chain_key = 'org:' || org_a and x.event_type = 'branding_logo_changed');
  if ok then res := res || E'PASS T715 a logo can be set and replaced (the old file''s path is handed back), only within its own workspace''s folder\n';
  else res := res || 'FAIL T715 logo :: n=' || n || ' old=' || coalesce(old, 'null') || E'\n'; end if;

  -- T716: switching branding off removes it and hands back the logo path; everything is server-only
  old := public.clear_org_branding(a, org_a);
  ok := old like org_a || '/logo/%.jpg' and not exists (select 1 from public.org_branding b where b.org_id = org_a);
  execute 'reset role';
  ok := ok and not has_table_privilege('authenticated', 'public.org_branding', 'select') and not has_table_privilege('anon', 'public.org_branding', 'select')
    and not has_function_privilege('authenticated', 'public.set_org_branding(uuid, uuid, text, text, text)', 'execute');
  if ok then res := res || E'PASS T716 branding can be switched off (the logo path is handed back for removal); everything is server-only\n';
  else res := res || E'FAIL T716 clear and privileges\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
