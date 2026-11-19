-- EasySign Phase 2 / migration 17: abuse reports, suspending an account, account limits, platform usage (slice 8, AT2.10).
--  * Anyone holding a signing link can report the document. The report goes to the platform administrators.
--  * An administrator can suspend an account. While it is suspended its open documents are ON HOLD: no link opens,
--    nothing can be signed, and no email about them is sent. Nothing is cancelled, so lifting the suspension
--    lets everything continue. Completed documents stay downloadable.
--  * An administrator can change an account's daily limits and mark it trusted.
--  * platform_usage() reports the numbers that are compared with the free-tier limits (check:budget).
-- All new public functions are server-only (service role).

alter table public.abuse_reports add column recipient_id uuid references public.recipients (id) on delete set null;
alter table public.abuse_reports add column decided_by uuid references auth.users (id) on delete set null;
alter table public.abuse_reports add column decided_at timestamptz;
alter table public.abuse_reports add column note text check (char_length(note) <= 1000);
create index abuse_reports_recipient_idx on public.abuse_reports (recipient_id);
create index abuse_reports_decided_by_idx on public.abuse_reports (decided_by);
-- one open report per person per document: reporting twice changes nothing
create unique index abuse_reports_one_open_idx on public.abuse_reports (envelope_id, recipient_id) where status = 'open';

alter table public.account_controls add column suspended_at timestamptz;
alter table public.account_controls add column suspended_reason text check (char_length(suspended_reason) <= 500);
alter table public.account_controls add column trust_before_suspension text check (trust_before_suspension in ('restricted', 'trusted'));

-- True while the sender of this document (or their workspace) is suspended.
create function app_private.sender_on_hold(p_envelope_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.envelopes e
     where e.id = p_envelope_id
       and (exists (select 1 from public.account_controls c where c.user_id = e.sender_id and c.trust_level = 'suspended')
            or exists (select 1 from public.org_controls o where o.org_id = e.org_id and o.status = 'suspended')))
$$;

-- ---------------------------------------------------------------- re-issued with the hold check
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
  if app_private.sender_on_hold(v_tok.envelope_id) then
    raise exception 'ES_ON_HOLD: this document is on hold and cannot be signed right now' using errcode = '42501';
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

create or replace function public.signer_open(p_token_sha256 text, p_ip inet, p_user_agent text)
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
  -- The sender's account is suspended: nothing opens and nothing changes. (No exception: the audit event must stay.)
  if v_env.status in ('sent', 'in_progress') and app_private.sender_on_hold(v_env.id) then
    perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'link_on_hold', '{}'::jsonb, p_ip, p_user_agent);
    return query select v_tok.id, v_rcp.id, v_tok.envelope_id, v_rcp.status, v_env.status, 'held'::text;
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

create or replace function app_private.signer_gate(p_token_id uuid) returns public.recipients
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
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id for update;
  select e.status into v_status from public.envelopes e where e.id = v_tok.envelope_id;
  if v_status not in ('sent', 'in_progress', 'completed') then
    raise exception 'ES_LINK_INVALID: this document is no longer open' using errcode = '42501';
  end if;
  if v_status in ('sent', 'in_progress') and app_private.sender_on_hold(v_tok.envelope_id) then
    raise exception 'ES_ON_HOLD: this document is on hold and cannot be opened right now' using errcode = '42501';
  end if;
  return v_rcp;
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
          and not exists (select 1 from public.account_controls c where c.user_id = q.sender_user_id and c.trust_level = 'suspended')
        order by case q.priority when 'P0_AUTH' then 0 when 'P0_REQUEST' then 1 when 'P1' then 2 when 'P2' then 3 else 4 end, q.created_at
        for update skip locked limit greatest(1, least(p_limit, 50)))
    returning o.*;
end
$$;

-- ---------------------------------------------------------------- report abuse (from a signing link)
-- Works with any link that ever existed for the document, including one whose turn has not come, one that
-- has not passed its identity check, and one that was switched off: a suspicious document must be reportable.
create function public.report_abuse(p_token_id uuid, p_reason text, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_tok public.recipient_tokens;
  v_env public.envelopes;
  v_rcp public.recipients;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_id uuid;
begin
  select * into v_tok from public.recipient_tokens k where k.id = p_token_id;
  if not found then
    raise exception 'ES_LINK_INVALID: this link is not valid' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 2000 then
    raise exception 'ES_REASON_NEEDED: say in a few words what is wrong (up to 2000 characters)' using errcode = '22023';
  end if;
  select * into v_env from public.envelopes e where e.id = v_tok.envelope_id;
  select * into v_rcp from public.recipients x where x.id = v_tok.recipient_id;
  insert into public.abuse_reports (org_id, envelope_id, recipient_id, reporter_email, reason)
    values (v_env.org_id, v_env.id, v_rcp.id, v_rcp.email, v_reason)
    on conflict (envelope_id, recipient_id) where status = 'open' do nothing
    returning id into v_id;
  if v_id is null then
    return 'already';
  end if;
  -- the audit trail records that a report was made and a fingerprint of the text, not the text itself
  perform app_private.audit_append('env:' || v_env.id::text, v_env.org_id, v_env.id, v_rcp.id, 'signer', null, 'abuse_reported',
    jsonb_build_object('report_id', v_id, 'reason_sha256', encode(sha256(convert_to(v_reason, 'UTF8')), 'hex')), p_ip, p_user_agent);
  insert into public.notifications (user_id, kind, payload)
    select c.user_id, 'abuse_report', jsonb_build_object('report_id', v_id, 'title', v_env.title)
      from public.account_controls c where c.is_platform_admin and c.trust_level <> 'suspended';
  return 'reported';
end
$$;

-- ---------------------------------------------------------------- administrator: reports
create function public.admin_list_abuse_reports(p_actor uuid)
returns table (report_id uuid, reported_at timestamptz, report_status text, reason text, reporter_name text, reporter_email text,
               envelope_id uuid, envelope_title text, envelope_status text, sender_id uuid, sender_email text, sender_name text,
               sender_trust text, sender_open_reports int, decided_at timestamptz, note text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_admin(p_actor);
  return query
    select r.id, r.created_at, r.status, r.reason, coalesce(x.name, ''), coalesce(r.reporter_email, ''),
           e.id, e.title, e.status, e.sender_id, u.email::text, coalesce(p.display_name, ''),
           coalesce(c.trust_level, ''),
           (select count(*)::int from public.abuse_reports r2 join public.envelopes e2 on e2.id = r2.envelope_id
             where e2.sender_id = e.sender_id and r2.status = 'open'),
           r.decided_at, r.note
      from public.abuse_reports r
      join public.envelopes e on e.id = r.envelope_id
      left join public.recipients x on x.id = r.recipient_id
      left join auth.users u on u.id = e.sender_id
      left join public.profiles p on p.id = e.sender_id
      left join public.account_controls c on c.user_id = e.sender_id
     order by (r.status = 'open') desc, r.created_at desc
     limit 200;
end
$$;

-- Close a report: "actioned" (something was done about it) or "dismissed" (nothing wrong).
create function public.admin_resolve_abuse_report(p_actor uuid, p_report_id uuid, p_status text, p_note text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  r public.abuse_reports;
begin
  perform app_private.require_admin(p_actor);
  if p_status is null or p_status not in ('actioned', 'dismissed') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into r from public.abuse_reports x where x.id = p_report_id for update;
  if not found then
    raise exception 'ES_NOT_FOUND: report not found' using errcode = '42501';
  end if;
  if r.status <> 'open' then
    return 'unchanged';
  end if;
  update public.abuse_reports x set status = p_status, decided_by = p_actor, decided_at = now(), note = nullif(left(btrim(coalesce(p_note, '')), 1000), '')
   where x.id = p_report_id;
  perform app_private.audit_append('env:' || r.envelope_id::text, r.org_id, r.envelope_id, r.recipient_id, 'admin', p_actor, 'abuse_report_closed',
    jsonb_build_object('report_id', r.id, 'outcome', p_status));
  return p_status;
end
$$;

-- ---------------------------------------------------------------- administrator: suspend / lift suspension
create function public.admin_set_suspension(p_actor uuid, p_user uuid, p_suspended boolean, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_ctl public.account_controls;
  v_org uuid;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
begin
  perform app_private.require_admin(p_actor);
  if p_suspended is null then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  select * into v_ctl from public.account_controls c where c.user_id = p_user for update;
  if not found then
    raise exception 'ES_NOT_FOUND: account not found' using errcode = '42501';
  end if;
  if v_ctl.is_platform_admin or p_user = p_actor then
    raise exception 'ES_ADMIN_ACCOUNT: an administrator account cannot be suspended here' using errcode = '42501';
  end if;
  if (v_ctl.trust_level = 'suspended') = p_suspended then
    return 'unchanged';
  end if;
  if p_suspended then
    update public.account_controls c
       set trust_before_suspension = c.trust_level, trust_level = 'suspended', suspended_at = now(), suspended_reason = v_reason
     where c.user_id = p_user;
  else
    update public.account_controls c
       set trust_level = coalesce(c.trust_before_suspension, 'restricted'), trust_before_suspension = null, suspended_at = null, suspended_reason = null
     where c.user_id = p_user;
  end if;
  select m.org_id into v_org from public.memberships m where m.user_id = p_user and m.role = 'owner' limit 1;
  if v_org is not null then
    -- the reason is the administrator's own note; the audit trail keeps only that one was given
    perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'admin', p_actor,
      case when p_suspended then 'account_suspended' else 'account_suspension_lifted' end,
      jsonb_build_object('user_id', p_user, 'reason_given', v_reason is not null));
    insert into public.notifications (org_id, user_id, kind, payload)
      values (v_org, p_user, case when p_suspended then 'account_suspended' else 'account_suspension_lifted' end, '{}'::jsonb);
  end if;
  return case when p_suspended then 'suspended' else 'lifted' end;
end
$$;

-- ---------------------------------------------------------------- administrator: limits and trust
create function public.admin_set_limits(p_actor uuid, p_user uuid, p_daily_envelope_cap int, p_daily_recipient_cap int, p_trusted boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_ctl public.account_controls;
  v_org uuid;
begin
  perform app_private.require_admin(p_actor);
  if p_daily_envelope_cap is null or p_daily_recipient_cap is null or p_trusted is null
     or p_daily_envelope_cap not between 0 and 500 or p_daily_recipient_cap not between 0 and 2000 then
    raise exception 'ES_BAD_LIMITS: documents per day must be 0 to 500 and people per day 0 to 2000' using errcode = '22023';
  end if;
  select * into v_ctl from public.account_controls c where c.user_id = p_user for update;
  if not found then
    raise exception 'ES_NOT_FOUND: account not found' using errcode = '42501';
  end if;
  if v_ctl.daily_envelope_cap = p_daily_envelope_cap and v_ctl.daily_recipient_cap = p_daily_recipient_cap and v_ctl.admin_trusted = p_trusted then
    return;
  end if;
  -- a suspended account stays suspended; the trust mark takes effect when the suspension is lifted
  update public.account_controls c
     set daily_envelope_cap = p_daily_envelope_cap, daily_recipient_cap = p_daily_recipient_cap, admin_trusted = p_trusted,
         trust_level = case when c.trust_level = 'suspended' then c.trust_level when p_trusted then 'trusted' else 'restricted' end,
         trust_before_suspension = case when c.trust_level = 'suspended' then (case when p_trusted then 'trusted' else 'restricted' end) else c.trust_before_suspension end
   where c.user_id = p_user;
  select m.org_id into v_org from public.memberships m where m.user_id = p_user and m.role = 'owner' limit 1;
  if v_org is not null then
    perform app_private.audit_append('org:' || v_org::text, v_org, null, null, 'admin', p_actor, 'account_limits_changed',
      jsonb_build_object('user_id', p_user, 'documents_per_day', p_daily_envelope_cap, 'people_per_day', p_daily_recipient_cap, 'trusted', p_trusted));
  end if;
end
$$;

-- ---------------------------------------------------------------- administrator: the account list, with what the console needs
drop function public.admin_list_accounts(uuid);
create function public.admin_list_accounts(p_actor uuid)
returns table (account_id uuid, account_email text, display_name text, is_approved boolean, trust text, is_admin boolean,
               email_confirmed boolean, request_status text, registered_at timestamptz,
               documents_per_day int, people_per_day int, is_trusted boolean, suspended_since timestamptz, suspension_reason text,
               open_documents int, open_reports int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.require_admin(p_actor);
  return query
    select c.user_id, u.email::text, coalesce(p.display_name, ''), c.approved, c.trust_level, c.is_platform_admin,
           u.email_confirmed_at is not null, q.status, c.created_at,
           c.daily_envelope_cap, c.daily_recipient_cap, c.admin_trusted, c.suspended_at, c.suspended_reason,
           (select count(*)::int from public.envelopes e where e.sender_id = c.user_id and e.status in ('sent', 'in_progress')),
           (select count(*)::int from public.abuse_reports r join public.envelopes e on e.id = r.envelope_id where e.sender_id = c.user_id and r.status = 'open')
      from public.account_controls c
      join auth.users u on u.id = c.user_id
      left join public.profiles p on p.id = c.user_id
      left join public.registration_requests q on q.user_id = c.user_id
     order by (c.trust_level = 'suspended') desc, c.approved, c.created_at desc
     limit 200;
end
$$;

-- ---------------------------------------------------------------- the numbers behind check:budget
create function public.platform_usage()
returns table (db_bytes bigint, storage_bytes bigint, user_count int, emails_today int, emails_month int)
language sql stable security definer set search_path = '' as $$
  select pg_database_size(current_database())::bigint,
         public.storage_usage_bytes(),
         (select count(*)::int from auth.users),
         (select coalesce(sum(b.sent_auth + b.sent_shared), 0)::int from public.email_budget b where b.day = app_private.utc_day()),
         (select coalesce(sum(b.sent_auth + b.sent_shared), 0)::int from public.email_budget b where b.day >= date_trunc('month', app_private.utc_day()::timestamp)::date)
$$;

do $$
declare fn text;
begin
  revoke all on function app_private.sender_on_hold(uuid), app_private.require_signer(uuid), app_private.signer_gate(uuid)
    from public, anon, authenticated, service_role;
  foreach fn in array array[
    'public.signer_open(text, inet, text)',
    'public.claim_outbox(int, int)',
    'public.report_abuse(uuid, text, inet, text)',
    'public.admin_list_abuse_reports(uuid)',
    'public.admin_resolve_abuse_report(uuid, uuid, text, text)',
    'public.admin_set_suspension(uuid, uuid, boolean, text)',
    'public.admin_set_limits(uuid, uuid, int, int, boolean)',
    'public.admin_list_accounts(uuid)',
    'public.platform_usage()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down (manual): re-run require_signer and signer_open from migration 10, signer_gate from migration 15,
-- claim_outbox from migration 8 and admin_list_accounts from migration 9; then
-- drop function public.platform_usage(), public.admin_set_limits(uuid, uuid, int, int, boolean), public.admin_set_suspension(uuid, uuid, boolean, text),
--   public.admin_resolve_abuse_report(uuid, uuid, text, text), public.admin_list_abuse_reports(uuid), public.report_abuse(uuid, text, inet, text);
-- drop function app_private.sender_on_hold(uuid);
-- alter table public.account_controls drop column trust_before_suspension, drop column suspended_reason, drop column suspended_at;
-- drop index public.abuse_reports_one_open_idx, public.abuse_reports_decided_by_idx, public.abuse_reports_recipient_idx;
-- alter table public.abuse_reports drop column note, drop column decided_at, drop column decided_by, drop column recipient_id;
