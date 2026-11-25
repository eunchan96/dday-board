-- Separate revocable read-only credential. No owner board code or service-role
-- key is used by the MCP server. This table stays in the private app schema.
create table app.mcp_read_grants (
  key_hash bytea primary key check (octet_length(key_hash) = 32),
  board_id uuid not null references app.boards(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now()
);

alter table app.mcp_read_grants enable row level security;
revoke all on app.mcp_read_grants from public, anon, authenticated;

create or replace function public.dday_mcp_list_events(p_key text, p_from date, p_to date, p_source text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_board uuid;
  v_first timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'read_grant_invalid' using errcode = '42501';
  end if;
  select g.board_id into v_board from app.mcp_read_grants g
   where g.key_hash = pg_catalog.sha256(pg_catalog.convert_to(p_key, 'UTF8'));
  if v_board is null then
    raise exception 'read_grant_invalid' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to <= p_from or p_to - p_from > 31
    or p_source is null or p_source not in ('all', 'manual', 'canvas') then
    raise exception 'invalid_range_or_source' using errcode = '22023';
  end if;
  v_first := p_from::timestamp at time zone 'Asia/Seoul';
  v_end := p_to::timestamp at time zone 'Asia/Seoul';

  with sample as (
    select t.id, t.title, t.kind, t.source, t.due, t.end_at, t.all_day
      from app.tasks t
      where t.board_id = v_board and not t.hidden
        and t.due >= v_first and t.due < v_end
        and (p_source = 'all' or t.source = p_source)
      order by t.due, t.id limit 101
  ), ordered as (
    select *, row_number() over (order by due, id) as position from sample
  )
  select jsonb_build_object(
    'timezone', 'Asia/Seoul',
    'truncated', count(*) > 100,
    'events', coalesce(jsonb_agg(jsonb_build_object(
      'title', title, 'kind', kind, 'source', source,
      'date', (due at time zone 'Asia/Seoul')::date,
      'start_or_due_at', case when not all_day then to_char(due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'end_at', case when not all_day then to_char(end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      'all_day', all_day
    ) order by position) filter (where position <= 100), '[]'::jsonb)
  ) into v_result from ordered;
  return v_result;
end
$$;
revoke execute on function public.dday_mcp_list_events(text,date,date,text) from public, anon, authenticated;
grant execute on function public.dday_mcp_list_events(text,date,date,text) to anon;
