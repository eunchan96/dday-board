-- 친구 신청 · 수락: 코드로 신청하면 상대가 수락해야 서로 친구가 된다 (양쪽 모두 서로를 봄)
-- 예전에 코드만 넣어 추가한 친구(한쪽 방향)는 그대로 둔다
alter table app.study_friends add column if not exists status text not null default 'accepted'
  check (status in ('pending', 'accepted'));

-- 신청 (상대가 이미 나에게 신청했으면 바로 서로 친구)
create or replace function public.dday_friend_add(p_code text, p_friend_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_friend uuid;
begin
  if not exists (select 1 from app.study_profiles where board_id = v_board and visible) then
    raise exception 'profile_required' using errcode = 'P0001';
  end if;
  select board_id into v_friend from app.study_profiles
  where friend_code = app.norm_friend_code(p_friend_code) and visible;
  if v_friend is null then raise exception 'friend_not_found' using errcode = 'P0001'; end if;
  if v_friend = v_board then raise exception 'friend_self' using errcode = 'P0001'; end if;
  if (select count(*) from app.study_friends where board_id = v_board and not removed) >= 50
     and not exists (select 1 from app.study_friends where board_id = v_board and friend_board = v_friend and not removed) then
    raise exception 'too_many_friends' using errcode = 'P0001';
  end if;

  if exists (select 1 from app.study_friends where board_id = v_friend and friend_board = v_board
               and not removed and status = 'pending') then
    update app.study_friends set status = 'accepted' where board_id = v_friend and friend_board = v_board;
    insert into app.study_friends (board_id, friend_board, status) values (v_board, v_friend, 'accepted')
    on conflict (board_id, friend_board) do update set removed = false, status = 'accepted';
  else
    -- 이미 친구면 그대로, 아니면 신청
    insert into app.study_friends (board_id, friend_board, status) values (v_board, v_friend, 'pending')
    on conflict (board_id, friend_board) do update
      set status = case when app.study_friends.removed then 'pending' else app.study_friends.status end,
          removed = false, created_at = case when app.study_friends.removed then now() else app.study_friends.created_at end;
  end if;
  return public.dday_friends(p_code);
end $$;

-- 받은 신청 수락
create or replace function public.dday_friend_accept(p_code text, p_friend_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_friend uuid;
begin
  select board_id into v_friend from app.study_profiles where friend_code = app.norm_friend_code(p_friend_code);
  if v_friend is null or not exists (select 1 from app.study_friends where board_id = v_friend and friend_board = v_board
                                        and not removed and status = 'pending') then
    raise exception 'friend_not_found' using errcode = 'P0001';
  end if;
  update app.study_friends set status = 'accepted' where board_id = v_friend and friend_board = v_board;
  insert into app.study_friends (board_id, friend_board, status) values (v_board, v_friend, 'accepted')
  on conflict (board_id, friend_board) do update set removed = false, status = 'accepted';
  return public.dday_friends(p_code);
end $$;

-- 받은 신청 거절 · 보낸 신청 취소 · 친구 끊기 (양쪽 모두)
create or replace function public.dday_friend_remove(p_code text, p_friend_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_friend uuid;
begin
  select board_id into v_friend from app.study_profiles where friend_code = app.norm_friend_code(p_friend_code);
  if v_friend is not null then
    update app.study_friends set removed = true
     where (board_id = v_board and friend_board = v_friend) or (board_id = v_friend and friend_board = v_board);
  end if;
  return public.dday_friends(p_code);
end $$;

-- 받은 신청 · 보낸 신청
create or replace function public.dday_friend_requests(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object('code', p.friend_code, 'nickname', p.nickname,
               'at', to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')) order by f.created_at desc)
        from app.study_friends f join app.study_profiles p on p.board_id = f.board_id
       where f.friend_board = v_board and f.status = 'pending' and not f.removed and p.visible
         and not exists (select 1 from app.study_friends m where m.board_id = v_board and m.friend_board = f.board_id
                           and not m.removed and m.status = 'accepted')), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object('code', p.friend_code, 'nickname', p.nickname) order by f.created_at desc)
        from app.study_friends f join app.study_profiles p on p.board_id = f.friend_board
       where f.board_id = v_board and f.status = 'pending' and not f.removed and p.visible), '[]'::jsonb));
end $$;

-- 친구 목록은 수락된 것만
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
      where f.board_id = v_board and not f.removed and f.status = 'accepted' and p.visible
    ) y), '[]'::jsonb);
end $function$;

revoke execute on function public.dday_friend_accept(text, text), public.dday_friend_requests(text) from public;
grant execute on function public.dday_friend_accept(text, text), public.dday_friend_requests(text) to anon, authenticated;
