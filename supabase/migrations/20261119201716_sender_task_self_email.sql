-- YouNMeSign (EasySign) Phase 3 / migration 22: fix found by test T517 (slice 3).
-- open_sender_task decided "is this the sender's own document?" from recipients.is_sender alone, which is only
-- set when the sender chose "me" in the editor. A sender who typed their own address would have been emailed
-- about themself. Now it also compares the address with the sender's, exactly as the decline notice does.

create or replace function app_private.open_sender_task(p_rcp public.recipients, p_kind text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  v_id uuid;
begin
  select * into v_env from public.envelopes e where e.id = p_rcp.envelope_id;
  insert into public.sender_tasks (org_id, envelope_id, recipient_id, kind, note)
    values (p_rcp.org_id, p_rcp.envelope_id, p_rcp.id, p_kind, p_note)
    on conflict (recipient_id, kind) where done_at is null do nothing
    returning id into v_id;
  if v_id is null then
    select t.id into v_id from public.sender_tasks t where t.recipient_id = p_rcp.id and t.kind = p_kind and t.done_at is null;
    return v_id;
  end if;
  insert into public.notifications (org_id, user_id, kind, payload)
    values (v_env.org_id, v_env.sender_id, case p_kind when 'paper_copy' then 'paper_copy_requested' else 'consent_withdrawn' end,
            jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title, 'by', p_rcp.name));
  if not p_rcp.is_sender and lower(p_rcp.email) <> coalesce(app_private.user_email(v_env.sender_id), '') then
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, to_user_id, sender_user_id, kind, priority, payload, idempotency_key)
      values (v_env.org_id, v_env.id, p_rcp.id, v_env.sender_id, v_env.sender_id,
              case p_kind when 'paper_copy' then 'paper_copy_sender' else 'withdrawn_sender' end, 'P1',
              jsonb_build_object('task_id', v_id), 'task:' || v_id::text)
      on conflict (idempotency_key) do nothing;
  end if;
  return v_id;
end
$$;
revoke all on function app_private.open_sender_task(public.recipients, text, text) from public, anon, authenticated, service_role;

-- down (manual): re-create app_private.open_sender_task exactly as in 20261119201541_consent_paper_tasks.sql.
