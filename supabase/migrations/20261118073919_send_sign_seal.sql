-- EasySign Phase 1 / migration 7: sending, signing, sealing, the outbox and the email budget counters.
-- All functions are server-only (service role). Signers are identified by the id of their link token,
-- which the server obtained by verifying the link or the signed session cookie (D-21, D-23).
-- Down script at the bottom (commented).

create function app_private.user_email(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = p_user
$$;

create function app_private.utc_day() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'UTC')::date $$;

-- ---------------------------------------------------------------- send
-- p_tokens: [{recipient_id, token_id, nonce (hex), token_sha256 (hex)}], one per signer. The server
-- derives each link from its own key; the database never sees a link, only the SHA-256 of one.
create function public.send_envelope(p_actor uuid, p_envelope_id uuid, p_tokens jsonb, p_expires_at timestamptz, p_delivery text default 'email')
returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_doc public.envelope_documents;
  v_ctl public.account_controls;
  v_mode text;
  v_sender_email text;
  v_ext text[];
  v_ext_count int;
  v_signers int;
  v_day date := app_private.utc_day();
  v_sent int;
  v_rcp_today int;
  v_new int;
  v_layout text;
  t jsonb;
  r public.recipients;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if p_delivery not in ('email', 'link') then
    raise exception 'invalid delivery' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= now() + interval '1 hour' or p_expires_at > now() + interval '120 days' then
    raise exception 'invalid expiry' using errcode = '22023';
  end if;
  select * into v_doc from public.envelope_documents d where d.envelope_id = p_envelope_id order by d.position limit 1;
  if not found then
    raise exception 'ES_NO_DOCUMENT: upload a document first' using errcode = '22023';
  end if;
  select count(*) into v_signers from public.recipients x where x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person');
  if v_signers = 0 then
    raise exception 'ES_NO_SIGNER: add the signer first' using errcode = '22023';
  end if;
  if exists (select 1 from public.recipients x where x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person')
             and not exists (select 1 from public.fields f where f.recipient_id = x.id and f.type = 'signature')) then
    raise exception 'ES_NO_SIGNATURE_FIELD: place at least one signature field for the signer' using errcode = '22023';
  end if;

  v_sender_email := coalesce(app_private.user_email(p_actor), '');
  select array_agg(distinct lower(x.email)) into v_ext from public.recipients x
   where x.envelope_id = p_envelope_id and lower(x.email) <> v_sender_email;
  v_ext_count := coalesce(array_length(v_ext, 1), 0);

  select * into v_ctl from public.account_controls c where c.user_id = p_actor;
  select s.value #>> '{}' into v_mode from public.platform_settings s where s.key = 'registration_mode';
  if v_ext_count > 0 and coalesce(v_mode, 'open') <> 'open' and not v_ctl.approved then
    raise exception 'ES_PENDING_APPROVAL: your account is waiting for approval. Until then you can sign documents yourself, but not send them to other people' using errcode = '42501';
  end if;
  if v_ctl.trust_level = 'restricted' then
    select u.envelopes_sent into v_sent from public.usage_counters u where u.day = v_day and u.user_id = p_actor;
    if coalesce(v_sent, 0) >= v_ctl.daily_envelope_cap then
      raise exception 'ES_ENVELOPE_CAP: new accounts can send % documents a day. Try again tomorrow', v_ctl.daily_envelope_cap using errcode = '53400';
    end if;
    select count(*) into v_rcp_today from public.usage_recipients u where u.day = v_day and u.user_id = p_actor;
    select count(*) into v_new from unnest(coalesce(v_ext, '{}'::text[])) e
     where not exists (select 1 from public.usage_recipients u where u.day = v_day and u.user_id = p_actor and u.email_hash = sha256(convert_to(e, 'UTF8')));
    if v_rcp_today + v_new > v_ctl.daily_recipient_cap then
      raise exception 'ES_RECIPIENT_CAP: new accounts can send to % different people a day. Try again tomorrow', v_ctl.daily_recipient_cap using errcode = '53400';
    end if;
  end if;

  if jsonb_typeof(p_tokens) <> 'array' or jsonb_array_length(p_tokens) <> v_signers then
    raise exception 'token list does not match the signers' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p_tokens) loop
    if not exists (select 1 from public.recipients x where x.id = (t ->> 'recipient_id')::uuid and x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person')) then
      raise exception 'token for an unknown signer' using errcode = '22023';
    end if;
    insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
      values ((t ->> 'token_id')::uuid, v_env.org_id, p_envelope_id, (t ->> 'recipient_id')::uuid,
              decode(t ->> 'nonce', 'hex'), decode(t ->> 'token_sha256', 'hex'), p_expires_at);
  end loop;

  v_layout := app_private.field_layout_hash(p_envelope_id);
  perform app_private.sanction();
  update public.envelopes e
     set status = 'sent', sent_at = now(), expires_at = p_expires_at, self_sign = (v_ext_count = 0), field_layout_sha256 = v_layout
   where e.id = p_envelope_id returning * into v_env;
  update public.recipients x set status = 'sent', sent_at = now() where x.envelope_id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);

  insert into public.usage_counters as u (day, user_id, envelopes_sent) values (v_day, p_actor, 1)
    on conflict (day, user_id) do update set envelopes_sent = u.envelopes_sent + 1;
  insert into public.usage_recipients (day, user_id, email_hash)
    select v_day, p_actor, sha256(convert_to(e, 'UTF8')) from unnest(coalesce(v_ext, '{}'::text[])) e
    on conflict do nothing;

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'envelope_sent',
    jsonb_build_object('delivery', p_delivery, 'expires_at', p_expires_at, 'document_sha256', v_doc.sha256, 'layout_sha256', v_layout,
      'recipients', (select jsonb_agg(jsonb_build_object('id', x.id, 'role', x.role, 'order', x.routing_order, 'is_sender', x.is_sender) order by x.routing_order)
                       from public.recipients x where x.envelope_id = p_envelope_id)));

  if p_delivery = 'email' then
    for r in select * from public.recipients x where x.envelope_id = p_envelope_id and lower(x.email) <> v_sender_email loop
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, r.id, p_actor, 'signature_request', 'P0_REQUEST', 'request:' || r.id::text || ':1');
      perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, r.id, 'system', null, 'email_queued',
        jsonb_build_object('kind', 'signature_request'));
    end loop;
  end if;
  return v_env;
end
$$;

-- ---------------------------------------------------------------- signer
-- The signer may act only while their link is live, the envelope is open and they have not finished.
create function app_private.require_signer(p_token_id uuid) returns public.recipients
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_rcp public.recipients;
  v_status text;
begin
  select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
  if not found or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
    raise exception 'ES_LINK_INVALID: this link is no longer valid' using errcode = '42501';
  end if;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress') then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
  end if;
  return v_rcp;
end
$$;

-- Exchange of the link for a session. Returns no row for anything that is not a live link.
create function public.signer_open(p_token_sha256 text, p_ip inet, p_user_agent text)
returns table (token_id uuid, recipient_id uuid, envelope_id uuid, recipient_status text, envelope_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_env public.envelopes;
  v_rcp public.recipients;
begin
  if p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into v_tok from public.recipient_tokens k where k.token_sha256 = decode(p_token_sha256, 'hex');
  if not found then
    return;
  end if;
  select * into v_env from public.envelopes e where e.id = v_tok.envelope_id;
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id;
  if v_tok.revoked_at is not null or v_tok.expires_at <= now() or v_env.status not in ('sent', 'in_progress', 'completed') then
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'token_failed',
      jsonb_build_object('reason', case when v_tok.revoked_at is not null then 'revoked' when v_tok.expires_at <= now() then 'expired' else 'closed' end),
      p_ip, p_user_agent);
    return;
  end if;
  if v_rcp.status = 'sent' then
    perform app_private.sanction();
    update public.recipients x set status = 'viewed', viewed_at = now() where x.id = v_rcp.id returning * into v_rcp;
    update public.envelopes e set status = 'in_progress' where e.id = v_env.id and e.status = 'sent' returning * into v_env;
    perform set_config('easysign.sanctioned', '', true);
    if v_env.id is null then
      select * into v_env from public.envelopes e where e.id = v_tok.envelope_id;
    end if;
  end if;
  perform app_private.audit_append('env:' || v_tok.envelope_id::text, v_tok.org_id, v_tok.envelope_id, v_rcp.id, 'signer', null, 'link_opened', '{}'::jsonb, p_ip, p_user_agent);
  return query select v_tok.id, v_rcp.id, v_tok.envelope_id, v_rcp.status, (select e.status from public.envelopes e where e.id = v_tok.envelope_id);
end
$$;

create function public.signer_consent(p_token_id uuid, p_version text, p_disclosure_sha256 text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
begin
  v_rcp := app_private.require_signer(p_token_id);
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id;
  if v_rcp.status = 'consented' then
    return;
  end if;
  insert into public.consents (org_id, envelope_id, recipient_id, disclosure_version, disclosure_sha256, ip, user_agent)
    values (v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, p_version, p_disclosure_sha256, p_ip, left(p_user_agent, 500));
  perform app_private.sanction();
  update public.recipients x set status = 'consented', consented_at = now() where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'consent_given',
    jsonb_build_object('version', p_version, 'disclosure_sha256', p_disclosure_sha256, 'layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1)),
    p_ip, p_user_agent);
end
$$;

-- Typed values (text, name, company, ...). Signature and initials fields are filled at completion.
create function public.signer_fill_field(p_token_id uuid, p_field_id uuid, p_value text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_type text;
  v_value text := left(btrim(coalesce(p_value, '')), 500);
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  select f.type into v_type from public.fields f where f.id = p_field_id and f.recipient_id = v_rcp.id;
  if v_type is null or v_type in ('signature', 'initials') then
    raise exception 'ES_FIELD_INVALID: that field cannot be filled in' using errcode = '42501';
  end if;
  if v_value = '' then
    delete from public.field_values v where v.field_id = p_field_id;
  else
    insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, value_text)
      values (p_field_id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, v_value)
      on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();
  end if;
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'field_filled',
    jsonb_build_object('field_id', p_field_id, 'type', v_type, 'value_sha256', encode(sha256(convert_to(v_value, 'UTF8')), 'hex')), p_ip, p_user_agent);
end
$$;

create function public.signer_adopt_signature(
  p_token_id uuid, p_kind text, p_method text, p_storage_backend text, p_storage_path text, p_sha256 text,
  p_typed_text text, p_typed_font text, p_ip inet, p_user_agent text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_id uuid;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  if p_storage_path not like v_rcp.org_id::text || '/' || v_rcp.envelope_id::text || '/%' then
    raise exception 'storage path does not belong to this envelope' using errcode = '42501';
  end if;
  insert into public.signature_assets (org_id, recipient_id, kind, method, storage_backend, storage_path, sha256, typed_text, typed_font)
    values (v_rcp.org_id, v_rcp.id, p_kind, p_method, p_storage_backend, p_storage_path, p_sha256, p_typed_text, p_typed_font)
    returning id into v_id;
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'signature_adopted',
    jsonb_build_object('kind', p_kind, 'method', p_method, 'sha256', p_sha256), p_ip, p_user_agent);
  return v_id;
end
$$;

-- "Adopt and Sign": applies the adopted signature/initials to every such field, numbers each stamp,
-- fills date/name/email fields that were left blank, and queues sealing when everyone has signed.
create function public.signer_complete(p_token_id uuid, p_intent_text_sha256 text, p_local_date text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_sig uuid;
  v_ini uuid;
  v_n int;
  v_stamps int := 0;
  f public.fields;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  if p_local_date !~ '^\d{4}-\d{2}-\d{2}$' or p_intent_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid completion data' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;

  select a.id into v_sig from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'signature' order by a.created_at desc limit 1;
  select a.id into v_ini from public.signature_assets a where a.recipient_id = v_rcp.id and a.kind = 'initials' order by a.created_at desc limit 1;
  if v_sig is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'signature') then
    raise exception 'ES_SIGNATURE_MISSING: create your signature first' using errcode = '22023';
  end if;
  if v_ini is null and exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.type = 'initials') then
    raise exception 'ES_INITIALS_MISSING: create your initials first' using errcode = '22023';
  end if;

  -- convenience fills for fields the signer left blank
  insert into public.field_values (field_id, org_id, envelope_id, recipient_id, value_text)
    select x.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id,
           case x.type when 'date_signed' then p_local_date when 'name' then v_rcp.name else v_rcp.email end
      from public.fields x where x.recipient_id = v_rcp.id and x.type in ('date_signed', 'name', 'email')
    on conflict (field_id) do nothing;

  if exists (select 1 from public.fields x where x.recipient_id = v_rcp.id and x.required and x.type not in ('signature', 'initials')
             and not exists (select 1 from public.field_values v where v.field_id = x.id)) then
    raise exception 'ES_FIELDS_MISSING: some required fields are still empty' using errcode = '22023';
  end if;

  select count(*) into v_n from public.field_values v where v.envelope_id = v_rcp.envelope_id and v.signature_id is not null;
  for f in select * from public.fields x where x.recipient_id = v_rcp.id and x.type in ('signature', 'initials') order by x.page, x.y, x.x loop
    v_n := v_n + 1;
    v_stamps := v_stamps + 1;
    insert into public.field_values as v (field_id, org_id, envelope_id, recipient_id, signature_asset_id, signature_id)
      values (f.id, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, case f.type when 'signature' then v_sig else v_ini end, v_env.public_code || '-S' || v_n)
      on conflict (field_id) do update set signature_asset_id = excluded.signature_asset_id, signature_id = excluded.signature_id, filled_at = now();
  end loop;

  perform app_private.sanction();
  update public.recipients x set status = 'signed', completed_at = now() where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'recipient_signed',
    jsonb_build_object('stamps', v_stamps, 'intent_text_sha256', p_intent_text_sha256, 'layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1)),
    p_ip, p_user_agent);

  if not exists (select 1 from public.recipients x where x.envelope_id = v_rcp.envelope_id and x.role in ('signer', 'in_person', 'approver') and x.status not in ('signed', 'approved')) then
    insert into public.seal_jobs (envelope_id) values (v_rcp.envelope_id) on conflict (envelope_id) do nothing;
    perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, null, 'system', null, 'routing_advanced',
      jsonb_build_object('next', 'sealing'));
    return 'sealing';
  end if;
  return 'waiting';
end
$$;

-- ---------------------------------------------------------------- sealing
create function public.claim_seal_job(p_lease_seconds int default 300)
returns table (envelope_id uuid, attempt_id uuid, attempts int, audit_seq int, audit_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.seal_jobs;
  v_org uuid;
  v_ev public.audit_events;
begin
  select * into v_job from public.seal_jobs j
   where j.attempts < 5 and (j.locked_until is null or j.locked_until <= now()) and j.status in ('queued', 'running')
   order by j.created_at for update skip locked limit 1;
  if not found then
    return;
  end if;
  update public.seal_jobs j set status = 'running', attempt_id = gen_random_uuid(), attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   where j.envelope_id = v_job.envelope_id returning * into v_job;
  select e.org_id into v_org from public.envelopes e where e.id = v_job.envelope_id;
  v_ev := app_private.audit_append('env:' || v_job.envelope_id::text, v_org, v_job.envelope_id, null, 'system', null, 'sealing_started',
    jsonb_build_object('attempt', v_job.attempts));
  return query select v_job.envelope_id, v_job.attempt_id, v_job.attempts, v_ev.chain_seq, encode(v_ev.event_hash, 'hex');
end
$$;

-- Fenced by attempt id: a worker whose lease was taken over cannot finalise. Returns false in that case.
create function public.complete_seal_job(
  p_envelope_id uuid, p_attempt_id uuid, p_preseal_sha256 text, p_final_sha256 text, p_storage_backend text,
  p_sealed_path text, p_certificate_path text, p_audit_seq int, p_audit_hash text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.seal_jobs;
  v_env public.envelopes;
  v_sender_email text;
  r public.recipients;
begin
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
         audit_seal_seq = p_audit_seq, audit_seal_hash = p_audit_hash
   where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
  update public.seal_jobs j set status = 'done', locked_until = null, last_error = null, updated_at = now() where j.envelope_id = p_envelope_id;

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'system', null, 'sealing_completed',
    jsonb_build_object('final_sha256', p_final_sha256, 'preseal_sha256', p_preseal_sha256, 'checkpoint_seq', p_audit_seq));

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

create function public.fail_seal_job(p_envelope_id uuid, p_attempt_id uuid, p_error text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.seal_jobs;
  v_env public.envelopes;
begin
  select * into v_job from public.seal_jobs j where j.envelope_id = p_envelope_id for update;
  if not found or v_job.status <> 'running' or v_job.attempt_id is distinct from p_attempt_id then
    return 'ignored';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'system', null, 'sealing_failed',
    jsonb_build_object('attempt', v_job.attempts, 'error', left(coalesce(p_error, ''), 300)));
  if v_job.attempts >= 5 then
    update public.seal_jobs j set status = 'failed', locked_until = null, last_error = left(p_error, 1000), updated_at = now() where j.envelope_id = p_envelope_id;
    perform app_private.sanction();
    update public.envelopes e set status = 'failed_sealing' where e.id = p_envelope_id and e.status = 'in_progress';
    perform set_config('easysign.sanctioned', '', true);
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_env.org_id, v_env.sender_id, 'sealing_failed', jsonb_build_object('envelope_id', p_envelope_id, 'title', v_env.title));
    return 'failed';
  end if;
  update public.seal_jobs j set status = 'queued', last_error = left(p_error, 1000), updated_at = now(),
         locked_until = now() + make_interval(secs => 30 * (2 ^ v_job.attempts)::int)
   where j.envelope_id = p_envelope_id;
  return 'retry';
end
$$;

-- ---------------------------------------------------------------- outbox
create function public.claim_outbox(p_limit int default 10, p_lease_seconds int default 120) returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
  return query
    update public.notification_outbox o
       set status = 'sending', attempts = o.attempts + 1, locked_until = now() + make_interval(secs => p_lease_seconds)
     where o.id in (
       select q.id from public.notification_outbox q
        where q.not_before <= now()
          and (q.status in ('queued', 'deferred') or (q.status = 'sending' and q.locked_until <= now()))
        order by case q.priority when 'P0_AUTH' then 0 when 'P0_REQUEST' then 1 when 'P1' then 2 when 'P2' then 3 else 4 end, q.created_at
        for update skip locked limit greatest(1, least(p_limit, 50)))
    returning o.*;
end
$$;

-- p_outcome: sent | deferred (budget) | failed (provider error; retried with backoff, dead after 5 attempts)
create function public.finish_outbox(p_id uuid, p_outcome text, p_not_before timestamptz, p_provider_message_id text, p_error text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.notification_outbox;
  v_result text;
begin
  select * into v_row from public.notification_outbox o where o.id = p_id for update;
  if not found or v_row.status <> 'sending' then
    return 'ignored';
  end if;
  if p_outcome = 'sent' then
    update public.notification_outbox o set status = 'sent', sent_at = now(), locked_until = null, provider_message_id = p_provider_message_id, last_error = null where o.id = p_id;
    v_result := 'sent';
  elsif p_outcome = 'deferred' then
    update public.notification_outbox o set status = 'deferred', locked_until = null, attempts = greatest(o.attempts - 1, 0),
           not_before = coalesce(p_not_before, now() + interval '1 hour'), last_error = left(p_error, 500) where o.id = p_id;
    v_result := 'deferred';
  elsif v_row.attempts >= 5 then
    update public.notification_outbox o set status = 'dead', locked_until = null, last_error = left(p_error, 500) where o.id = p_id;
    if v_row.sender_user_id is not null then
      insert into public.notifications (org_id, user_id, kind, payload)
        values (v_row.org_id, v_row.sender_user_id, 'email_failed', jsonb_build_object('envelope_id', v_row.envelope_id, 'kind', v_row.kind));
    end if;
    v_result := 'failed';
  else
    update public.notification_outbox o set status = 'queued', locked_until = null, last_error = left(p_error, 500),
           not_before = now() + make_interval(secs => 60 * (2 ^ v_row.attempts)::int) where o.id = p_id;
    v_result := 'retry';
  end if;
  if v_row.envelope_id is not null and v_result in ('sent', 'deferred', 'failed') then
    perform app_private.audit_append('env:' || v_row.envelope_id::text, v_row.org_id, v_row.envelope_id, v_row.recipient_id, 'system', null,
      'email_' || v_result, jsonb_build_object('kind', v_row.kind, 'outbox_id', v_row.id));
  end if;
  return v_result;
end
$$;

-- ---------------------------------------------------------------- email budget counters (UTC day)
create function public.email_budget_state(p_user uuid)
returns table (sent_today_auth int, sent_today_shared int, restricted_sent_today int, provider_closed boolean, sent_month_before_today int, user_sent_today int, days_left_in_month int)
language sql stable security definer set search_path = '' as $$
  select coalesce(b.sent_auth, 0), coalesce(b.sent_shared, 0), coalesce(b.restricted_sent, 0), coalesce(b.provider_closed, false),
         (select coalesce(sum(m.sent_auth + m.sent_shared), 0)::int from public.email_budget m
           where m.day >= date_trunc('month', d.day::timestamp)::date and m.day < d.day),
         (select coalesce(u.sent, 0) from (select 1) one left join public.email_budget_user u on u.day = d.day and u.user_id = p_user),
         ((date_trunc('month', d.day::timestamp) + interval '1 month')::date - d.day)::int
    from (select app_private.utc_day() as day) d left join public.email_budget b on b.day = d.day
$$;

create function public.email_budget_record(p_class text, p_user uuid, p_restricted boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := app_private.utc_day();
  v_auth int := case when p_class = 'P0_AUTH' then 1 else 0 end;
begin
  if p_class not in ('P0_AUTH', 'P0_REQUEST', 'P1', 'P2', 'P3') then
    raise exception 'invalid email class' using errcode = '22023';
  end if;
  insert into public.email_budget as b (day, sent_auth, sent_shared, restricted_sent)
    values (v_day, v_auth, 1 - v_auth, case when p_restricted and v_auth = 0 then 1 else 0 end)
    on conflict (day) do update set sent_auth = b.sent_auth + excluded.sent_auth, sent_shared = b.sent_shared + excluded.sent_shared,
      restricted_sent = b.restricted_sent + excluded.restricted_sent;
  if p_user is not null and v_auth = 0 then
    insert into public.email_budget_user as u (day, user_id, sent) values (v_day, p_user, 1)
      on conflict (day, user_id) do update set sent = u.sent + 1;
  end if;
end
$$;

create function public.email_budget_close_day() returns void
language sql security definer set search_path = '' as $$
  insert into public.email_budget as b (day, provider_closed) values (app_private.utc_day(), true)
    on conflict (day) do update set provider_closed = true
$$;

create function public.storage_usage_bytes() returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint from storage.objects o
$$;

-- grants: service role only
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.send_envelope(uuid, uuid, jsonb, timestamptz, text)',
    'public.signer_open(text, inet, text)',
    'public.signer_consent(uuid, text, text, inet, text)',
    'public.signer_fill_field(uuid, uuid, text, inet, text)',
    'public.signer_adopt_signature(uuid, text, text, text, text, text, text, text, inet, text)',
    'public.signer_complete(uuid, text, text, inet, text)',
    'public.claim_seal_job(int)',
    'public.complete_seal_job(uuid, uuid, text, text, text, text, text, int, text)',
    'public.fail_seal_job(uuid, uuid, text)',
    'public.claim_outbox(int, int)',
    'public.finish_outbox(uuid, text, timestamptz, text, text)',
    'public.email_budget_state(uuid)',
    'public.email_budget_record(text, uuid, boolean)',
    'public.email_budget_close_day()',
    'public.storage_usage_bytes()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual): drop each function listed in the grants block above, then
-- drop function if exists app_private.require_signer(uuid), app_private.utc_day(), app_private.user_email(uuid);
