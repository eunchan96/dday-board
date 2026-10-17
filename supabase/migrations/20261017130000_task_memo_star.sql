-- 웹 서비스 개편: 과제 메모, 중요 표시, 완료 시각
-- dday_upsert는 p_task에 memo/starred가 없으면 기존 값을 유지한다 (구버전 위젯 호환).

alter table app.tasks
  add column memo    text not null default '' check (char_length(memo) <= 2000),
  add column starred boolean not null default false,
  add column done_at timestamptz;

create or replace function app.task_json(t app.tasks)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'subject', t.subject, 'title', t.title,
    'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
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
begin
  if (select count(*) from app.tasks where board_id = v_board) >= 500
     and not exists (select 1 from app.tasks where board_id = v_board and id = p_task->>'id') then
    raise exception 'too_many_tasks' using errcode = 'P0001';
  end if;

  insert into app.tasks as t (board_id, id, subject, title, due, done, memo, starred, done_at)
  values (v_board, p_task->>'id', coalesce(trim(p_task->>'subject'), ''), trim(p_task->>'title'),
          (p_task->>'due')::timestamptz, v_done,
          left(coalesce(p_task->>'memo', ''), 2000),
          coalesce((p_task->>'starred')::boolean, false),
          case when v_done then now() end)
  on conflict (board_id, id) do update
    set subject        = excluded.subject,
        title          = excluded.title,
        due            = excluded.due,
        done           = excluded.done,
        memo           = case when p_task ? 'memo'    then excluded.memo    else t.memo    end,
        starred        = case when p_task ? 'starred' then excluded.starred else t.starred end,
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
