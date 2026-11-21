-- D-93 (Phase 5 slice 4, AT5.4): reports. For a period of whole UTC days (up to two years), what happened to a
-- workspace's documents: how many were sent, completed (sealed), declined, voided and expired in the period, and the
-- average time from sending to completion of those completed in it; in total, by the person who sent them and by the
-- template they came from. Owners, administrators and viewers see the whole workspace; members see their own
-- documents only (as everywhere else). Reads only; no table changes; one new index.

create index if not exists envelopes_org_sent_idx on public.envelopes (org_id, sent_at) where sent_at is not null;

create function public.report_summary(p_actor uuid, p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := app_private.member_role(p_actor, p_org);
  v_start timestamptz;
  v_end timestamptz;
  v_out jsonb;
begin
  if p_actor is null or v_role is null then
    raise exception 'ES_NOT_FOUND: workspace not found' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception 'ES_PERIOD: choose a period of up to two years, ending on or after its start' using errcode = '22023';
  end if;
  v_start := p_from::timestamp at time zone 'UTC';
  v_end := (p_to + 1)::timestamp at time zone 'UTC';   -- the last day is included

  with docs as (
    select e.id, e.sender_id, e.status, e.sent_at, e.completed_at, e.voided_at, e.expired_at,
           case when e.status = 'declined' then (select max(r.completed_at) from public.recipients r where r.envelope_id = e.id and r.status = 'declined') end as declined_at,
           (select tr.template_id from public.recipients r join public.template_roles tr on tr.id = r.template_role_id
             where r.envelope_id = e.id and r.template_role_id is not null limit 1) as template_id
      from public.envelopes e
     where e.org_id = p_org and e.sent_at is not null
       and (v_role <> 'member' or e.sender_id = p_actor)
       and ((e.sent_at >= v_start and e.sent_at < v_end)
         or (e.completed_at >= v_start and e.completed_at < v_end)
         or (e.voided_at >= v_start and e.voided_at < v_end)
         or (e.expired_at >= v_start and e.expired_at < v_end)
         or (e.status = 'declined' and e.updated_at >= v_start))
  ),
  flags as (
    select d.sender_id, d.template_id, d.sent_at, d.completed_at,
           (d.sent_at >= v_start and d.sent_at < v_end) as is_sent,
           (d.status = 'completed' and d.completed_at >= v_start and d.completed_at < v_end) as is_completed,
           coalesce(d.declined_at >= v_start and d.declined_at < v_end, false) as is_declined,
           (d.status = 'voided' and d.voided_at >= v_start and d.voided_at < v_end) as is_voided,
           (d.status = 'expired' and d.expired_at >= v_start and d.expired_at < v_end) as is_expired
      from docs d
  ),
  agg as (
    select grouping(f.sender_id) as g_person, grouping(f.template_id) as g_template, f.sender_id, f.template_id,
           count(*) filter (where f.is_sent) as sent,
           count(*) filter (where f.is_completed) as completed,
           count(*) filter (where f.is_declined) as declined,
           count(*) filter (where f.is_voided) as voided,
           count(*) filter (where f.is_expired) as expired,
           round((avg(extract(epoch from (f.completed_at - f.sent_at))) filter (where f.is_completed) / 3600)::numeric, 1) as avg_hours
      from flags f
     group by grouping sets ((), (f.sender_id), (f.template_id))
  ),
  shaped as (
    select a.*, jsonb_build_object('sent', a.sent, 'completed', a.completed, 'declined', a.declined, 'voided', a.voided, 'expired', a.expired,
             'avg_hours_to_complete', a.avg_hours) as numbers
      from agg a
     where (a.g_person = 1 and a.g_template = 1)
        or a.sent + a.completed + a.declined + a.voided + a.expired > 0
  )
  select jsonb_build_object(
      'scope', case when v_role = 'member' then 'own' else 'workspace' end,
      'from', p_from, 'to', p_to,
      'totals', coalesce((select s.numbers from shaped s where s.g_person = 1 and s.g_template = 1),
                         jsonb_build_object('sent', 0, 'completed', 0, 'declined', 0, 'voided', 0, 'expired', 0, 'avg_hours_to_complete', null)),
      'by_person', coalesce((select jsonb_agg(s.numbers || jsonb_build_object('id', s.sender_id,
                       'name', (select coalesce(nullif(btrim(p.display_name), ''), 'Unknown') from public.profiles p where p.id = s.sender_id))
                     order by s.sent desc, s.completed desc, s.sender_id)
                   from shaped s where s.g_person = 0), '[]'::jsonb),
      'by_template', coalesce((select jsonb_agg(s.numbers || jsonb_build_object('id', s.template_id,
                         'name', (select t.name from public.templates t where t.id = s.template_id))
                       order by s.template_id is null, s.sent desc, s.completed desc, s.template_id)
                     from shaped s where s.g_template = 0), '[]'::jsonb))
    into v_out;
  return v_out;
end
$$;

revoke all on function public.report_summary(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function public.report_summary(uuid, uuid, date, date) to service_role;

-- down:
-- drop function public.report_summary(uuid, uuid, date, date); drop index public.envelopes_org_sent_idx;
