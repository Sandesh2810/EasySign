-- YouNMeSign Phase 4 slice 8: comments and scheduled send (D-84).
-- Comments
-- * One private thread per signer or approver with the sender's side (envelope_comments.recipient_id is the thread):
--   signers never see each other's questions. Comments cannot be edited or deleted, and each one is written to the
--   document's audit trail with its text, so the conversation is part of the tamper-evident record.
-- * A question notifies the sender in the app; an answer is emailed to the person (with their link) when the sender
--   sends by email, otherwise they see it when they next open the document.
-- Scheduled send
-- * schedule_send checks everything sending would check by doing a full send and undoing it (so a problem shows now,
--   not at 3 am), then stores the time, the delivery choice, the link records and how long links stay valid.
-- * While scheduled, the draft cannot be changed (require_draft: ES_SCHEDULED) until it is sent or cancelled.
-- * The worker calls run_scheduled_sends about once a minute; a send that fails leaves the draft as it was, records the
--   reason, and tells the sender.
-- Down script at the bottom (commented).

-- ---------- comments ----------
create table public.envelope_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  envelope_id uuid not null references public.envelopes (id) on delete cascade,
  recipient_id uuid not null references public.recipients (id) on delete cascade,
  author_kind text not null check (author_kind in ('signer', 'sender')),
  author_user uuid references auth.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index envelope_comments_thread_idx on public.envelope_comments (envelope_id, recipient_id, created_at);
alter table public.envelope_comments enable row level security;
create policy envelope_comments_select on public.envelope_comments for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = envelope_comments.envelope_id));
revoke all on public.envelope_comments from anon, authenticated;
grant select on public.envelope_comments to authenticated;
grant select, insert on public.envelope_comments to service_role;

create function public.signer_comment(p_token_id uuid, p_body text, p_ip inet, p_user_agent text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_rcp public.recipients;
  v_env public.envelopes;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  v_rcp := app_private.require_signer(p_token_id);
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'ES_INVALID: write your question (up to 1000 characters)' using errcode = '22023';
  end if;
  if (select count(*) from public.envelope_comments c where c.recipient_id = v_rcp.id) >= 100 then
    raise exception 'ES_LIMIT: this conversation is full. Contact the sender another way' using errcode = '54000';
  end if;
  select * into v_env from public.envelopes e where e.id = v_rcp.envelope_id;
  insert into public.envelope_comments (org_id, envelope_id, recipient_id, author_kind, body)
    values (v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', v_body) returning id into v_id;
  perform app_private.audit_append('env:' || v_rcp.envelope_id::text, v_rcp.org_id, v_rcp.envelope_id, v_rcp.id, 'signer', null, 'comment_added',
    jsonb_build_object('comment_id', v_id, 'by', 'signer', 'body', v_body), p_ip, p_user_agent);
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, 'comment_added', jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', v_rcp.name));
  return v_id;
end
$$;
revoke all on function public.signer_comment(uuid, text, inet, text) from public, anon, authenticated;
grant execute on function public.signer_comment(uuid, text, inet, text) to service_role;

create function public.sender_comment(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_rcp public.recipients;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  v_env := app_private.require_open_envelope(p_actor, p_envelope_id);
  select * into v_rcp from public.recipients x where x.id = p_recipient_id and x.envelope_id = p_envelope_id;
  if not found or v_rcp.role not in ('signer', 'approver', 'in_person') then
    raise exception 'ES_NOT_FOUND: that person is not someone who signs or approves this document' using errcode = '42501';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'ES_INVALID: write your answer (up to 1000 characters)' using errcode = '22023';
  end if;
  if (select count(*) from public.envelope_comments c where c.recipient_id = v_rcp.id) >= 100 then
    raise exception 'ES_LIMIT: this conversation is full' using errcode = '54000';
  end if;
  insert into public.envelope_comments (org_id, envelope_id, recipient_id, author_kind, author_user, body)
    values (v_env.org_id, p_envelope_id, v_rcp.id, 'sender', p_actor, v_body) returning id into v_id;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, v_rcp.id, 'user', p_actor, 'comment_added',
    jsonb_build_object('comment_id', v_id, 'by', 'sender', 'body', v_body));
  -- the person is emailed the answer with their link, when the sender sends by email and they still have something to do
  if v_env.delivery = 'email' and lower(v_rcp.email) <> lower(coalesce(app_private.user_email(v_env.sender_id), ''))
     and v_rcp.status in ('sent', 'viewed', 'consented') then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, payload, idempotency_key)
      values (v_env.org_id, p_envelope_id, v_rcp.id, p_actor, 'comment_reply', 'P2', jsonb_build_object('comment_id', v_id), 'comment:' || v_id::text);
  end if;
  return v_id;
end
$$;
revoke all on function public.sender_comment(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sender_comment(uuid, uuid, uuid, text) to service_role;

-- ---------- scheduled send ----------
create table public.scheduled_sends (
  envelope_id uuid primary key references public.envelopes (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  actor uuid not null references auth.users (id) on delete cascade,
  send_at timestamptz not null,
  delivery text not null check (delivery in ('email', 'link')),
  expires_days int not null check (expires_days in (7, 14, 30, 60)),
  tokens jsonb not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index scheduled_sends_due_idx on public.scheduled_sends (send_at) where status = 'scheduled';
alter table public.scheduled_sends enable row level security;
create policy scheduled_sends_select on public.scheduled_sends for select to authenticated
  using (exists (select 1 from public.envelopes e where e.id = scheduled_sends.envelope_id));
revoke all on public.scheduled_sends from anon, authenticated;
-- the link records stay server-side
grant select (envelope_id, send_at, delivery, status, error, created_at, done_at) on public.scheduled_sends to authenticated;
grant select, insert, update, delete on public.scheduled_sends to service_role;

-- every draft edit goes through require_draft: a scheduled draft is locked
create or replace function app_private.require_draft(p_actor uuid, p_envelope_id uuid) returns public.envelopes
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  if p_actor is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
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
  -- D-84: a draft scheduled to be sent is locked until it is sent or the schedule is cancelled (the scheduled run itself passes)
  if exists (select 1 from public.scheduled_sends s where s.envelope_id = p_envelope_id and s.status = 'scheduled')
     and coalesce(current_setting('easysign.scheduled_run', true), '') <> p_envelope_id::text then
    raise exception 'ES_SCHEDULED: this document is scheduled to be sent. Cancel the scheduled send to change it' using errcode = '42501';
  end if;
  return v_env;
end
$$;

create function public.schedule_send(p_actor uuid, p_envelope_id uuid, p_send_at timestamptz, p_expires_days int, p_delivery text, p_tokens jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_msg text;
  v_state text;
begin
  v_env := app_private.require_draft(p_actor, p_envelope_id);
  if p_send_at is null or p_send_at < now() + interval '5 minutes' or p_send_at > now() + interval '60 days' then
    raise exception 'ES_INVALID: choose a time from 5 minutes to 60 days from now' using errcode = '22023';
  end if;
  if p_expires_days not in (7, 14, 30, 60) or p_delivery not in ('email', 'link') or jsonb_typeof(p_tokens) <> 'array' then
    raise exception 'invalid schedule' using errcode = '22023';
  end if;
  -- check everything sending would check, now: send, then undo it (only this block is rolled back)
  begin
    perform public.send_envelope(p_actor, p_envelope_id, p_tokens, now() + make_interval(days => p_expires_days), p_delivery);
    raise exception 'ES_DRY_RUN_OK' using errcode = 'P0001';
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg <> 'ES_DRY_RUN_OK' then
      raise exception '%', v_msg using errcode = v_state;
    end if;
  end;
  insert into public.scheduled_sends as s (envelope_id, org_id, actor, send_at, delivery, expires_days, tokens)
    values (p_envelope_id, v_env.org_id, p_actor, p_send_at, p_delivery, p_expires_days, p_tokens)
    on conflict (envelope_id) do update set actor = excluded.actor, send_at = excluded.send_at, delivery = excluded.delivery,
      expires_days = excluded.expires_days, tokens = excluded.tokens, status = 'scheduled', error = null, created_at = now(), done_at = null;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'send_scheduled',
    jsonb_build_object('send_at', p_send_at, 'delivery', p_delivery, 'expires_days', p_expires_days));
end
$$;
revoke all on function public.schedule_send(uuid, uuid, timestamptz, int, text, jsonb) from public, anon, authenticated;
grant execute on function public.schedule_send(uuid, uuid, timestamptz, int, text, jsonb) to service_role;

create function public.cancel_scheduled_send(p_actor uuid, p_envelope_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
begin
  select * into v_env from public.envelopes e where e.id = p_envelope_id for update;
  if not found or not app_private.may_handle_envelope(p_actor, v_env.org_id, v_env.sender_id, 'member') then
    raise exception 'ES_NOT_FOUND: document not found' using errcode = '42501';
  end if;
  update public.scheduled_sends s set status = 'cancelled', done_at = now() where s.envelope_id = p_envelope_id and s.status = 'scheduled';
  if not found then
    raise exception 'ES_NOT_SCHEDULED: this document is not scheduled to be sent' using errcode = '22023';
  end if;
  perform app_private.audit_append('env:' || p_envelope_id::text, v_env.org_id, p_envelope_id, null, 'user', p_actor, 'send_schedule_cancelled', '{}'::jsonb);
end
$$;
revoke all on function public.cancel_scheduled_send(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_scheduled_send(uuid, uuid) to service_role;

-- the worker, about once a minute: send what is due; a failure leaves the draft as it was and tells the sender
create function public.run_scheduled_sends(p_limit int default 10) returns int
language plpgsql security definer set search_path = '' as $$
declare
  r public.scheduled_sends;
  v_env public.envelopes;
  v_msg text;
  v_sent int := 0;
begin
  for r in select * from public.scheduled_sends s where s.status = 'scheduled' and s.send_at <= now()
            order by s.send_at limit greatest(1, least(coalesce(p_limit, 10), 50)) for update skip locked loop
    begin
      perform set_config('easysign.scheduled_run', r.envelope_id::text, true);
      perform public.send_envelope(r.actor, r.envelope_id, r.tokens, now() + make_interval(days => r.expires_days), r.delivery);
      perform set_config('easysign.scheduled_run', '', true);
      update public.scheduled_sends s set status = 'sent', done_at = now() where s.envelope_id = r.envelope_id;
      v_sent := v_sent + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      perform set_config('easysign.scheduled_run', '', true);
      update public.scheduled_sends s set status = 'failed', error = left(v_msg, 500), done_at = now() where s.envelope_id = r.envelope_id;
      select * into v_env from public.envelopes e where e.id = r.envelope_id;
      perform app_private.audit_append('env:' || r.envelope_id::text, v_env.org_id, r.envelope_id, null, 'system', null, 'scheduled_send_failed',
        jsonb_build_object('error', left(v_msg, 500)));
      insert into public.notifications (org_id, user_id, kind, payload)
        values (v_env.org_id, r.actor, 'scheduled_send_failed', jsonb_build_object('envelope_id', r.envelope_id, 'title', v_env.title, 'error', left(regexp_replace(v_msg, '^ES_[A-Z_]+:\s*', ''), 300)));
    end;
  end loop;
  return v_sent;
end
$$;
revoke all on function public.run_scheduled_sends(int) from public, anon, authenticated;
grant execute on function public.run_scheduled_sends(int) to service_role;

-- down:
-- drop function public.run_scheduled_sends(int); drop function public.cancel_scheduled_send(uuid, uuid);
-- drop function public.schedule_send(uuid, uuid, timestamptz, int, text, jsonb); re-run require_draft from migration 20261120191012;
-- drop table public.scheduled_sends; drop function public.sender_comment(uuid, uuid, uuid, text);
-- drop function public.signer_comment(uuid, text, inet, text); drop table public.envelope_comments;
