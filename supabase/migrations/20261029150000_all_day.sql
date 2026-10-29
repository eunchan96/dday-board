-- 종일 일정 (휴강처럼 시각이 없는 일정): 마감은 그날 23:59:59로 두고 표시만 "종일"
alter table app.tasks add column if not exists all_day boolean not null default false;

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
    'missing', t.missing, 'etcType', t.etc_type, 'allDay', t.all_day);
$$;

-- 저장: allDay를 받음 (보내지 않으면 그대로). 종일이면 끝나는 시각은 비움
create or replace function public.dday_upsert(p_code text, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_row app.tasks;
  v_done boolean := coalesce((p_task->>'done')::boolean, false);
  v_kind text := case when p_task->>'kind' in ('exam', 'etc') then p_task->>'kind'
                      when p_task->>'kind' = 'todo' then 'etc' else 'assignment' end;
  v_end timestamptz := case when coalesce((p_task->>'allDay')::boolean, false) then null else nullif(p_task->>'endAt', '')::timestamptz end;
  v_etc text := case when p_task->>'kind' = 'todo' then 'todo'
                     when v_kind = 'etc' then left(nullif(btrim(coalesce(p_task->>'etcType', '')), ''), 20) end;
begin
  if (select count(*) from app.tasks where board_id = v_board) >= 500
     and not exists (select 1 from app.tasks where board_id = v_board and id = p_task->>'id') then
    raise exception 'too_many_tasks' using errcode = 'P0001';
  end if;

  insert into app.tasks as t (board_id, id, kind, subject, title, due, end_at, location,
                              done, memo, starred, done_at, etc_type, all_day)
  values (v_board, p_task->>'id', v_kind,
          coalesce(trim(p_task->>'subject'), ''), trim(p_task->>'title'),
          (p_task->>'due')::timestamptz, v_end,
          left(coalesce(trim(p_task->>'location'), ''), 100),
          v_done,
          left(coalesce(p_task->>'memo', ''), 2000),
          coalesce((p_task->>'starred')::boolean, false),
          case when v_done then now() end,
          v_etc,
          coalesce((p_task->>'allDay')::boolean, false))
  on conflict (board_id, id) do update
    set subject        = excluded.subject,
        title          = excluded.title,
        due            = excluded.due,
        done           = excluded.done,
        kind           = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.kind     else t.kind     end,
        etc_type       = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.etc_type else t.etc_type end,
        all_day        = case when p_task ? 'allDay'   then excluded.all_day  else t.all_day  end,
        end_at         = case when coalesce((p_task->>'allDay')::boolean, false) then null
                              when p_task ? 'endAt'    then excluded.end_at   else t.end_at   end,
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


-- 알림: 종일 일정은 하루 단위 알림만 (자정 직전 "1시간 남음" 같은 알림은 보내지 않음)
create or replace function public.dday_svc_push_due()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'subId', c.sub_id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
      'taskId', t.id, 'title', t.title, 'subject', t.subject, 'kind', t.kind,
      'location', t.location, 'due', t.due, 'lead', c.lead))
    from (
      select s.id as sub_id, t.board_id, t.id as task_id,
             (select min(l) from unnest(s.leads) l
               where now() >= t.due - make_interval(mins => l) and (not t.all_day or l >= 1440)) as lead
      from app.push_subs s
      join app.tasks t on t.board_id = s.board_id
      where not t.done and not t.hidden
        and t.due > now()
        and t.due <= now() + make_interval(mins => coalesce((select max(l) from unnest(s.leads) l), 0))
    ) c
    join app.push_subs s on s.id = c.sub_id
    join app.tasks t on t.board_id = c.board_id and t.id = c.task_id
    where c.lead is not null
      and not exists (
        select 1 from app.push_sent p
        where p.sub_id = c.sub_id and p.task_id = c.task_id and p.due = t.due and p.lead <= c.lead)
  ), '[]'::jsonb);
end $$;
