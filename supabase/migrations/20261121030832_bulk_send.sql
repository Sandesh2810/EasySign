-- YouNMeSign Phase 4 slice 9: bulk send (AT4.2, D-85).
-- * A batch comes from a template with exactly one person who signs or approves; each CSV row becomes one document for
--   that person, with optional values for the template's named fields (they become prefilled values, D-80).
-- * create_bulk_batch checks every row again (name, email, duplicate addresses in the file, each value against its field)
--   and stores the good rows as "pending" and the others as "invalid" with their reason: nothing is silently dropped.
-- * The worker works through pending rows under a lease (claim_bulk_items). Each row remembers the draft it created
--   (set_bulk_item_envelope), so a retry continues that draft instead of making a second one: no duplicates. A row waits
--   (not_before) when today's email allowance or the sender's daily limits are used up, so a large batch is spread over
--   days; finish_bulk_item records the outcome and closes the batch when nothing is left.
-- * cancel_bulk_batch stops every row not yet started and returns the drafts made for them (the server deletes them);
--   documents already sent are not touched (cancel them one by one if needed).
-- * Tables are server-only (like templates); pages read through bulk_batch_view / bulk_batch_list, which check access:
--   the person who made the batch, or an owner or administrator of the workspace.
-- Down script at the bottom (commented).

create table public.bulk_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  template_id uuid references public.templates (id) on delete set null,
  created_by uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  delivery text not null check (delivery in ('email', 'link')),
  expires_days int not null check (expires_days in (7, 14, 30, 60)),
  status text not null default 'active' check (status in ('active', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index bulk_batches_org_idx on public.bulk_batches (org_id, created_at desc);

create table public.bulk_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.bulk_batches (id) on delete cascade,
  row_no int not null check (row_no between 1 and 500),
  name text not null default '',
  email text not null default '',
  "values" jsonb not null default '{}'::jsonb,
  status text not null check (status in ('invalid', 'pending', 'sent', 'failed', 'cancelled')),
  reason text check (char_length(reason) <= 500),
  envelope_id uuid references public.envelopes (id) on delete set null,
  not_before timestamptz not null default now(),
  attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  unique (batch_id, row_no)
);
create index bulk_items_due_idx on public.bulk_items (not_before) where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['bulk_batches', 'bulk_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', t || '_deny_all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end
$$;

-- may this person see and cancel this batch?
create function app_private.bulk_access(p_actor uuid, p_batch public.bulk_batches) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_actor is not null and (p_batch.created_by = p_actor or app_private.member_role(p_actor, p_batch.org_id) in ('owner', 'admin'))
$$;
revoke all on function app_private.bulk_access(uuid, public.bulk_batches) from public, anon, authenticated, service_role;

-- ---------- create: every row checked again; good rows pending, the others invalid with their reason ----------
create function public.create_bulk_batch(p_actor uuid, p_template_id uuid, p_delivery text, p_expires_days int, p_rows jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  t public.templates;
  v_role public.template_roles;
  v_id uuid;
  r jsonb;
  v_no int;
  v_name text;
  v_email text;
  v_values jsonb;
  v_reason text;
  k text;
  v text;
  f public.template_fields;
  v_seen jsonb := '{}'::jsonb;
  v_nos int[] := '{}';
  v_valid int := 0;
begin
  if app_private.template_access(p_actor, p_template_id) is null then
    raise exception 'ES_NOT_FOUND: template not found' using errcode = '42501';
  end if;
  select * into t from public.templates x where x.id = p_template_id;
  perform app_private.require_not_suspended(p_actor, t.org_id);
  if (select count(*) from public.template_roles x where x.template_id = p_template_id) <> 1 then
    raise exception 'ES_INVALID: bulk send needs a template with exactly one person' using errcode = '22023';
  end if;
  select * into v_role from public.template_roles x where x.template_id = p_template_id;
  if v_role.role not in ('signer', 'approver') then
    raise exception 'ES_INVALID: bulk send needs a template whose one person signs or approves' using errcode = '22023';
  end if;
  if p_delivery not in ('email', 'link') or p_expires_days not in (7, 14, 30, 60) then
    raise exception 'invalid batch settings' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'ES_INVALID: a batch has 1 to 500 rows' using errcode = '22023';
  end if;
  insert into public.bulk_batches (org_id, template_id, created_by, title, delivery, expires_days)
    values (t.org_id, p_template_id, p_actor, t.name, p_delivery, p_expires_days) returning id into v_id;
  for r in select e.value from jsonb_array_elements(p_rows) as e(value) loop
    v_no := (r ->> 'row_no')::int;
    if v_no is null or v_no not between 1 and 500 or v_no = any (v_nos) then
      raise exception 'invalid row numbers' using errcode = '22023';
    end if;
    v_nos := v_nos || v_no;
    v_name := left(btrim(coalesce(r ->> 'name', '')), 200);
    v_email := left(lower(btrim(coalesce(r ->> 'email', ''))), 300);
    v_values := case when jsonb_typeof(r -> 'values') = 'object' then r -> 'values' else '{}'::jsonb end;
    v_reason := null;
    if v_name = '' then v_reason := 'The name is empty.';
    elsif char_length(v_name) > 120 then v_reason := 'The name is longer than 120 characters.';
    elsif v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then v_reason := '"' || left(v_email, 80) || '" is not a valid email address.';
    elsif v_seen ? v_email then v_reason := 'The same email address is already on row ' || (v_seen ->> v_email) || '.';
    else
      for k, v in select e.key, e.value from jsonb_each_text(v_values) as e(key, value) loop
        select * into f from public.template_fields x where x.template_id = p_template_id and x.options ->> 'name' = k limit 1;
        if not found then
          v_reason := '"' || left(k, 40) || '" is not a named field of this template.';
        elsif char_length(v) > 500 then
          v_reason := k || ': longer than 500 characters.';
        else
          v_reason := app_private.field_value_problem(f.type, f.options, btrim(v));
          if v_reason is not null then v_reason := k || ': ' || v_reason; end if;
        end if;
        exit when v_reason is not null;
      end loop;
    end if;
    if v_reason is null then
      v_seen := v_seen || jsonb_build_object(v_email, v_no);
      v_valid := v_valid + 1;
    end if;
    insert into public.bulk_items (batch_id, row_no, name, email, "values", status, reason)
      values (v_id, v_no, v_name, v_email, v_values, case when v_reason is null then 'pending' else 'invalid' end, v_reason);
  end loop;
  if v_valid = 0 then
    update public.bulk_batches b set status = 'done', finished_at = now() where b.id = v_id;
  end if;
  perform app_private.audit_append('org:' || t.org_id::text, t.org_id, null, null, 'user', p_actor, 'bulk_batch_created',
    jsonb_build_object('batch_id', v_id, 'template_id', p_template_id, 'rows', jsonb_array_length(p_rows), 'valid', v_valid,
      'invalid', jsonb_array_length(p_rows) - v_valid, 'delivery', p_delivery));
  return v_id;
end
$$;

-- ---------- the worker: claim, remember the draft, finish ----------
create function public.claim_bulk_items(p_limit int default 5) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  with c as (
    select i.id from public.bulk_items i join public.bulk_batches b on b.id = i.batch_id
     where i.status = 'pending' and i.not_before <= now() and (i.locked_until is null or i.locked_until < now()) and b.status = 'active'
     order by b.created_at, i.row_no
     limit greatest(1, least(coalesce(p_limit, 5), 20))
     for update of i skip locked
  ), u as (
    update public.bulk_items i set locked_until = now() + interval '10 minutes', attempts = i.attempts + 1, updated_at = now()
      from c where i.id = c.id returning i.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'batch_id', u.batch_id, 'row_no', u.row_no, 'name', u.name, 'email', u.email, 'values', u."values",
           'envelope_id', u.envelope_id, 'attempts', u.attempts, 'created_by', b.created_by, 'template_id', b.template_id,
           'org_id', b.org_id, 'title', b.title, 'delivery', b.delivery, 'expires_days', b.expires_days) order by u.row_no), '[]'::jsonb)
    into v
    from u join public.bulk_batches b on b.id = u.batch_id;
  return v;
end
$$;

create function public.set_bulk_item_envelope(p_item_id uuid, p_envelope_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.bulk_items i set envelope_id = p_envelope_id, updated_at = now() where i.id = p_item_id and i.envelope_id is null
$$;

create function public.finish_bulk_item(p_item_id uuid, p_status text, p_reason text, p_not_before timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.bulk_items;
  b public.bulk_batches;
  v_status text := p_status;
begin
  if p_status not in ('sent', 'failed', 'pending') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  select * into i from public.bulk_items x where x.id = p_item_id for update;
  select * into b from public.bulk_batches x where x.id = i.batch_id for update;
  -- a row that has to wait, in a batch cancelled meanwhile, is cancelled
  if v_status = 'pending' and b.status = 'cancelled' then v_status := 'cancelled'; end if;
  update public.bulk_items x
     set status = v_status, reason = left(p_reason, 500), not_before = coalesce(p_not_before, now()), locked_until = null, updated_at = now()
   where x.id = p_item_id;
  if b.status = 'active' and not exists (select 1 from public.bulk_items x where x.batch_id = b.id and x.status = 'pending') then
    update public.bulk_batches x set status = 'done', finished_at = now() where x.id = b.id;
    insert into public.notifications (org_id, user_id, kind, payload)
      values (b.org_id, b.created_by, 'bulk_done', jsonb_build_object('batch_id', b.id, 'title', b.title,
        'sent', (select count(*) from public.bulk_items x where x.batch_id = b.id and x.status = 'sent'),
        'failed', (select count(*) from public.bulk_items x where x.batch_id = b.id and x.status in ('failed', 'invalid'))));
  end if;
end
$$;

-- the row's values become prefilled values of the draft's named fields (checked like a signer's answer)
create function public.bulk_apply_values(p_envelope_id uuid, p_values jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  v text;
  f public.fields;
  v_problem text;
begin
  if (select e.status from public.envelopes e where e.id = p_envelope_id) is distinct from 'draft' then
    raise exception 'ES_NOT_DRAFT: values can only be set on a draft' using errcode = '42501';
  end if;
  for k, v in select e.key, e.value from jsonb_each_text(coalesce(p_values, '{}'::jsonb)) as e(key, value) loop
    select * into f from public.fields x where x.envelope_id = p_envelope_id and x.options ->> 'name' = k limit 1;
    if not found then
      raise exception 'ES_INVALID: "%" is not a named field of this document', left(k, 40) using errcode = '22023';
    end if;
    v_problem := app_private.field_value_problem(f.type, f.options, btrim(v));
    if v_problem is not null then
      raise exception 'ES_INVALID: %: %', k, v_problem using errcode = '22023';
    end if;
    update public.fields x set options = x.options || jsonb_build_object('prefill', btrim(v)) where x.id = f.id;
  end loop;
end
$$;

-- ---------- the sender: cancel, view, list ----------
create function public.cancel_bulk_batch(p_actor uuid, p_batch_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b public.bulk_batches;
  v_drafts jsonb;
  v_n int;
begin
  select * into b from public.bulk_batches x where x.id = p_batch_id for update;
  if not found or not app_private.bulk_access(p_actor, b) then
    raise exception 'ES_NOT_FOUND: batch not found' using errcode = '42501';
  end if;
  if b.status <> 'active' then
    raise exception 'ES_NOT_ACTIVE: this batch has finished or was already cancelled' using errcode = '22023';
  end if;
  update public.bulk_batches x set status = 'cancelled', finished_at = now() where x.id = p_batch_id;
  -- rows being worked on right now finish normally; every other row not yet sent is cancelled
  with c as (
    update public.bulk_items i set status = 'cancelled', reason = 'Cancelled by the sender.', locked_until = null, updated_at = now()
     where i.batch_id = p_batch_id and i.status = 'pending' and (i.locked_until is null or i.locked_until < now())
    returning i.envelope_id)
  select count(*), coalesce(jsonb_agg(c.envelope_id) filter (where c.envelope_id is not null
           and exists (select 1 from public.envelopes e where e.id = c.envelope_id and e.status = 'draft')), '[]'::jsonb)
    into v_n, v_drafts from c;
  perform app_private.audit_append('org:' || b.org_id::text, b.org_id, null, null, 'user', p_actor, 'bulk_batch_cancelled',
    jsonb_build_object('batch_id', p_batch_id, 'rows_cancelled', v_n));
  return v_drafts;
end
$$;

create function public.bulk_batch_view(p_actor uuid, p_batch_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.bulk_batches;
begin
  select * into b from public.bulk_batches x where x.id = p_batch_id;
  if not found or not app_private.bulk_access(p_actor, b) then
    raise exception 'ES_NOT_FOUND: batch not found' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'id', b.id, 'title', b.title, 'template_id', b.template_id, 'delivery', b.delivery, 'expires_days', b.expires_days,
    'status', b.status, 'created_at', b.created_at, 'finished_at', b.finished_at,
    'counts', (select jsonb_object_agg(s.status, s.n) from (select i.status, count(*) as n from public.bulk_items i where i.batch_id = b.id group by i.status) s),
    'next_at', (select min(i.not_before) from public.bulk_items i where i.batch_id = b.id and i.status = 'pending'),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('row_no', i.row_no, 'name', i.name, 'email', i.email, 'status', i.status,
                'reason', i.reason, 'envelope_id', i.envelope_id, 'not_before', i.not_before) order by i.row_no), '[]'::jsonb)
                from public.bulk_items i where i.batch_id = b.id));
end
$$;

create function public.bulk_batch_list(p_actor uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'status', b.status, 'created_at', b.created_at,
           'rows', (select count(*) from public.bulk_items i where i.batch_id = b.id),
           'sent', (select count(*) from public.bulk_items i where i.batch_id = b.id and i.status = 'sent')) order by b.created_at desc), '[]'::jsonb)
    from (select x.* from public.bulk_batches x where app_private.bulk_access(p_actor, x) order by x.created_at desc limit 20) b
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.create_bulk_batch(uuid, uuid, text, int, jsonb)',
    'public.claim_bulk_items(int)',
    'public.set_bulk_item_envelope(uuid, uuid)',
    'public.finish_bulk_item(uuid, text, text, timestamptz)',
    'public.bulk_apply_values(uuid, jsonb)',
    'public.cancel_bulk_batch(uuid, uuid)',
    'public.bulk_batch_view(uuid, uuid)',
    'public.bulk_batch_list(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

-- down:
-- drop function public.bulk_batch_list(uuid); drop function public.bulk_batch_view(uuid, uuid); drop function public.cancel_bulk_batch(uuid, uuid);
-- drop function public.bulk_apply_values(uuid, jsonb); drop function public.finish_bulk_item(uuid, text, text, timestamptz);
-- drop function public.set_bulk_item_envelope(uuid, uuid); drop function public.claim_bulk_items(int);
-- drop function public.create_bulk_batch(uuid, uuid, text, int, jsonb); drop function app_private.bulk_access(uuid, public.bulk_batches);
-- drop table public.bulk_items; drop table public.bulk_batches;
