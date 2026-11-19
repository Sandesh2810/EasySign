-- YouNMeSign (EasySign) Phase 3 / migration 20: public verification (slice 2, AT3.2) and the seal key id (slice 1, AT3.1, D-66).
-- 1. envelopes.seal_key_id: SHA-256 of the seal certificate that signed the sealed file.
-- 2. complete_seal_job takes the key id (optional, so existing callers keep working) and writes it to the
--    envelope and to the sealing_completed audit event.
-- 3. verify_lookup: what the public /verify page may show for a verification code. Never names, emails or the
--    title. Rate limited per caller and per code before anything is looked up. Every lookup that finds a
--    document is written to that document's audit trail as verify_page_hit, without the caller's IP or device.
-- All functions are server-only (service role).

alter table public.envelopes add column seal_key_id text check (seal_key_id is null or seal_key_id ~ '^[0-9a-f]{64}$');

drop function public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text);
create function public.complete_seal_job(
  p_envelope_id uuid, p_attempt_id uuid, p_preseal_sha256 text, p_final_sha256 text, p_storage_backend text,
  p_sealed_path text, p_certificate_path text, p_audit_seq int, p_audit_hash text, p_seal_key_id text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.seal_jobs;
  v_env public.envelopes;
  v_sender_email text;
  r public.recipients;
begin
  if p_seal_key_id is not null and p_seal_key_id !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid seal key id' using errcode = '22023';
  end if;
  select * into v_job from public.seal_jobs j where j.envelope_id = p_envelope_id for update;
  if not found or v_job.status <> 'running' or v_job.attempt_id is distinct from p_attempt_id then
    return false;
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if v_env.status not in ('in_progress', 'failed_sealing') then
    return false;
  end if;
  if not exists (select 1 from public.audit_events a where a.chain_key = 'env:' || p_envelope_id::text and a.chain_seq = p_audit_seq
                 and a.event_hash = decode(p_audit_hash, 'hex') and a.event_type = 'sealing_started') then
    raise exception 'audit checkpoint does not match the chain' using errcode = '22023';
  end if;
  if p_sealed_path not like v_env.org_id::text || '/' || p_envelope_id::text || '/%'
     or p_certificate_path not like v_env.org_id::text || '/' || p_envelope_id::text || '/%' then
    raise exception 'storage path does not belong to this envelope' using errcode = '42501';
  end if;

  perform app_private.sanction();
  update public.envelopes e
     set status = 'completed', completed_at = now(), sealed_at = now(), preseal_sha256 = p_preseal_sha256, final_sha256 = p_final_sha256,
         sealed_storage_backend = p_storage_backend, sealed_storage_path = p_sealed_path, certificate_storage_path = p_certificate_path,
         audit_seal_seq = p_audit_seq, audit_seal_hash = p_audit_hash, seal_key_id = p_seal_key_id
   where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
  update public.seal_jobs j set status = 'done', locked_until = null, last_error = null, updated_at = now() where j.envelope_id = p_envelope_id;

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'system', null, 'sealing_completed',
    jsonb_build_object('final_sha256', p_final_sha256, 'preseal_sha256', p_preseal_sha256, 'checkpoint_seq', p_audit_seq, 'seal_key_id', p_seal_key_id));

  -- completion copies: every party (D-28). The sender is told in-app as well.
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');
  for r in select * from public.recipients x where x.envelope_id = p_envelope_id and lower(x.email) <> v_sender_email loop
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
      values (v_env.org_id, p_envelope_id, r.id, v_env.sender_id, 'completion_copy', 'P1', 'done:' || r.id::text)
      on conflict (idempotency_key) do nothing;
  end loop;
  insert into public.notification_outbox (org_id, envelope_id, to_user_id, sender_user_id, kind, priority, idempotency_key)
    values (v_env.org_id, p_envelope_id, v_env.sender_id, v_env.sender_id, 'completion_sender', 'P1', 'done:sender:' || p_envelope_id::text)
    on conflict (idempotency_key) do nothing;
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, 'envelope_completed', jsonb_build_object('envelope_id', p_envelope_id, 'title', v_env.title));
  return true;
end
$$;

-- What anyone holding a verification code may learn. The answer for an unknown code, a draft and a
-- malformed code is the same {"found": false}; "limited" says only that the caller must wait.
create function public.verify_lookup(p_code text, p_caller text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(left(coalesce(p_code, ''), 64));
  v_env public.envelopes;
  v_status text;
  v_done boolean;
  v_signers int;
begin
  if not public.rate_limit_hit('verify_caller', coalesce(nullif(p_caller, ''), 'unknown'), 20, 600) then
    return jsonb_build_object('limited', true);
  end if;
  if not public.rate_limit_hit('verify_code', v_code, 60, 3600) then
    return jsonb_build_object('limited', true);
  end if;
  select * into v_env from public.envelopes e where e.public_code = v_code and e.status <> 'draft';
  if not found then
    return jsonb_build_object('found', false);
  end if;
  v_done := v_env.status = 'completed';
  v_status := case when v_env.status in ('sent', 'in_progress', 'failed_sealing') then 'in_progress' else v_env.status end;
  if v_done then
    select count(*) into v_signers from public.recipients r
     where r.envelope_id = v_env.id and r.role in ('signer', 'in_person') and r.status = 'signed';
  end if;
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'system', null, 'verify_page_hit',
    jsonb_build_object('status', v_status));
  return jsonb_build_object(
    'found', true,
    'code', v_env.public_code,
    'status', v_status,
    'completed_at', case when v_done then v_env.completed_at end,
    'signer_count', v_signers,
    'final_sha256', case when v_done then v_env.final_sha256 end,
    'preseal_sha256', case when v_done then v_env.preseal_sha256 end,
    'seal_key_id', case when v_done then v_env.seal_key_id end);
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text, text)',
    'public.verify_lookup(text, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual):
-- drop function public.verify_lookup(text, text);
-- drop function public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text, text);
--   then re-create the 9-argument complete_seal_job exactly as in 20261118073919_send_sign_seal.sql, with its grants
--   (revoke from public, anon, authenticated; grant execute to service_role);
-- alter table public.envelopes drop column seal_key_id;
