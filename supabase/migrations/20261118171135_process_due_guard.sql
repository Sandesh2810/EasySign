-- EasySign Phase 2 / migration 13: an accident guard on process_due (DECISIONS D-57).
-- The function is replaced in full; only the guard near the top is new. Grants are unchanged.

create or replace function public.process_due(p_now timestamptz default now())
returns table (expired_count int, reminder_count int)
language plpgsql security definer set search_path = '' as $$
declare
  v_env public.envelopes;
  r public.recipients;
  v_expired int := 0;
  v_reminders int := 0;
  v_count int;
  v_last timestamptz;
  v_inserted int;
begin
  if p_now is null then
    raise exception 'a time is required' using errcode = '22023';
  end if;
  -- Accident guard: with a future time this function would expire real documents. The worker always
  -- passes the real time. Tests move the clock inside a transaction that is rolled back, and say so.
  if p_now > now() + interval '5 minutes' and coalesce(current_setting('easysign.test_clock', true), '') <> 'on' then
    raise exception 'process_due was given a time in the future' using errcode = '22023';
  end if;

  for v_env in select * from public.envelopes e
                where e.status in ('sent', 'in_progress') and e.expires_at is not null and e.expires_at <= p_now
                  and not exists (select 1 from public.seal_jobs j where j.envelope_id = e.id)
                order by e.expires_at
                for update skip locked loop
    perform app_private.sanction();
    update public.recipients x set status = 'expired'
     where x.envelope_id = v_env.id and x.status in ('created', 'sent', 'viewed', 'consented');
    update public.envelopes e set status = 'expired', expired_at = p_now where e.id = v_env.id;
    perform set_config('easysign.sanctioned', '', true);
    update public.recipient_tokens k set revoked_at = p_now where k.envelope_id = v_env.id and k.revoked_at is null;
    perform app_private.cancel_pending_requests(v_env.id, 'cancelled: the document expired');
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, null, 'system', null, 'envelope_expired',
      jsonb_build_object('expires_at', v_env.expires_at, 'links_revoked', true));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_env.org_id, v_env.sender_id, 'envelope_expired', jsonb_build_object('envelope_id', v_env.id, 'title', v_env.title));
    insert into public.notification_outbox (org_id, envelope_id, to_user_id, sender_user_id, kind, priority, idempotency_key)
      values (v_env.org_id, v_env.id, v_env.sender_id, v_env.sender_id, 'expired_sender', 'P2', 'expired:' || v_env.id::text)
      on conflict (idempotency_key) do nothing;
    v_expired := v_expired + 1;
  end loop;

  for r in select x.* from public.recipients x join public.envelopes e on e.id = x.envelope_id
            where e.status in ('sent', 'in_progress') and e.delivery = 'email'
              and e.remind_max > 0 and e.remind_after_days is not null
              and (e.expires_at is null or e.expires_at > p_now + interval '1 hour')
              and x.role in ('signer', 'in_person', 'approver') and x.status in ('sent', 'viewed', 'consented')
            order by x.sent_at, x.id
            for update of x skip locked loop
    select * into v_env from public.envelopes e where e.id = r.envelope_id;
    continue when lower(r.email) = coalesce(app_private.user_email(v_env.sender_id), '');
    select count(*) filter (where o.kind = 'reminder'), max(o.created_at) into v_count, v_last
      from public.notification_outbox o
     where o.recipient_id = r.id and o.kind in ('signature_request', 'approval_request', 'reminder');
    v_last := coalesce(v_last, r.sent_at);
    continue when v_last is null or v_count >= v_env.remind_max;
    continue when p_now < v_last + make_interval(days => case when v_count = 0 then v_env.remind_after_days else coalesce(v_env.remind_every_days, v_env.remind_after_days) end);
    -- created_at carries the time this run was asked about, so a second run for the same moment finds it and does nothing
    insert into public.notification_outbox (org_id, envelope_id, recipient_id, sender_user_id, kind, priority, idempotency_key, created_at)
      values (v_env.org_id, v_env.id, r.id, v_env.sender_id, 'reminder', 'P2', 'reminder:' || r.id::text || ':' || (v_count + 1)::text, p_now)
      on conflict (idempotency_key) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, r.id, 'system', null, 'reminder_queued',
        jsonb_build_object('number', v_count + 1));
      v_reminders := v_reminders + 1;
    end if;
  end loop;

  return query select v_expired, v_reminders;
end
$$;
