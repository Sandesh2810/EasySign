-- YouNMeSign Phase 4 slice 8 (D-84), follow-up: the email that carries the sender's answer to a signer's question is
-- queued as P1 (held only when 90% of the day's emails are used) instead of P2 (held at 75%): the signer may be waiting
-- for it before they can sign, like the other notices at P1. Found by npm run e2e:comments on a day with 77 of 100 used.
-- Only that one value differs from migration 20261121021949.
-- down: re-run sender_comment from migration 20261121021949.

create or replace function public.sender_comment(p_actor uuid, p_envelope_id uuid, p_recipient_id uuid, p_body text) returns uuid
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
      values (v_env.org_id, p_envelope_id, v_rcp.id, p_actor, 'comment_reply', 'P1', jsonb_build_object('comment_id', v_id), 'comment:' || v_id::text);
  end if;
  return v_id;
end
$$;
