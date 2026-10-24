-- 폰 홈 화면 위젯: 보드 코드와 다른 읽기 전용 열쇠로 다가오는 일정 · 오늘 공부 · 타이머를 읽는다
-- (캘린더 열쇠와 따로: 하나를 새로 만들어도 다른 쪽은 그대로)
alter table app.boards add column if not exists widget_key_hash text unique;

create or replace function public.dday_widget_key(p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_key text;
begin
  v_key := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  update app.boards set widget_key_hash = encode(extensions.digest(v_key, 'sha256'), 'hex') where id = v_board;
  return v_key;
end $$;

create or replace function public.dday_widget_status(p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select widget_key_hash is not null from app.boards where id = app.board_for(p_code);
$$;

revoke execute on function public.dday_widget_key(text), public.dday_widget_status(text) from public;
grant execute on function public.dday_widget_key(text), public.dday_widget_status(text) to anon, authenticated;

create or replace function public.dday_svc_widget(p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_board uuid;
  v_b app.boards;
  v_dstart timestamptz := app.study_day_start(app.study_day(now()));
  v_palette text[] := array['#3D6BE0','#E0703D','#2E9E74','#9A5BD6','#C99A12','#D84C7E','#1E8FA8','#7A7F3A','#B5523B','#5A6FA8'];
  v_colors jsonb;
begin
  select * into v_b from app.boards
   where widget_key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if v_b.id is null then return null; end if;
  v_board := v_b.id;
  -- 과목 색: 화면과 같은 규칙 (바꾼 색, 아니면 과목 이름 가나다순 자리의 기본 색)
  select coalesce(jsonb_object_agg(n, coalesce(v_b.subject_colors ->> n, v_palette[((r - 1) % 10) + 1])), '{}'::jsonb)
    into v_colors
    from (select n, row_number() over (order by n collate "ko-KR-x-icu") r
            from (select distinct subject as n from app.tasks where board_id = v_board and not hidden and subject <> '') d) x;
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    -- 다가오는 일정 (안 끝난 과제 · 할 일, 아직 안 끝난 시험) + 최근 사흘 안의 미제출
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'kind', t.kind, 'title', t.title, 'subject', t.subject,
               'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'missing', t.missing, 'starred', t.starred,
               'color', v_colors ->> t.subject) order by t.due)
        from (select * from app.tasks t
               where t.board_id = v_board and not t.hidden and not t.done
                 and (case when t.kind = 'exam' then coalesce(t.end_at, t.due + interval '1 hour') > now()
                           else t.due > now() or (t.missing and t.due > now() - interval '3 days') end)
               order by t.due limit 8) t), '[]'::jsonb),
    'study', jsonb_build_object(
      'today', coalesce((select sum(s.seconds) from app.study_sessions s
                          where s.board_id = v_board and not s.removed and s.started_at >= v_dstart), 0),
      'goal', v_b.study_goal * 60,
      'timer', v_b.study_timer,
      'timerColor', v_colors ->> (v_b.study_timer ->> 'subject')));
end $$;
revoke execute on function public.dday_svc_widget(text) from public, anon, authenticated;
grant execute on function public.dday_svc_widget(text) to service_role;
