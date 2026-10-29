-- 위젯 이름을 앱 캘린더와 같게: 과목(줄임말) + 종류 — 데이터베이스 과제 · 데이터베이스 휴강 · 데이터베이스 영상 시청
-- 시험은 과목 + 시험 이름, 직접 넣은 할 일은 이름 그대로. 스마트캠퍼스 강의 영상은 기타 '영상 시청'(id video) 종류로 보여 줌
-- 다가오는 일정은 앞으로 2주 (마감이 지나 못 낸 과제는 사흘까지)
create or replace function app.widget_label(t app.tasks, p_short jsonb, p_etc jsonb)
returns text language sql immutable set search_path = '' as $$
  select left(case
    when t.kind = 'exam' then
      case when t.subject = '' then t.title
           when position(t.subject in t.title) > 0 then replace(t.title, t.subject, coalesce(p_short ->> t.subject, t.subject))
           else coalesce(p_short ->> t.subject, t.subject) || ' ' || t.title end
    when t.subject = '' then t.title
    when t.kind = 'todo' and t.source = 'canvas' then
      coalesce(p_short ->> t.subject, t.subject) || ' ' ||
      coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = 'video' limit 1), '영상 시청')
    when t.kind = 'etc' then
      coalesce(p_short ->> t.subject, t.subject) || ' ' ||
      coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = t.etc_type limit 1), '기타')
    when t.kind = 'todo' then t.title
    else coalesce(p_short ->> t.subject, t.subject) || ' 과제'
  end, 60);
$$;

-- 기타 · 강의 영상의 색 (그 밖은 null → 위젯이 종류 색)
create or replace function app.widget_etc_color(t app.tasks, p_etc jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    when t.kind = 'todo' and t.source = 'canvas' then
      coalesce((select e ->> 'color' from jsonb_array_elements(p_etc) e where e ->> 'id' = 'video' limit 1), '#2E9E74')
    when t.kind = 'etc' then
      coalesce((select e ->> 'color' from jsonb_array_elements(p_etc) e where e ->> 'id' = t.etc_type limit 1), '#9AA0AA')
  end;
$$;

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
  select coalesce(jsonb_object_agg(n, coalesce(v_b.subject_colors ->> n, v_palette[((r - 1) % 10) + 1])), '{}'::jsonb)
    into v_colors
    from (select n, row_number() over (order by n collate "ko-KR-x-icu") r
            from (select distinct subject as n from app.tasks where board_id = v_board and not hidden and subject <> '') d) x;
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'kind', t.kind, 'title', t.title,
               'label', app.widget_label(t, v_b.subject_short, v_b.etc_types),
               'subject', coalesce(v_b.subject_short ->> t.subject, t.subject),
               'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'd', to_char(t.due at time zone 'Asia/Seoul', 'YYYY-MM-DD'),
               'missing', t.missing, 'starred', t.starred,
               'color', v_colors ->> t.subject,
               'c', app.widget_etc_color(t, v_b.etc_types)) order by t.due)
        from (select * from app.tasks t
               where t.board_id = v_board and not t.hidden and not t.done
                 and t.due < now() + interval '14 days'
                 and (case when t.kind = 'exam' then coalesce(t.end_at, t.due + interval '1 hour') > now()
                           else t.due > now() or (t.missing and t.due > now() - interval '3 days') end)
               order by t.due limit 60) t), '[]'::jsonb),
    'month', coalesce((
      select jsonb_agg(jsonb_build_object('d', d, 'kind', kind, 'title', title, 'done', done, 'c', c) order by d, due)
        from (select to_char(t.due at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, t.kind, t.due, t.done,
                     app.widget_etc_color(t, v_b.etc_types) as c,
                     app.widget_label(t, v_b.subject_short, v_b.etc_types) as title
                from app.tasks t
               where t.board_id = v_board and not t.hidden
                 and t.due >= date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' - interval '3 months' - interval '7 days'
                 and t.due <  date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' + interval '7 months' + interval '7 days'
               order by t.due limit 500) m), '[]'::jsonb),
    'study', jsonb_build_object(
      'today', coalesce((select sum(s.seconds) from app.study_sessions s
                          where s.board_id = v_board and not s.removed and s.started_at >= v_dstart), 0),
      'goal', v_b.study_goal * 60,
      'timer', v_b.study_timer,
      'timerColor', v_colors ->> (v_b.study_timer ->> 'subject')));
end $$;
