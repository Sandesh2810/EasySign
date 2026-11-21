-- YouNMeSign SQL tests for Phase 5 slice 6: languages (D-95). Self-contained; one transaction; always rolled back.
do $test$
declare
  res text := '';
  a uuid := gen_random_uuid(); org_a uuid; e uuid; r1 uuid; r2 uuid;
  tok uuid := gen_random_uuid(); old_tok uuid := gen_random_uuid(); n int; ok boolean;
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't57-a@example.test', now(), '{"provider":"email"}', '{"full_name":"Lia Lang"}', now(), now());
  select m.org_id into org_a from public.memberships m where m.user_id = a and m.role = 'owner';
  execute 'set local role service_role';
  select x.id into e from public.create_envelope(a, org_a, 'Languages', null) x;
  select x.id into r1 from public.save_recipients(a, e, '[{"name":"Ana","email":"t57-ana@example.test","role":"signer","routing_order":1},{"name":"Bo","email":"t57-bo@example.test","role":"signer","routing_order":2}]'::jsonb) x where x.email = 't57-ana@example.test';
  select r.id into r2 from public.recipients r where r.envelope_id = e and r.email = 't57-bo@example.test';
  execute 'reset role';
  insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
  values (tok, org_a, e, r1, decode(repeat('01', 16), 'hex'), decode(repeat('a1', 32), 'hex'), now() + interval '1 day'),
         (old_tok, org_a, e, r2, decode(repeat('02', 16), 'hex'), decode(repeat('a2', 32), 'hex'), now() + interval '1 day');
  update public.recipient_tokens k set revoked_at = now() where k.id = old_tok;
  execute 'set local role service_role';

  -- T771: a live link sets its own person's language (and only theirs); a revoked or unknown link changes nothing
  perform public.signer_set_locale(tok, 'ar');
  perform public.signer_set_locale(old_tok, 'es');
  perform public.signer_set_locale(gen_random_uuid(), 'es');
  ok := (select r.locale from public.recipients r where r.id = r1) = 'ar' and (select r.locale from public.recipients r where r.id = r2) is null;
  perform public.signer_set_locale(tok, 'hi');
  ok := ok and (select r.locale from public.recipients r where r.id = r1) = 'hi';
  if ok then res := res || E'PASS T771 a live signing link stores its own person''s language; a revoked or unknown link changes nothing\n';
  else res := res || E'FAIL T771 set\n'; end if;

  -- T772: only the four languages; nobody can call it from the browser
  n := 0;
  begin perform public.signer_set_locale(tok, 'fr'); n := n + 1; exception when invalid_parameter_value then null; end;
  begin perform public.signer_set_locale(tok, null); n := n + 1; exception when invalid_parameter_value then null; end;
  execute 'reset role';
  begin update public.recipients set locale = 'xx' where id = r1; n := n + 1; exception when check_violation or insufficient_privilege then null; end;
  ok := n = 0 and not has_function_privilege('authenticated', 'public.signer_set_locale(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.signer_set_locale(uuid, text)', 'execute');
  if ok then res := res || E'PASS T772 only English, Spanish, Hindi and Arabic are accepted; not callable from the browser\n';
  else res := res || 'FAIL T772 checks :: n=' || n || E'\n'; end if;

  raise exception E'RLS_TEST_RESULTS\nSUMMARY passed=% failed=%\nFAILED: %\n%',
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'PASS %'),
    (select count(*) from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'),
    coalesce((select string_agg(l, ' || ') from unnest(string_to_array(res, E'\n')) l where l like 'FAIL %'), 'none'),
    res;
end
$test$;
