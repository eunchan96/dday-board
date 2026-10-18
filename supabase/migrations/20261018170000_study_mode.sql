-- 공부 모드: 공부 기록, 공부 계획, 하루 목표, 친구
--
-- - 하루는 한국 시간 새벽 5시에 바뀐다 (밤새 공부한 시간은 전날로)
-- - 지우기는 removed 표시로 (다른 기기에도 사라진 걸 알리기 쉽고, 되돌리기도 쉬움)
-- - 친구는 "내가 상대 친구 코드를 넣으면 나는 상대 공부 시간을 본다" (한쪽 방향)
--   친구에게 보이는 건 닉네임, 오늘·이번 주 공부 시간, 지금 공부 중인지뿐

alter table app.boards
  add column if not exists study_goal int not null default 180 check (study_goal between 10 and 1440);

create or replace function app.study_day(p_ts timestamptz)
returns date language sql immutable set search_path = '' as $$
  select ((p_ts at time zone 'Asia/Seoul') - interval '5 hours')::date;
$$;

-- 그 공부 날짜가 시작되는 시각 (새벽 5시, 한국 시간)
create or replace function app.study_day_start(p_day date)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_day::timestamp + interval '5 hours') at time zone 'Asia/Seoul';
$$;

create table app.study_sessions (
  board_id   uuid not null references app.boards(id) on delete cascade,
  id         text not null check (char_length(id) between 1 and 40),
  subject    text not null default '' check (char_length(subject) <= 40),
  task_id    text check (char_length(task_id) <= 40),
  plan_id    text check (char_length(plan_id) <= 40),
  started_at timestamptz not null,
  ended_at   timestamptz not null,
  seconds    int not null check (seconds between 1 and 86400),
  removed    boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (board_id, id),
  check (ended_at >= started_at)
);
create index study_sessions_board_time on app.study_sessions (board_id, started_at);

create table app.study_plans (
  board_id   uuid not null references app.boards(id) on delete cascade,
  id         text not null check (char_length(id) between 1 and 40),
  day        date not null,
  title      text not null check (char_length(title) between 1 and 100),
  subject    text not null default '' check (char_length(subject) <= 40),
  minutes    int check (minutes between 5 and 720),
  done       boolean not null default false,
  removed    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (board_id, id)
);
create index study_plans_board_day on app.study_plans (board_id, day);

create table app.study_profiles (
  board_id    uuid primary key references app.boards(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 20),
  friend_code text not null unique,
  visible     boolean not null default true,
  live_since  timestamptz,
  live_until  timestamptz,
  updated_at  timestamptz not null default now()
);

create table app.study_friends (
  board_id     uuid not null references app.boards(id) on delete cascade,
  friend_board uuid not null references app.boards(id) on delete cascade,
  removed      boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (board_id, friend_board),
  check (board_id <> friend_board)
);
create index study_friends_friend on app.study_friends (friend_board);

alter table app.study_sessions enable row level security;
alter table app.study_plans    enable row level security;
alter table app.study_profiles enable row level security;
alter table app.study_friends  enable row level security;
revoke all on app.study_sessions, app.study_plans, app.study_profiles, app.study_friends
  from public, anon, authenticated;

/* ───── JSON 모양 ───── */
create or replace function app.study_session_json(s app.study_sessions)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'subject', s.subject, 'taskId', s.task_id, 'planId', s.plan_id,
    'startedAt', to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'endedAt',   to_char(s.ended_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'seconds', s.seconds);
$$;

create or replace function app.study_plan_json(p app.study_plans)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'day', to_char(p.day, 'YYYY-MM-DD'), 'title', p.title, 'subject', p.subject,
    'minutes', p.minutes, 'done', p.done);
$$;

create or replace function app.study_profile_json(p_board uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('nickname', nickname, 'friendCode', friend_code, 'visible', visible)
  from app.study_profiles where board_id = p_board;
$$;

-- 친구 코드: 헷갈리는 글자를 뺀 8자, XXXX-XXXX
create or replace function app.new_friend_code()
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  raw text;
  i int;
begin
  loop
    bytes := extensions.gen_random_bytes(8);
    raw := '';
    for i in 0..7 loop
      raw := raw || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
    end loop;
    raw := substr(raw, 1, 4) || '-' || substr(raw, 5, 4);
    exit when not exists (select 1 from app.study_profiles where friend_code = raw);
  end loop;
  return raw;
end $$;

create or replace function app.norm_friend_code(p text)
returns text language sql immutable set search_path = '' as $$
  select case when char_length(c) = 8 then substr(c, 1, 4) || '-' || substr(c, 5, 4) else c end
  from (select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) as c) x;
$$;

/* ───── 내 공부 기록 ───── */
-- p_from 이후의 기록(최대 40일) + 지난 400일 날짜별 합계 + 최근 계획 + 목표 + 프로필
create or replace function public.dday_study(p_code text, p_from timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_from timestamptz := greatest(coalesce(p_from, now() - interval '14 days'), now() - interval '40 days');
begin
  return jsonb_build_object(
    'goal', (select study_goal from app.boards where id = v_board),
    'sessions', coalesce((
      select jsonb_agg(app.study_session_json(s) order by s.started_at)
      from app.study_sessions s
      where s.board_id = v_board and not s.removed and s.started_at >= v_from), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'seconds', sec) order by d)
      from (
        select app.study_day(started_at) as d, sum(seconds)::int as sec
        from app.study_sessions
        where board_id = v_board and not removed and started_at >= now() - interval '400 days'
        group by 1) x), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(app.study_plan_json(p) order by p.day, p.created_at)
      from app.study_plans p
      where p.board_id = v_board and not p.removed and p.day >= app.study_day(now()) - 7), '[]'::jsonb),
    'profile', app.study_profile_json(v_board));
end $$;

create or replace function public.dday_study_add(p_code text, p_session jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_start timestamptz;
  v_end timestamptz;
  v_sec int;
  v_row app.study_sessions;
begin
  begin
    v_start := (p_session->>'startedAt')::timestamptz;
    v_end   := (p_session->>'endedAt')::timestamptz;
    v_sec   := (p_session->>'seconds')::int;
  exception when others then
    raise exception 'invalid_session' using errcode = 'P0001';
  end;
  if v_start is null or v_end is null or v_sec is null
     or coalesce(p_session->>'id', '') = ''
     or v_end < v_start
     or v_end > now() + interval '5 minutes'
     or v_start < now() - interval '40 days'
     or v_sec < 1 or v_sec > extract(epoch from (v_end - v_start)) + 120 then
    raise exception 'invalid_session' using errcode = 'P0001';
  end if;
  if (select count(*) from app.study_sessions where board_id = v_board) >= 20000
     and not exists (select 1 from app.study_sessions where board_id = v_board and id = p_session->>'id') then
    raise exception 'too_many_sessions' using errcode = 'P0001';
  end if;

  insert into app.study_sessions as s (board_id, id, subject, task_id, plan_id, started_at, ended_at, seconds)
  values (v_board, left(p_session->>'id', 40), left(coalesce(trim(p_session->>'subject'), ''), 40),
          nullif(left(p_session->>'taskId', 40), ''), nullif(left(p_session->>'planId', 40), ''),
          v_start, v_end, v_sec)
  on conflict (board_id, id) do update
    set subject = excluded.subject, task_id = excluded.task_id, plan_id = excluded.plan_id,
        started_at = excluded.started_at, ended_at = excluded.ended_at, seconds = excluded.seconds,
        removed = false
  returning * into v_row;
  return app.study_session_json(v_row);
end $$;

create or replace function public.dday_study_remove(p_code text, p_id text, p_removed boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.study_sessions set removed = coalesce(p_removed, true) where board_id = v_board and id = p_id;
end $$;

create or replace function public.dday_study_goal(p_code text, p_minutes int)
returns int language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if p_minutes is null or p_minutes < 10 or p_minutes > 1440 then
    raise exception 'invalid_goal' using errcode = 'P0001';
  end if;
  update app.boards set study_goal = p_minutes where id = v_board;
  return p_minutes;
end $$;

/* ───── 공부 계획 ───── */
create or replace function public.dday_study_plan(p_code text, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_day date;
  v_min int;
  v_row app.study_plans;
begin
  begin
    v_day := (p_plan->>'day')::date;
    v_min := nullif(p_plan->>'minutes', '')::int;
  exception when others then
    raise exception 'invalid_plan' using errcode = 'P0001';
  end;
  if v_day is null or coalesce(p_plan->>'id', '') = '' or coalesce(trim(p_plan->>'title'), '') = ''
     or (v_min is not null and (v_min < 5 or v_min > 720)) then
    raise exception 'invalid_plan' using errcode = 'P0001';
  end if;
  if (select count(*) from app.study_plans where board_id = v_board) >= 3000
     and not exists (select 1 from app.study_plans where board_id = v_board and id = p_plan->>'id') then
    raise exception 'too_many_plans' using errcode = 'P0001';
  end if;

  insert into app.study_plans as p (board_id, id, day, title, subject, minutes, done)
  values (v_board, left(p_plan->>'id', 40), v_day, left(trim(p_plan->>'title'), 100),
          left(coalesce(trim(p_plan->>'subject'), ''), 40), v_min, coalesce((p_plan->>'done')::boolean, false))
  on conflict (board_id, id) do update
    set day = excluded.day, title = excluded.title, subject = excluded.subject,
        minutes = excluded.minutes, done = excluded.done, removed = false, updated_at = now()
  returning * into v_row;
  return app.study_plan_json(v_row);
end $$;

create or replace function public.dday_study_plan_remove(p_code text, p_id text, p_removed boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.study_plans set removed = coalesce(p_removed, true), updated_at = now()
  where board_id = v_board and id = p_id;
end $$;

/* ───── 지금 공부 중 (친구에게 보임) ───── */
-- 켜 둔 동안 몇 분마다 다시 불러 연장한다. 창을 닫으면 15분 뒤 저절로 꺼짐
create or replace function public.dday_study_live(p_code text, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.study_profiles
  set live_since = case when p_on then (case when live_until > now() then live_since else now() end) end,
      live_until = case when p_on then now() + interval '15 minutes' end
  where board_id = v_board;
end $$;

/* ───── 프로필 · 친구 ───── */
create or replace function public.dday_study_profile(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_name text := trim(coalesce(p_nickname, ''));
begin
  if char_length(v_name) < 1 or char_length(v_name) > 20 then
    raise exception 'invalid_nickname' using errcode = 'P0001';
  end if;
  insert into app.study_profiles (board_id, nickname, friend_code)
  values (v_board, v_name, app.new_friend_code())
  on conflict (board_id) do update set nickname = excluded.nickname, visible = true, updated_at = now();
  return app.study_profile_json(v_board);
end $$;

-- 친구 공개 그만하기: 친구 목록에서 내가 사라짐 (다시 켜면 그대로 돌아옴)
create or replace function public.dday_study_profile_hide(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.study_profiles set visible = false, live_since = null, live_until = null, updated_at = now()
  where board_id = v_board;
  return app.study_profile_json(v_board);
end $$;

-- 친구 코드 새로 만들기: 지금까지 나를 추가한 사람들은 더 이상 나를 못 봄
create or replace function public.dday_study_new_code(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if not exists (select 1 from app.study_profiles where board_id = v_board) then
    raise exception 'no_profile' using errcode = 'P0001';
  end if;
  update app.study_profiles set friend_code = app.new_friend_code(), updated_at = now() where board_id = v_board;
  update app.study_friends set removed = true where friend_board = v_board;
  return app.study_profile_json(v_board);
end $$;

create or replace function public.dday_friends(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_today date := app.study_day(now());
  v_dstart timestamptz := app.study_day_start(v_today);
  v_wstart timestamptz := app.study_day_start(date_trunc('week', v_today::timestamp)::date);
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
        'liveSince', case when p.live_until > now() then
                       to_char(p.live_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end
      ) as x
      from app.study_friends f
      join app.study_profiles p on p.board_id = f.friend_board
      where f.board_id = v_board and not f.removed and p.visible
    ) y), '[]'::jsonb);
end $$;

create or replace function public.dday_friend_add(p_code text, p_friend_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_friend uuid;
begin
  select board_id into v_friend from app.study_profiles
  where friend_code = app.norm_friend_code(p_friend_code) and visible;
  if v_friend is null then raise exception 'friend_not_found' using errcode = 'P0001'; end if;
  if v_friend = v_board then raise exception 'friend_self' using errcode = 'P0001'; end if;
  if (select count(*) from app.study_friends where board_id = v_board and not removed) >= 50
     and not exists (select 1 from app.study_friends where board_id = v_board and friend_board = v_friend and not removed) then
    raise exception 'too_many_friends' using errcode = 'P0001';
  end if;
  insert into app.study_friends (board_id, friend_board) values (v_board, v_friend)
  on conflict (board_id, friend_board) do update set removed = false, created_at = now();
  return public.dday_friends(p_code);
end $$;

create or replace function public.dday_friend_remove(p_code text, p_friend_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.study_friends f set removed = true
  from app.study_profiles p
  where f.board_id = v_board and f.friend_board = p.board_id
    and p.friend_code = app.norm_friend_code(p_friend_code);
  return public.dday_friends(p_code);
end $$;

/* ───── 권한 ───── */
revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on function
  public.dday_study(text, timestamptz), public.dday_study_add(text, jsonb), public.dday_study_remove(text, text, boolean),
  public.dday_study_goal(text, int), public.dday_study_plan(text, jsonb), public.dday_study_plan_remove(text, text, boolean),
  public.dday_study_live(text, boolean), public.dday_study_profile(text, text), public.dday_study_profile_hide(text),
  public.dday_study_new_code(text), public.dday_friends(text), public.dday_friend_add(text, text), public.dday_friend_remove(text, text)
  from public;
grant execute on function
  public.dday_study(text, timestamptz), public.dday_study_add(text, jsonb), public.dday_study_remove(text, text, boolean),
  public.dday_study_goal(text, int), public.dday_study_plan(text, jsonb), public.dday_study_plan_remove(text, text, boolean),
  public.dday_study_live(text, boolean), public.dday_study_profile(text, text), public.dday_study_profile_hide(text),
  public.dday_study_new_code(text), public.dday_friends(text), public.dday_friend_add(text, text), public.dday_friend_remove(text, text)
  to anon, authenticated;
