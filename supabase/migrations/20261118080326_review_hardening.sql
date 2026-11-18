-- EasySign Phase 1 / migration 8: hardening after the independent review of the send/sign/seal slice.
-- Each function is replaced in full; signatures and grants are unchanged (create or replace keeps them).
--  - Drafts: the envelope row is locked while it is edited or sent, so a save cannot land after "send".
--  - Signers: the signer's row is locked for every step, so steps cannot overlap or repeat.
--  - "Date signed", name and email are always filled in by the system; the signing date must be today.
--  - Bounded growth: unchanged values write nothing; at most 12 signature images per signer.
--  - Stuck work is failed or dropped instead of being retried for ever.
--  - Sending requires the sender's limits row (and locks it while the daily caps are checked).
--  - Revealing a signing link is checked in the database and written to the audit trail.

create or replace function app_private.require_draft(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.is_member_of(p_actor, v_env.org_id, 'member') then
    -- same answer for "does not exist" and "not yours": no probing for ids
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status <> 'draft' then
    raise exception 'ES_NOT_DRAFT: this document has already been sent and can no longer be edited' using errcode = '42501';
  end if;
  return v_env;
end
$$;

create or replace function app_private.require_signer(p_token_id uuid) returns public.recipients
language plpgsql security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_rcp public.recipients;
  v_status text;
begin
  select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
  if not found or v_tok.revoked_at is not null or v_tok.expires_at <= now() then
    raise exception 'ES_LINK_INVALID: this link is no longer valid' using errcode = '42501';
  end if;
  -- Row lock: everything one signer does through one link runs one step at a time, and the checks
  -- below see the committed result of the previous step (no double "Adopt and Sign").
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress') then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
  end if;
  return v_rcp;
end
$$;

create or replace function public.signer_open(p_token_sha256 text, p_ip inet, p_user_agent text)
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
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
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

create or replace function public.signer_fill_field(p_token_id uuid, p_field_id uuid, p_value text, p_ip inet, p_user_agent text) returns void
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
  if v_type is null or v_type not in ('company', 'title', 'text') then
    raise exception 'ES_FIELD_INVALID: that field cannot be filled in' using errcode = '42501';
  end if;
  if coalesce((select v.value_text from public.field_values v where v.field_id = p_field_id), '') = v_value then
    return; -- unchanged: nothing to store, nothing to log
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

create or replace function public.signer_adopt_signature(
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
  if (select count(*) from public.signature_assets a where a.recipient_id = v_rcp.id) >= 12 then
    raise exception 'ES_TOO_MANY: you have changed your signature too many times. Use the one you have, or ask the sender for a new link' using errcode = '53400';
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

create or replace function public.signer_complete(p_token_id uuid, p_intent_text_sha256 text, p_local_date text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_sig uuid;
  v_ini uuid;
  v_n int;
  v_stamps int := 0;
  v_date date;
  f public.fields;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  if p_local_date !~ '^\d{4}-\d{2}-\d{2}$' or p_intent_text_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid completion data' using errcode = '22023';
  end if;
  begin
    v_date := p_local_date::date;
  exception when others then
    raise exception 'invalid completion data' using errcode = '22023';
  end;
  if abs(v_date - app_private.utc_day()) > 1 then
    raise exception 'ES_DATE: the date on your device looks wrong. Check its clock and try again' using errcode = '22023';
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
           case x.type when 'date_signed' then to_char(v_date, 'YYYY-MM-DD') when 'name' then v_rcp.name else v_rcp.email end
      from public.fields x where x.recipient_id = v_rcp.id and x.type in ('date_signed', 'name', 'email')
    on conflict (field_id) do update set value_text = excluded.value_text, filled_at = now();

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

create or replace function public.claim_seal_job(p_lease_seconds int default 300)
returns table (envelope_id uuid, attempt_id uuid, attempts int, audit_seq int, audit_hash text)
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.seal_jobs;
  v_org uuid;
  v_e public.envelopes;
  v_ev public.audit_events;
begin
  for v_job in select * from public.seal_jobs j
                where j.status = 'running' and j.attempts >= 5 and j.locked_until <= now() for update skip locked loop
    select * into v_e from public.envelopes e where e.id = v_job.envelope_id;
    update public.seal_jobs j set status = 'failed', locked_until = null, updated_at = now(),
           last_error = coalesce(j.last_error, 'the worker stopped while sealing') where j.envelope_id = v_job.envelope_id;
    perform app_private.sanction();
    update public.envelopes e set status = 'failed_sealing' where e.id = v_job.envelope_id and e.status = 'in_progress';
    perform set_config('easysign.sanctioned', '', true);
    perform app_private.audit_append('env:' || v_job.envelope_id::text, v_e.org_id, v_job.envelope_id, null, 'system', null, 'sealing_failed',
      jsonb_build_object('attempt', v_job.attempts, 'error', 'the worker stopped while sealing'));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_e.org_id, v_e.sender_id, 'sealing_failed', jsonb_build_object('envelope_id', v_job.envelope_id, 'title', v_e.title));
  end loop;
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

create or replace function public.claim_outbox(p_limit int default 10, p_lease_seconds int default 120) returns setof public.notification_outbox
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_outbox o set status = 'dead', locked_until = null,
         last_error = coalesce(o.last_error, 'gave up after repeated interrupted attempts')
   where o.status = 'sending' and o.locked_until <= now() and o.attempts >= 6;
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

create or replace function public.send_envelope(p_actor uuid, p_envelope_id uuid, p_tokens jsonb, p_expires_at timestamptz, p_delivery text default 'email')
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

  select * into v_ctl from public.account_controls c where c.user_id = p_actor for update;
  if not found then
    raise exception 'ES_ACCOUNT: your account is not ready to send yet. Sign out, sign in again and retry' using errcode = '42501';
  end if;
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

create function public.reveal_signing_links(p_actor uuid, p_envelope_id uuid)
returns table (token_id uuid, nonce_hex text, recipient_name text)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  if not found or not app_private.is_member_of(p_actor, v_env.org_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open for signing' using errcode = '42501';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'link_revealed',
    jsonb_build_object('recipients', (select coalesce(jsonb_agg(k.recipient_id order by k.created_at), '[]'::jsonb)
                                        from public.recipient_tokens k where k.envelope_id = p_envelope_id and k.revoked_at is null)));
  return query
    select k.id, encode(k.nonce, 'hex'), x.name
      from public.recipient_tokens k join public.recipients x on x.id = k.recipient_id
     where k.envelope_id = p_envelope_id and k.revoked_at is null
     order by x.routing_order;
end
$$;

revoke all on function public.reveal_signing_links(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reveal_signing_links(uuid, uuid) to service_role;

-- down (manual): re-run the function definitions from migrations 6 and 7, then
-- drop function if exists public.reveal_signing_links(uuid, uuid);
