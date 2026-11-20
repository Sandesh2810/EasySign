-- YouNMeSign (EasySign) Phase 3 / migration 24: Content-Security-Policy reports (slice 5, AT3.5, D-70).
-- Browsers report what the report-only policy would have blocked. Only the directive, the blocked origin (or a
-- keyword such as "inline"), the page path and a short sample are kept; no IP address, no device, no query
-- strings. Reports older than 30 days are removed as new ones arrive. Server-only.

create table public.csp_reports (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  directive text not null check (char_length(directive) between 1 and 60),
  blocked text not null default '' check (char_length(blocked) <= 200),
  document_path text not null default '' check (char_length(document_path) <= 200),
  sample text not null default '' check (char_length(sample) <= 80)
);
create index csp_reports_created_idx on public.csp_reports (created_at);
alter table public.csp_reports enable row level security;

create function public.record_csp_reports(p_reports jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  if jsonb_typeof(p_reports) <> 'array' or jsonb_array_length(p_reports) > 10 then
    raise exception 'ES_INVALID: at most ten reports' using errcode = '22023';
  end if;
  insert into public.csp_reports (directive, blocked, document_path, sample)
    select left(r ->> 'directive', 60), left(coalesce(r ->> 'blocked', ''), 200), left(coalesce(r ->> 'documentPath', ''), 200), left(coalesce(r ->> 'sample', ''), 80)
      from jsonb_array_elements(p_reports) r
     where coalesce(r ->> 'directive', '') <> '';
  get diagnostics v_n = row_count;
  delete from public.csp_reports c where c.created_at < now() - interval '30 days';
  return v_n;
end
$$;

-- What the check script prints: reports in the last p_hours, grouped.
create function public.csp_report_summary(p_hours int) returns table (directive text, blocked text, document_path text, reports bigint, last_seen timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.directive, c.blocked, c.document_path, count(*), max(c.created_at)
    from public.csp_reports c
   where c.created_at > now() - make_interval(hours => greatest(1, least(p_hours, 720)))
   group by 1, 2, 3
   order by 4 desc
$$;

revoke all on function public.record_csp_reports(jsonb), public.csp_report_summary(int) from public, anon, authenticated;
grant execute on function public.record_csp_reports(jsonb), public.csp_report_summary(int) to service_role;

-- down (manual): drop function public.csp_report_summary(int); drop function public.record_csp_reports(jsonb); drop table public.csp_reports;
