-- EasySign Phase 2 / migration 10: several recipients. Turns, approval and decline (DECISIONS D-52).
-- The rules are the ones specified and property-tested in app/src/lib/routing.ts:
--  - signers, in-person signers and approvers must act; copy-only recipients and viewers never hold anything up;
--  - equal order numbers act at the same time; a higher number waits for every acting recipient before it;
--  - a decline stops the document for everyone; when everyone who must act has finished, sealing is queued once;
--  - a valid link used before its turn opens nothing, changes nothing, and is recorded.
-- All functions stay server-only (service role).

alter table public.envelopes add column delivery text not null default 'email' check (delivery in ('email', 'link'));

-- The order number whose turn it is, or null when nobody is left to act.
create function app_private.routing_active_order(p_envelope_id uuid) returns int
language sql stable security definer set search_path = '' as $$
  select min(x.routing_order) from public.recipients x
   where x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person', 'approver') and x.status not in ('signed', 'approved')
$$;

-- Bring into play everyone whose turn has come: acting recipients in the active order, and viewers at or
-- before it. Marks them "sent", records it, and queues their email unless the sender shares links personally.
create function app_private.routing_advance(p_envelope_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_active int;
  v_sender_email text;
  v_count int := 0;
  v_kind text;
  r public.recipients;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id;
  v_active := app_private.routing_active_order(p_envelope_id);
  if v_active is null or v_env.status not in ('sent', 'in_progress') then
    return 0;
  end if;
  v_sender_email := coalesce(app_private.user_email(v_env.sender_id), '');
  for r in select * from public.recipients x
            where x.envelope_id = p_envelope_id and x.status = 'created'
              and ((x.role in ('signer', 'in_person', 'approver') and x.routing_order = v_active) or (x.role = 'viewer' and x.routing_order <= v_active))
            order by x.routing_order, x.created_at, x.id
            for update loop
    perform app_private.sanction();
    update public.recipients x set status = 'sent', sent_at = now() where x.id = r.id;
    perform set_config('easysign.sanctioned', '', true);
    v_count := v_count + 1;
    perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, r.id, 'system', null, 'recipient_activated',
      jsonb_build_object('role', r.role, 'order', r.routing_order));
    if v_env.delivery = 'email' and lower(r.email) <> v_sender_email then
      v_kind := case r.role when 'approver' then 'approval_request' when 'viewer' then 'view_notice' else 'signature_request' end;
      insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key)
        values (v_env.org_id, p_envelope_id, r.id, v_env.sender_id, v_kind, case r.role when 'viewer' then 'P2' else 'P0_REQUEST' end, 'request:' || r.id::text || ':1')
        on conflict (idempotency_key) do nothing;
      perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, r.id, 'system', null, 'email_queued',
        jsonb_build_object('kind', v_kind));
    end if;
  end loop;
  return v_count;
end
$$;

-- After someone signs or approves: seal if everyone who must act has finished, otherwise start the next turn.
create function app_private.routing_after_action(p_envelope_id uuid, p_org_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if app_private.routing_active_order(p_envelope_id) is null then
    insert into public.seal_jobs (envelope_id) values (p_envelope_id) on conflict (envelope_id) do nothing;
    perform app_private.audit_append('env:' || p_envelope_id::text, p_org_id, p_envelope_id, null, 'system', null, 'routing_advanced',
      jsonb_build_object('next', 'sealing'));
    return 'sealing';
  end if;
  perform app_private.routing_advance(p_envelope_id);
  return 'waiting';
end
$$;

-- The signer guard, now turn-aware. Only someone who must act, whose turn has come, and who has not finished.
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
  -- Row lock: everything one person does through one link runs one step at a time.
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress') then
    raise exception 'ES_LINK_INVALID: this document is no longer open for signing' using errcode = '42501';
  end if;
  if v_rcp.role not in ('signer', 'in_person', 'approver') then
    raise exception 'ES_NOT_AN_ACTOR: there is nothing for you to sign on this document' using errcode = '42501';
  end if;
  if v_rcp.status = 'created' or v_rcp.routing_order is distinct from app_private.routing_active_order(v_tok.envelope_id) then
    if v_rcp.status in ('signed', 'approved') then
      raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
    end if;
    raise exception 'ES_NOT_YOUR_TURN: it is not your turn yet. You will be told when the document is ready for you' using errcode = '42501';
  end if;
  if v_rcp.status not in ('sent', 'viewed', 'consented') then
    raise exception 'ES_ALREADY_DONE: you have already finished this document' using errcode = '42501';
  end if;
  return v_rcp;
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
  v_linked int;
  v_actors int;
  v_orders int;
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
    raise exception 'ES_NO_SIGNATURE_FIELD: place at least one signature field for each person who signs' using errcode = '22023';
  end if;
  if (select count(*) from public.recipients x where x.envelope_id = p_envelope_id) > 20 then
    raise exception 'ES_TOO_MANY_RECIPIENTS: a document can have up to 20 recipients' using errcode = '22023';
  end if;
  if exists (select 1 from public.fields f join public.recipients x on x.id = f.recipient_id
              where f.envelope_id = p_envelope_id and x.role not in ('signer', 'in_person')) then
    raise exception 'ES_FIELDS_ON_NON_SIGNER: only people who sign can have fields. Remove the fields placed for approvers, viewers or people who only receive a copy' using errcode = '22023';
  end if;
  -- routing (D-52): the order numbers decide the turns; the mode only says which patterns are allowed
  select count(*), count(distinct x.routing_order) into v_actors, v_orders
    from public.recipients x where x.envelope_id = p_envelope_id and x.role in ('signer', 'in_person', 'approver');
  if v_env.routing_mode = 'sequential' and v_orders <> v_actors then
    raise exception 'ES_ROUTING: in "one after another" each person who signs or approves needs their own place in the order' using errcode = '22023';
  end if;
  if v_env.routing_mode = 'parallel' and v_orders > 1 then
    raise exception 'ES_ROUTING: in "all at once" everyone who signs or approves shares the same place in the order' using errcode = '22023';
  end if;
  -- everyone except copy-only recipients gets a link record (a copy-only recipient receives the finished file)
  select count(*) into v_linked from public.recipients x where x.envelope_id = p_envelope_id and x.role <> 'cc';

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

  if jsonb_typeof(p_tokens) <> 'array' or jsonb_array_length(p_tokens) <> v_linked then
    raise exception 'token list does not match the recipients' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p_tokens) loop
    if not exists (select 1 from public.recipients x where x.id = (t ->> 'recipient_id')::uuid and x.envelope_id = p_envelope_id and x.role <> 'cc') then
      raise exception 'token for an unknown recipient' using errcode = '22023';
    end if;
    insert into public.recipient_tokens (id, org_id, envelope_id, recipient_id, nonce, token_sha256, expires_at)
      values ((t ->> 'token_id')::uuid, v_env.org_id, p_envelope_id, (t ->> 'recipient_id')::uuid,
              decode(t ->> 'nonce', 'hex'), decode(t ->> 'token_sha256', 'hex'), p_expires_at);
  end loop;

  v_layout := app_private.field_layout_hash(p_envelope_id);
  perform app_private.sanction();
  update public.envelopes e
     set status = 'sent', sent_at = now(), expires_at = p_expires_at, self_sign = (v_ext_count = 0), field_layout_sha256 = v_layout, delivery = p_delivery
   where e.id = p_envelope_id returning * into v_env;
  perform set_config('easysign.sanctioned', '', true);

  insert into public.usage_counters as u (day, user_id, envelopes_sent) values (v_day, p_actor, 1)
    on conflict (day, user_id) do update set envelopes_sent = u.envelopes_sent + 1;
  insert into public.usage_recipients (day, user_id, email_hash)
    select v_day, p_actor, sha256(convert_to(e, 'UTF8')) from unnest(coalesce(v_ext, '{}'::text[])) e
    on conflict do nothing;

  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'envelope_sent',
    jsonb_build_object('delivery', p_delivery, 'routing_mode', v_env.routing_mode, 'expires_at', p_expires_at, 'document_sha256', v_doc.sha256, 'layout_sha256', v_layout,
      'recipients', (select jsonb_agg(jsonb_build_object('id', x.id, 'role', x.role, 'order', x.routing_order, 'is_sender', x.is_sender) order by x.routing_order)
                       from public.recipients x where x.envelope_id = p_envelope_id)));

  -- bring the first turn into play: marks those recipients "sent" and queues their emails
  perform app_private.routing_advance(p_envelope_id);
  return v_env;
end
$$;

drop function public.signer_open(text, inet, text);
create function public.signer_open(p_token_sha256 text, p_ip inet, p_user_agent text)
returns table (token_id uuid, recipient_id uuid, envelope_id uuid, recipient_status text, envelope_status text, turn text)
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
  -- A valid link used before its turn: nothing opens, nothing changes, and the attempt is recorded.
  -- (No exception here: an exception would roll the audit event back.)
  if v_env.status in ('sent', 'in_progress') and v_rcp.status = 'created' then
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'out_of_turn',
      jsonb_build_object('order', v_rcp.routing_order, 'active_order', app_private.routing_active_order(v_env.id)), p_ip, p_user_agent);
    return query select v_tok.id, v_rcp.id, v_tok.envelope_id, v_rcp.status, v_env.status, 'waiting'::text;
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
  select * into v_env from public.envelopes e where e.id = v_tok.envelope_id;
  return query select v_tok.id, v_rcp.id, v_tok.envelope_id, v_rcp.status, v_env.status,
    case when v_env.status = 'completed' or v_rcp.status in ('signed', 'approved') then 'done'
         when v_rcp.role = 'viewer' then 'view'
         else 'now' end;
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
  if v_rcp.role = 'approver' then
    raise exception 'ES_WRONG_ACTION: an approver approves or declines; there is nothing to sign' using errcode = '42501';
  end if;
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

  return app_private.routing_after_action(v_rcp.envelope_id, v_rcp.org_id);
end
$$;

-- An approver's "yes". Consent to electronic records is required first, as for a signature.
create function public.signer_approve(p_token_id uuid, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if v_rcp.role <> 'approver' then
    raise exception 'ES_WRONG_ACTION: only an approver can approve' using errcode = '42501';
  end if;
  if v_rcp.status <> 'consented' then
    raise exception 'ES_CONSENT_REQUIRED: agree to use electronic records and signatures first' using errcode = '42501';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id for update;
  perform app_private.sanction();
  update public.recipients x set status = 'approved', completed_at = now() where x.id = v_rcp.id;
  perform set_config('easysign.sanctioned', '', true);
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'recipient_approved',
    jsonb_build_object('layout_sha256', v_env.field_layout_sha256,
      'document_sha256', (select d.sha256 from public.envelope_documents d where d.envelope_id = v_rcp.envelope_id order by d.position limit 1)),
    p_ip, p_user_agent);
  return app_private.routing_after_action(v_rcp.envelope_id, v_rcp.org_id);
end
$$;

-- A decline by anyone who must act (in their turn, before they have finished) stops the document for
-- everyone: every link is revoked, people still waiting are marked skipped, the sender is told.
create function public.signer_decline(p_token_id uuid, p_reason text, p_ip inet, p_user_agent text) returns void
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

-- The sender picks how turns are arranged while the document is a draft.
create function public.set_routing_mode(p_actor uuid, p_envelope_id uuid, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_draft(p_actor, p_envelope_id);
  if p_mode is null or p_mode not in ('sequential', 'parallel', 'mixed') then
    raise exception 'invalid routing mode' using errcode = '22023';
  end if;
  update public.envelopes e set routing_mode = p_mode where e.id = p_envelope_id and e.routing_mode <> p_mode;
end
$$;

-- Signing links for the sender, now with each person's role, place in the order and progress.
drop function public.reveal_signing_links(uuid, uuid);
create function public.reveal_signing_links(p_actor uuid, p_envelope_id uuid)
returns table (token_id uuid, nonce_hex text, recipient_name text, recipient_role text, recipient_order int, recipient_status text)
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
    select k.id, encode(k.nonce, 'hex'), x.name, x.role, x.routing_order, x.status
      from public.recipient_tokens k join public.recipients x on x.id = k.recipient_id
     where k.envelope_id = p_envelope_id and k.revoked_at is null
     order by x.routing_order, x.created_at;
end
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.signer_open(text, inet, text)',
    'public.signer_approve(uuid, inet, text)',
    'public.signer_decline(uuid, text, inet, text)',
    'public.set_routing_mode(uuid, uuid, text)',
    'public.reveal_signing_links(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  revoke all on function app_private.routing_active_order(uuid), app_private.routing_advance(uuid), app_private.routing_after_action(uuid, uuid)
    from public, anon, authenticated, service_role;
end
$$;

-- down (manual): re-run signer_open, signer_complete, send_envelope, require_signer and reveal_signing_links from migrations 8 and 9;
-- drop function if exists public.signer_approve(uuid, inet, text), public.signer_decline(uuid, text, inet, text), public.set_routing_mode(uuid, uuid, text),
--   app_private.routing_after_action(uuid, uuid), app_private.routing_advance(uuid), app_private.routing_active_order(uuid);
-- alter table public.envelopes drop column delivery;
