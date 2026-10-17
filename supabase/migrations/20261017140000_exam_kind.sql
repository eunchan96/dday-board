-- 시험 일정: 종류(과제/시험), 장소, 종료 시각
-- 시험은 due를 시작 시각으로 쓴다. end_at은 선택.
-- dday_upsert는 p_task에 없는 칸(kind, location, endAt, memo, starred)은 기존 값을 유지한다.

alter table app.tasks
  add column kind     text not null default 'assignment' check (kind in ('assignment', 'exam')),
  add column location text not null default '' check (char_length(location) <= 100),
  add column end_at   timestamptz;

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
    'doneAt', t.done_at, 'createdAt', t.created_at);
$$;

create or replace function public.dday_upsert(p_code text, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_row app.tasks;
  v_done boolean := coalesce((p_task->>'done')::boolean, false);
  v_kind text := case when p_task->>'kind' = 'exam' then 'exam' else 'assignment' end;
  v_end timestamptz := nullif(p_task->>'endAt', '')::timestamptz;
begin
  if (select count(*) from app.tasks where board_id = v_board) >= 500
     and not exists (select 1 from app.tasks where board_id = v_board and id = p_task->>'id') then
    raise exception 'too_many_tasks' using errcode = 'P0001';
  end if;

  insert into app.tasks as t (board_id, id, kind, subject, title, due, end_at, location,
                              done, memo, starred, done_at)
  values (v_board, p_task->>'id', v_kind,
          coalesce(trim(p_task->>'subject'), ''), trim(p_task->>'title'),
          (p_task->>'due')::timestamptz, v_end,
          left(coalesce(trim(p_task->>'location'), ''), 100),
          v_done,
          left(coalesce(p_task->>'memo', ''), 2000),
          coalesce((p_task->>'starred')::boolean, false),
          case when v_done then now() end)
  on conflict (board_id, id) do update
    set subject        = excluded.subject,
        title          = excluded.title,
        due            = excluded.due,
        done           = excluded.done,
        kind           = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.kind     else t.kind     end,
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
