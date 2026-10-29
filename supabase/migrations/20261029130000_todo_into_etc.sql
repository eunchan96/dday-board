-- '할 일'을 따로 두지 않고 기타의 한 종류로: 기본 종류 '할 일' · '휴강'을 넣고, 직접 만든 할 일은 기타 · 할 일로 옮김
-- (스마트캠퍼스 강의 영상은 동기화가 할 일로 다루므로 그대로 두고, 화면에서 기타 '영상 시청'으로 보여 줌)
alter table app.boards alter column etc_types set default
  '[{"id":"todo","name":"할 일","color":"#3D6BE0"},{"id":"cancel","name":"휴강","color":"#9AA0AA"}]'::jsonb;

update app.boards b set etc_types =
  (case when b.etc_types @> '[{"id":"todo"}]' then '[]'::jsonb else '[{"id":"todo","name":"할 일","color":"#3D6BE0"}]'::jsonb end)
  || (case when exists (select 1 from jsonb_array_elements(b.etc_types) e where e->>'name' = '휴강') then '[]'::jsonb
           else '[{"id":"cancel","name":"휴강","color":"#9AA0AA"}]'::jsonb end)
  || b.etc_types;

update app.tasks set kind = 'etc', etc_type = 'todo', updated_at = now()
 where kind = 'todo' and source = 'manual';

-- 예전 화면(캐시)이 보내는 '할 일'도 기타 · 할 일로 받음
create or replace function public.dday_upsert(p_code text, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_row app.tasks;
  v_done boolean := coalesce((p_task->>'done')::boolean, false);
  v_kind text := case when p_task->>'kind' in ('exam', 'etc') then p_task->>'kind'
                      when p_task->>'kind' = 'todo' then 'etc' else 'assignment' end;
  v_end timestamptz := nullif(p_task->>'endAt', '')::timestamptz;
  v_etc text := case when p_task->>'kind' = 'todo' then 'todo'
                     when v_kind = 'etc' then left(nullif(btrim(coalesce(p_task->>'etcType', '')), ''), 20) end;
begin
  if (select count(*) from app.tasks where board_id = v_board) >= 500
     and not exists (select 1 from app.tasks where board_id = v_board and id = p_task->>'id') then
    raise exception 'too_many_tasks' using errcode = 'P0001';
  end if;

  insert into app.tasks as t (board_id, id, kind, subject, title, due, end_at, location,
                              done, memo, starred, done_at, etc_type)
  values (v_board, p_task->>'id', v_kind,
          coalesce(trim(p_task->>'subject'), ''), trim(p_task->>'title'),
          (p_task->>'due')::timestamptz, v_end,
          left(coalesce(trim(p_task->>'location'), ''), 100),
          v_done,
          left(coalesce(p_task->>'memo', ''), 2000),
          coalesce((p_task->>'starred')::boolean, false),
          case when v_done then now() end,
          v_etc)
  on conflict (board_id, id) do update
    set subject        = excluded.subject,
        title          = excluded.title,
        due            = excluded.due,
        done           = excluded.done,
        kind           = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.kind     else t.kind     end,
        etc_type       = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.etc_type else t.etc_type end,
        end_at         = case when p_task ? 'endAt'    then excluded.end_at   else t.end_at   end,
        location       = case when p_task ? 'location' then excluded.location else t.location end,
        memo           = case when p_task ? 'memo'     then excluded.memo     else t.memo     end,
        starred        = case when p_task ? 'starred'  then excluded.starred  else t.starred  end,
        done_at        = case when excluded.done and not t.done then now()
                              when not excluded.done then null
                              else t.done_at end,
        title_custom   = t.title_custom   or (t.source = 'canvas' and excluded.title   is distinct from t.title),
        subject_custom = t.subject_custom or (t.source = 'canvas' and excluded.subject is distinct from t.subject),
        due_custom     = t.due_custom     or (t.source = 'canvas' and excluded.due     is distinct from t.due),
        updated_at     = now()
  returning * into v_row;

  return app.task_json(v_row);
end $$;

-- 위젯 이름: 기타는 이름이 종류 이름과 같으면(비워 둔 것) "과목 종류", 직접 적었으면 "과목 이름" (시험처럼)
create or replace function app.widget_label(t app.tasks, p_short jsonb, p_etc jsonb)
returns text language sql immutable set search_path = '' as $$
  with s as (select coalesce(p_short ->> t.subject, t.subject) as subj,
                    coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = t.etc_type limit 1), '기타') as etc_name)
  select left(case
    when t.kind = 'exam' then
      case when t.subject = '' then t.title
           when position(t.subject in t.title) > 0 then replace(t.title, t.subject, s.subj)
           else s.subj || ' ' || t.title end
    when t.kind = 'todo' and t.source = 'canvas' then
      case when t.subject = '' then t.title else s.subj || ' ' ||
        coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = 'video' limit 1), '영상 시청') end
    when t.kind = 'etc' then
      case when t.subject = '' then t.title
           when t.title = s.etc_name then s.subj || ' ' || s.etc_name
           when position(t.subject in t.title) > 0 then replace(t.title, t.subject, s.subj)
           else s.subj || ' ' || t.title end
    when t.subject = '' or t.kind = 'todo' then t.title
    else s.subj || ' 과제'
  end, 60) from s;
$$;

-- 다가오는 일정: 오늘부터 2주 (첫 줄은 늘 오늘이라 지난 날짜 것은 빼고)
create or replace function public.dday_svc_widget(p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_board uuid;
  v_b app.boards;
  v_dstart timestamptz := app.study_day_start(app.study_day(now()));
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
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
    'today', to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'),
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
                 and t.due >= v_today and t.due < v_today + interval '14 days'
                 and (case when t.kind = 'exam' then coalesce(t.end_at, t.due + interval '1 hour') > now()
                           else t.due > now() or t.missing end)
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
