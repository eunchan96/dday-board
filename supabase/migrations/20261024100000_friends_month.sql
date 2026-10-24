-- 친구 랭킹: 오늘 · 이번 주에 더해 이번 달 공부 시간도
create or replace function public.dday_friends(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
        'nickname', p.nickname,
        'today', coalesce((select sum(s.seconds) from app.study_sessions s
                           where s.board_id = p.board_id and not s.removed and s.started_at >= v_dstart), 0),
        'week', coalesce((select sum(s.seconds) from app.study_sessions s
                          where s.board_id = p.board_id and not s.removed and s.started_at >= v_wstart), 0),
        'month', coalesce((select sum(s.seconds) from app.study_sessions s
                           where s.board_id = p.board_id and not s.removed and s.started_at >= v_mstart), 0),
        'liveSince', case when p.live_until > now() then
                       to_char(p.live_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end
      ) as x
      from app.study_friends f
      join app.study_profiles p on p.board_id = f.friend_board
      where f.board_id = v_board and not f.removed and p.visible
    ) y), '[]'::jsonb);
end $function$;
