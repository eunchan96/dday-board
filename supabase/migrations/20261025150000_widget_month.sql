-- 캘린더 위젯용: 이번 달 일정 (날짜 · 종류 · 이름)
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
    -- 캘린더 위젯: 이번 달(앞뒤 주 포함) 안 끝낸 일정 (날짜 · 종류 · 이름, 시험은 과목 + 이름)
    'month', coalesce((
      select jsonb_agg(jsonb_build_object('d', d, 'kind', kind, 'title', title) order by d, due)
        from (select to_char(t.due at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, t.kind, t.due,
                     left(case when t.kind = 'exam' and t.subject <> '' and position(t.subject in t.title) = 0
                               then t.subject || ' ' || t.title else t.title end, 40) as title
                from app.tasks t
               where t.board_id = v_board and not t.hidden and not t.done
                 and t.due >= date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' - interval '7 days'
                 and t.due <  (date_trunc('month', now() at time zone 'Asia/Seoul') + interval '1 month') at time zone 'Asia/Seoul' + interval '7 days'
               order by t.due limit 120) m), '[]'::jsonb),
    'study', jsonb_build_object(
      'today', coalesce((select sum(s.seconds) from app.study_sessions s
                          where s.board_id = v_board and not s.removed and s.started_at >= v_dstart), 0),
      'goal', v_b.study_goal * 60,
      'timer', v_b.study_timer,
      'timerColor', v_colors ->> (v_b.study_timer ->> 'subject')));
end $$;
revoke execute on function public.dday_svc_widget(text) from public, anon, authenticated;
grant execute on function public.dday_svc_widget(text) to service_role;
