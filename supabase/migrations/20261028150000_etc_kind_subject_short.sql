-- 1) '기타' 종류: 보드마다 이름 · 색을 정한 하위 종류(예: 휴강 · 회색)를 두고, 일정은 그중 하나를 고른다
-- 2) 과목 줄임말: 캘린더처럼 좁은 곳에서 과목 이름 대신 쓸 짧은 이름
alter table app.boards add column if not exists etc_types jsonb not null default '[]'::jsonb;
alter table app.boards add column if not exists subject_short jsonb not null default '{}'::jsonb;

alter table app.tasks drop constraint if exists tasks_kind_check;
alter table app.tasks add constraint tasks_kind_check check (kind = any (array['assignment', 'exam', 'todo', 'etc']));
alter table app.tasks add column if not exists etc_type text;
alter table app.tasks drop constraint if exists tasks_etc_type_check;
alter table app.tasks add constraint tasks_etc_type_check check (etc_type is null or char_length(etc_type) <= 20);

create or replace function app.task_json(t app.tasks)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'subject', t.subject, 'title', t.title,
    'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'endAt', case when t.end_at is null then null
                  else to_char(t.end_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'location', t.location,
    'done', t.done, 'updatedAt', t.updated_at,
    'source', t.source, 'link', t.link,
    'memo', t.memo, 'starred', t.starred,
    'doneAt', t.done_at, 'createdAt', t.created_at,
    'submittedAt', t.submitted_at, 'submission', t.submission,
    'missing', t.missing, 'etcType', t.etc_type);
$$;

create or replace function public.dday_upsert(p_code text, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_row app.tasks;
  v_done boolean := coalesce((p_task->>'done')::boolean, false);
  v_kind text := case when p_task->>'kind' in ('exam', 'todo', 'etc') then p_task->>'kind' else 'assignment' end;
  v_end timestamptz := nullif(p_task->>'endAt', '')::timestamptz;
  v_etc text := case when v_kind = 'etc' then left(nullif(btrim(coalesce(p_task->>'etcType', '')), ''), 20) end;
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

create or replace function public.dday_subject_prefs(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select jsonb_build_object('colors', subject_colors, 'order', subject_order,
                                    'custom', custom_subjects, 'groups', subject_groups,
                                    'short', subject_short, 'etc', etc_types)
            from app.boards where id = v_board);
end $$;

-- 과목 줄임말 (빈 값이면 지움)
create or replace function public.dday_set_subject_short(p_code text, p_subject text, p_short text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_name text := btrim(coalesce(p_subject, ''));
  v_short text := btrim(coalesce(p_short, ''));
  v_out jsonb;
begin
  if char_length(v_name) not between 1 and 40 then raise exception 'invalid_subject' using errcode = 'P0001'; end if;
  if char_length(v_short) > 10 then raise exception 'invalid_short' using errcode = 'P0001'; end if;
  update app.boards
     set subject_short = case when v_short = '' or v_short = v_name then subject_short - v_name
                              else subject_short || jsonb_build_object(v_name, v_short) end
   where id = v_board
  returning subject_short into v_out;
  if (select count(*) from jsonb_object_keys(v_out)) > 200 then
    raise exception 'too_many_subjects' using errcode = 'P0001';
  end if;
  return v_out;
end $$;

-- 기타 종류 목록 통째로 저장: [{ id, name, color }]
create or replace function public.dday_set_etc_types(p_code text, p_list jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_out jsonb;
begin
  if jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) > 30 then
    raise exception 'invalid_etc' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) e
              where coalesce(e->>'id', '') !~ '^[a-z0-9]{1,20}$'
                 or char_length(btrim(coalesce(e->>'name', ''))) not between 1 and 20
                 or coalesce(e->>'color', '') !~ '^#[0-9A-Fa-f]{6}$') then
    raise exception 'invalid_etc' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'name', btrim(e->>'name'), 'color', upper(e->>'color')) order by o), '[]'::jsonb)
    into v_out
    from jsonb_array_elements(p_list) with ordinality as a(e, o);
  update app.boards set etc_types = v_out where id = v_board;
  return v_out;
end $$;

revoke execute on function public.dday_set_subject_short(text, text, text), public.dday_set_etc_types(text, jsonb) from public;
grant execute on function public.dday_set_subject_short(text, text, text), public.dday_set_etc_types(text, jsonb) to anon, authenticated;

-- 위젯: 좁은 칸이라 과목은 줄임말로, 기타 일정은 그 종류의 색(c)을 함께
create or replace function public.dday_svc_widget(p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_board uuid;
  v_b app.boards;
  v_dstart timestamptz := app.study_day_start(app.study_day(now()));
  v_palette text[] := array['#3D6BE0','#E0703D','#2E9E74','#9A5BD6','#C99A12','#D84C7E','#1E8FA8','#7A7F3A','#B5523B','#5A6FA8'];
  v_colors jsonb;
  v_etc jsonb;
begin
  select * into v_b from app.boards
   where widget_key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if v_b.id is null then return null; end if;
  v_board := v_b.id;
  select coalesce(jsonb_object_agg(n, coalesce(v_b.subject_colors ->> n, v_palette[((r - 1) % 10) + 1])), '{}'::jsonb)
    into v_colors
    from (select n, row_number() over (order by n collate "ko-KR-x-icu") r
            from (select distinct subject as n from app.tasks where board_id = v_board and not hidden and subject <> '') d) x;
  select coalesce(jsonb_object_agg(e->>'id', e->>'color'), '{}'::jsonb) into v_etc
    from jsonb_array_elements(v_b.etc_types) e;
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'kind', t.kind, 'title', t.title,
               'subject', coalesce(v_b.subject_short ->> t.subject, t.subject),
               'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'missing', t.missing, 'starred', t.starred,
               'color', v_colors ->> t.subject,
               'c', case when t.kind = 'etc' then v_etc ->> t.etc_type end) order by t.due)
        from (select * from app.tasks t
               where t.board_id = v_board and not t.hidden and not t.done
                 and (case when t.kind = 'exam' then coalesce(t.end_at, t.due + interval '1 hour') > now()
                           else t.due > now() or (t.missing and t.due > now() - interval '3 days') end)
               order by t.due limit 8) t), '[]'::jsonb),
    'month', coalesce((
      select jsonb_agg(jsonb_build_object('d', d, 'kind', kind, 'title', title, 'done', done, 'c', c) order by d, due)
        from (select to_char(t.due at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, t.kind, t.due, t.done,
                     case when t.kind = 'etc' then v_etc ->> t.etc_type end as c,
                     left(case when t.kind = 'exam' and t.subject <> '' and position(t.subject in t.title) = 0
                               then coalesce(v_b.subject_short ->> t.subject, t.subject) || ' ' || t.title else t.title end, 40) as title
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
