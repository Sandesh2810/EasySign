-- YouNMeSign Phase 4 slice 6 (D-81), follow-up: send_envelope's "one after another" check counts a signing group as one
-- person (its members share one place in the order). Found by phase4_slice6_groups.sql (T652): without this, a document
-- with a signing group could not be sent in "one after another" mode. Only that one line differs from migration
-- 20261118160949.
-- down: re-run send_envelope from migration 20261118160949.

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
  -- D-81: a signing group is one turn: its members count once
  select count(distinct coalesce('g:' || lower(x.signing_group), 'r:' || x.id::text)), count(distinct x.routing_order) into v_actors, v_orders
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
