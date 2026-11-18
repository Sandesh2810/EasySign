-- EasySign Phase 2 / migration 11: void, send again, and correct a recipient before completion (AT2.2, AT2.3).
-- All functions are server-only (service role) and take the acting user explicitly (D-35).

alter table public.envelopes add column voided_at timestamptz;
alter table public.envelopes add column void_reason text check (char_length(void_reason) <= 1000);

-- The actor must be a member (not a viewer) of the envelope's workspace, not suspended, and the envelope
-- must still be open: sent or in progress, with sealing not yet queued. Locks the envelope row.
create function app_private.require_open_envelope(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.is_member_of(p_actor, v_env.org_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.account_controls c where c.user_id = p_actor and c.trust_level = 'suspended')
     or exists (select 1 from public.org_controls o where o.org_id = v_env.org_id and o.status = 'suspended') then
    raise exception 'ES_SUSPENDED: account suspended' using errcode = '42501';
  end if;
  if v_env.status = 'completed' then
    raise exception 'ES_COMPLETED: this document is complete and can no longer be changed' using errcode = '42501';
  end if;
  if v_env.status not in ('sent', 'in_progress') then
    raise exception 'ES_NOT_OPEN: this document is not open, so there is nothing to change' using errcode = '42501';
  end if;
  if exists (select 1 from public.seal_jobs j where j.envelope_id = p_envelope_id) then
    raise exception 'ES_SEALING: everyone has finished and the final document is being prepared. It can no longer be changed' using errcode = '42501';
  end if;
  return v_env;
end
$$;

-- Requests that have not gone out yet must not go out once the document is stopped.
create function app_private.cancel_pending_requests(p_envelope_id uuid, p_reason text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  update public.notification_outbox o
     set status = 'dead', locked_until = null, last_error = left(p_reason, 500)
   where o.envelope_id = p_envelope_id and o.status in ('queued', 'deferred')
     and o.kind in ('signature_request', 'approval_request', 'view_notice');
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function public.signer_decline(p_token_id uuid, p_reason text, p_ip inet, p_user_agent text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
begin
  v_rcp := app_private.require_signer(p_token_id);
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;
  if v_env.status not in ('sent', 'in_progress') or exists (select 1 from public.seal_jobs j where j.envelope_id = v_env.id) then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  perform app_private.sanction();
  update public.recipients x set status = 'declined', completed_at = now(), decline_reason = v_reason where x.id = v_rcp.id;
  update public.recipients x set status = 'skipped'
   where x.envelope_id = v_env.id and x.id <> v_rcp.id and x.status in ('created', 'sent', 'viewed', 'consented');
  update public.envelopes e set status = 'declined' where e.id = v_env.id;
  perform set_config('easysign.sanctioned', '', true);
  update public.recipient_tokens k set revoked_at = now() where k.envelope_id = v_env.id and k.revoked_at is null;
  perform app_private.cancel_pending_requests(v_env.id, 'cancelled: the document was declined');

  -- the reason is kept with the recipient; the audit trail holds only its fingerprint
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'recipient_declined',
    jsonb_build_object('role', v_rcp.role, 'reason_given', v_reason is not null,
      'reason_sha256', case when v_reason is null then null else encode(sha256(convert_to(v_reason, 'UTF8')), 'hex') end), p_ip, p_user_agent);
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'system', null, 'envelope_declined',
    jsonb_build_object('by', v_rcp.id, 'links_revoked', true));

  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, 'envelope_declined', jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', v_rcp.name));
  if lower(v_rcp.email) <> coalesce(app_private.user_email(v_env.sender_id), '') then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, to_user_id, sender_user_id, kind, priority, idempotency_key)
      values (v_env.org_id, v_env.id, v_rcp.id, v_env.sender_id, v_env.sender_id, 'declined_sender', 'P1', 'declined:' || v_env.id::text)
      on conflict (idempotency_key) do nothing;
  end if;
end
$$;

-- Void: the sender stops an open document. Every link is revoked in the same statement, people still
-- waiting are marked skipped, unsent requests are cancelled, and people already contacted are told.
create function public.void_envelope(p_actor uuid, p_envelope_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 1000), '');
  v_sender_email text;
  v_revoked int;
  r public.recipients;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');

  -- who has already been contacted (before their status is changed below)
  if v_env.delivery = 'email' then
    for r in select * from public.recipients x
              where x.envelope_id = p_envelope_id and x.role <> 'cc' and x.status in ('sent', 'viewed', 'consented', 'signed', 'approved')
                and lower(x.email) <> v_sender_email loop
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, r.id, v_env.sender_id, 'voided_notice', 'P2', 'voided:' || r.id::text)
        on conflict (idempotency_key) do nothing;
    end loop;
  end if;

  perform app_private.sanction();
  update public.recipients x set status = 'skipped'
   where x.envelope_id = p_envelope_id and x.status in ('created', 'sent', 'viewed', 'consented');
  update public.envelopes e set status = 'voided', voided_at = now(), void_reason = v_reason where e.id = p_envelope_id;
  perform set_config('easysign.sanctioned', '', true);
  update public.recipient_tokens k set revoked_at = now() where k.envelope_id = p_envelope_id and k.revoked_at is null;
  get diagnostics v_revoked = row_count;
  perform app_private.cancel_pending_requests(p_envelope_id, 'cancelled: the document was voided');

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'envelope_voided',
    jsonb_build_object('links_revoked', v_revoked, 'reason_given', v_reason is not null,
      'reason_sha256', case when v_reason is null then null else encode(sha256(convert_to(v_reason, 'UTF8')), 'hex') end));
end
$$;

-- Send the request again to someone whose turn it is. Same link as before. Limited so it cannot be used to pester.
create function public.resend_request(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_count int;
  v_last timestamptz;
  v_kind text;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id;
  if not found or v_rcp.role = 'cc' then
    raise exception 'ES_NOT_FOUND: that person is not waiting for a link on this document' using errcode = '42501';
  end if;
  if v_env.delivery <> 'email' then
    raise exception 'ES_LINK_DELIVERY: you chose to share the links yourself for this document. Copy the person''s link again instead' using errcode = '22023';
  end if;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_NOT_THEIR_TURN: a request can be sent again only to someone whose turn it is and who has not finished' using errcode = '22023';
  end if;
  if lower(v_rcp.email) = coalesce(app_private.user_email(v_env.sender_id), '') then
    raise exception 'ES_SELF: this person is you. Open your own signing link instead' using errcode = '22023';
  end if;
  select count(*), max(o.created_at) into v_count, v_last from public.notification_outbox o
   where o.recipient_id = p_recipient_id and o.kind in ('signature_request', 'approval_request', 'view_notice');
  if v_last is not null and v_last > now() - interval '10 minutes' then
    raise exception 'ES_TOO_SOON: a request went to this person a few minutes ago. Wait ten minutes before sending another' using errcode = '53400';
  end if;
  if v_count >= 6 then
    raise exception 'ES_RESEND_LIMIT: this person has already been sent the request six times' using errcode = '53400';
  end if;
  v_kind := case v_rcp.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
  insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
    values (v_env.org_id, p_envelope_id, p_recipient_id, p_actor, v_kind, 'P1', 'request:' || p_recipient_id::text || ':' || (v_count + 1)::text);
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'request_resent',
    jsonb_build_object('kind', v_kind, 'number', v_count + 1));
end
$$;

-- Correct a recipient's name or email while the document is open and they have not finished.
-- A changed email means a different mailbox, so: the old link is revoked and a new one issued
-- (p_token: {token_id, nonce (hex), token_sha256 (hex)}; ignored for copy-only recipients), anything the
-- old address had started (viewing, consent, typed values, adopted signature) is undone, and if it is
-- their turn the request goes to the new address. Nobody else's row is touched.
create function public.correct_recipient(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_name text, p_email text, p_token jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_ctl public.account_controls;
  v_mode text;
  v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_sender_email text;
  v_email_changed boolean;
  v_external boolean;
  v_day date := app_private.utc_day();
  v_count int;
  v_kind text;
  v_was_active boolean;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: that person is not on this document' using errcode = '42501';
  end if;
  if v_rcp.status not in ('created', 'sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: this person has already finished, so their details can no longer be changed' using errcode = '42501';
  end if;
  if v_name = '' or char_length(v_name) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'ES_INVALID: enter a name and a valid email address' using errcode = '22023';
  end if;
  v_email_changed := v_email <> lower(v_rcp.email);
  if not v_email_changed and v_name = v_rcp.name then
    return 'unchanged';
  end if;
  if v_email_changed and exists (select 1 from public.recipients x where x.envelope_id = p_envelope_id and x.id <> p_recipient_id
                                   and lower(x.email) = v_email and x.role = v_rcp.role) then
    raise exception 'ES_DUPLICATE: that email address is already on this document with the same role' using errcode = '22023';
  end if;
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');
  v_external := v_email <> v_sender_email;

  if v_email_changed and v_external then
    -- the same account rules as when sending: approval mode and the new-account daily limit on different people
    select * into v_ctl from public.account_controls c where c.user_id = p_actor for update;
    if not found then
      raise exception 'ES_ACCOUNT: your account is not ready to send yet. Sign out, sign in again and retry' using errcode = '42501';
    end if;
    select s.value #>> '{}' into v_mode from public.platform_settings s where s.key = 'registration_mode';
    if coalesce(v_mode, 'open') <> 'open' and not v_ctl.approved then
      raise exception 'ES_PENDING_APPROVAL: your account is waiting for approval. Until then you can sign documents yourself, but not send them to other people' using errcode = '42501';
    end if;
    if v_ctl.trust_level = 'restricted'
       and not exists (select 1 from public.usage_recipients u where u.day = v_day and u.user_id = p_actor and u.email_hash = sha256(convert_to(v_email, 'UTF8')))
       and (select count(*) from public.usage_recipients u where u.day = v_day and u.user_id = p_actor) >= v_ctl.daily_recipient_cap then
      raise exception 'ES_RECIPIENT_CAP: new accounts can send to % different people a day. Try again tomorrow', v_ctl.daily_recipient_cap using errcode = '53400';
    end if;
    insert into public.usage_recipients (day, user_id, email_hash) values (v_day, p_actor, sha256(convert_to(v_email, 'UTF8'))) on conflict do nothing;
  end if;

  v_was_active := v_rcp.status in ('sent', 'viewed', 'consented');
  if v_email_changed then
    -- undo whatever the old address had started; a consent belongs to the person who gave it
    update public.consents c set withdrawn_at = now() where c.recipient_id = p_recipient_id and c.withdrawn_at is null;
    delete from public.field_values v where v.recipient_id = p_recipient_id;
    delete from public.signature_assets a where a.recipient_id = p_recipient_id;
  end if;

  perform app_private.sanction();
  update public.recipients x
     set name = v_name, email = v_email, is_sender = not v_external,
         status = case when v_email_changed and v_was_active then 'sent' else x.status end,
         viewed_at = case when v_email_changed then null else x.viewed_at end,
         consented_at = case when v_email_changed then null else x.consented_at end
   where x.id = p_recipient_id;
  if v_email_changed and v_external and v_env.self_sign then
    update public.envelopes e set self_sign = false where e.id = p_envelope_id;
  end if;
  perform set_config('easysign.sanctioned', '', true);

  if v_email_changed and v_rcp.role <> 'cc' then
    if p_token is null or jsonb_typeof(p_token) <> 'object' then
      raise exception 'a new link record is required when the email changes' using errcode = '22023';
    end if;
    update public.recipient_tokens k set revoked_at = now() where k.recipient_id = p_recipient_id and k.revoked_at is null;
    insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
      values ((p_token ->> 'token_id')::uuid, v_env.org_id, p_envelope_id, p_recipient_id,
              decode(p_token ->> 'nonce', 'hex'), decode(p_token ->> 'token_sha256', 'hex'), v_env.expires_at);
    -- a request still waiting to go to the old address must not go out (other people's requests stay)
    update public.notification_outbox o set status = 'dead', locked_until = null, last_error = 'cancelled: the recipient was corrected'
     where o.recipient_id = p_recipient_id and o.status in ('queued', 'deferred') and o.kind in ('signature_request', 'approval_request', 'view_notice');
    if v_was_active and v_env.delivery = 'email' and v_external then
      select count(*) into v_count from public.notification_outbox o
       where o.recipient_id = p_recipient_id and o.kind in ('signature_request', 'approval_request', 'view_notice');
      v_kind := case v_rcp.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, p_recipient_id, p_actor, v_kind, 'P0_REQUEST', 'request:' || p_recipient_id::text || ':' || (v_count + 1)::text);
    end if;
  end if;

  -- addresses are kept out of the audit trail; their fingerprints are enough to show what changed
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, p_recipient_id, 'user', p_actor, 'recipient_corrected',
    jsonb_build_object('name_changed', v_name <> v_rcp.name, 'email_changed', v_email_changed, 'link_reissued', v_email_changed and v_rcp.role <> 'cc',
      'progress_reset', v_email_changed and v_rcp.status in ('viewed', 'consented'),
      'old_email_sha256', encode(sha256(convert_to(lower(v_rcp.email), 'UTF8')), 'hex'),
      'new_email_sha256', encode(sha256(convert_to(v_email, 'UTF8')), 'hex')));
  return case when v_email_changed then 'email_changed' else 'name_changed' end;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.void_envelope(uuid, uuid, text)',
    'public.resend_request(uuid, uuid, uuid)',
    'public.correct_recipient(uuid, uuid, uuid, text, text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  revoke all on function app_private.require_open_envelope(uuid, uuid), app_private.cancel_pending_requests(uuid, text)
    from public, anon, authenticated, service_role;
end
$$;

-- down (manual): re-run signer_decline from migration 10; then
-- drop function if exists public.correct_recipient(uuid, uuid, uuid, text, text, jsonb), public.resend_request(uuid, uuid, uuid),
--   public.void_envelope(uuid, uuid, text), app_private.cancel_pending_requests(uuid, text), app_private.require_open_envelope(uuid, uuid);
-- alter table public.envelopes drop column void_reason, drop column voided_at;
