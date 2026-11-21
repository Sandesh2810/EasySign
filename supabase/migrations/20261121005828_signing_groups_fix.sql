-- YouNMeSign Phase 4 slice 6 (D-81), fix: in envelopes_field_setup_check the signing-group "same fields" check used the
-- table alias f, which clashes with the function's loop variable f ("column reference f.type is ambiguous", 42702), so
-- sending a document with a signing group failed. Found by phase4_slice6_groups.sql (T652). Only the alias changes (fl).
-- down: re-run envelopes_field_setup_check from migration 20261121005244.

create or replace function app_private.envelopes_field_setup_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  f record;
  v_problem text;
  v_dup text;
  g record;
begin
  if old.status = 'draft' and new.status <> 'draft' then
    for f in select x.type, x.page, x.options from public.fields x where x.envelope_id = new.id order by x.page, x.y, x.x loop
      v_problem := app_private.field_options_problem(f.type, f.options);
      if v_problem is not null then
        raise exception 'ES_FIELD_SETUP: a % field on page % is not ready: %', replace(f.type, '_', ' '), f.page, v_problem using errcode = '22023';
      end if;
    end loop;
    select x.options ->> 'name' into v_dup from public.fields x
     where x.envelope_id = new.id and x.options ? 'name'
     group by x.recipient_id, x.options ->> 'name' having count(*) > 1 limit 1;
    if v_dup is not null then
      raise exception 'ES_FIELD_SETUP: two fields are named "%"; each name must be different', v_dup using errcode = '22023';
    end if;
    -- D-81: a signing group has two or more signers in one place in the order, each with the same fields
    for g in select lower(x.signing_group) as k, min(x.signing_group) as label, count(*) as n, count(distinct x.routing_order) as orders
               from public.recipients x where x.envelope_id = new.id and x.signing_group is not null
              group by lower(x.signing_group) loop
      if g.n < 2 then
        raise exception 'ES_GROUP: the signing group "%" needs at least two people', g.label using errcode = '22023';
      end if;
      if g.orders > 1 then
        raise exception 'ES_GROUP: everyone in the signing group "%" must have the same place in the order', g.label using errcode = '22023';
      end if;
      if (select count(distinct q.l) from (
            select (select coalesce(string_agg(fl.type || '|' || fl.page || '|' || fl.x || '|' || fl.y || '|' || fl.w || '|' || fl.h || '|' || fl.required || '|' || fl.options::text,
                                               E'\n' order by fl.page, fl.y, fl.x, fl.type, fl.options::text), '')
                      from public.fields fl where fl.recipient_id = x.id) as l
              from public.recipients x where x.envelope_id = new.id and lower(x.signing_group) = g.k) q) > 1 then
        raise exception 'ES_GROUP: everyone in the signing group "%" must have the same fields', g.label using errcode = '22023';
      end if;
    end loop;
  end if;
  return new;
end
$$;
