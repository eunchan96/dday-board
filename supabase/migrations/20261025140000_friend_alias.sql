-- 친구 목록: 친구마다 내가 부르는 이름(별명). 나에게만 보이고, 비우면 친구의 닉네임
alter table app.study_friends add column if not exists alias text;

create or replace function public.dday_friend_alias(p_code text, p_friend_code text, p_alias text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_alias text := nullif(btrim(coalesce(p_alias, '')), '');
begin
  if v_alias is not null and char_length(v_alias) > 20 then
    raise exception 'invalid_nickname' using errcode = 'P0001';
  end if;
  update app.study_friends f set alias = v_alias
    from app.study_profiles p
   where f.board_id = v_board and f.friend_board = p.board_id
     and p.friend_code = app.norm_friend_code(p_friend_code) and not f.removed;
  return public.dday_friends(p_code);
end $$;

revoke execute on function public.dday_friend_alias(text, text, text) from public;
grant execute on function public.dday_friend_alias(text, text, text) to anon, authenticated;

create or replace function public.dday_friends(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_today date := app.study_day(now());
  v_dstart timestamptz := app.study_day_start(v_today);
  v_wstart timestamptz := app.study_day_start(date_trunc('week', v_today::timestamp)::date);
  v_mstart timestamptz := app.study_day_start(date_trunc('month', v_today::timestamp)::date);
begin
  return coalesce((
    select jsonb_agg(x order by (x->>'today')::int desc, x->>'nickname')
    from (
      select jsonb_build_object(
        'code', p.friend_code,
        'nickname', coalesce(f.alias, p.nickname),
        'realName', p.nickname,
        'alias', f.alias,
        'today', coalesce((select sum(s.seconds) from app.study_sessions s
                           where s.board_id = p.board_id and not s.removed and s.started_at >= v_dstart), 0),
        'week', coalesce((select sum(s.seconds) from app.study_sessions s
                          where s.board_id = p.board_id and not s.removed and s.started_at >= v_wstart), 0),
        'month', coalesce((select sum(s.seconds) from app.study_sessions s
                           where s.board_id = p.board_id and not s.removed and s.started_at >= v_mstart), 0),
        'liveSince', case when p.live_until > now() then
                       to_char(p.live_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
        'since', to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ) as x
      from app.study_friends f
      join app.study_profiles p on p.board_id = f.friend_board
      where f.board_id = v_board and not f.removed and f.status = 'accepted' and p.visible
    ) y), '[]'::jsonb);
end $$;
