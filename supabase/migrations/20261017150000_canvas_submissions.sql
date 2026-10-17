-- 스마트캠퍼스 전체 가져오기: 제출 여부와 제출 파일
-- - 항목에 submitted가 있으면 그 값으로 완료를 정한다 (없으면 기존처럼 마감 지남 여부로 추정).
-- - 이미 있는 과제는 제출했을 때만 완료로 바꾸고, 완료를 풀지는 않는다.
-- - submission: { "type": "online_upload", "files": [{ "name": "…", "size": 123 }], "url": "…" }
--   파일 다운로드 주소(인증 토큰 포함)는 저장하지 않는다.

alter table app.tasks
  add column submitted_at timestamptz,
  add column submission   jsonb check (submission is null or pg_column_size(submission) <= 8000);

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
    'submittedAt', t.submitted_at, 'submission', t.submission);
$$;

create or replace function public.dday_svc_canvas_merge(p_board uuid, p_items jsonb, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_added int := 0;
  v_updated int := 0;
  v_room int;
begin
  if p_error is not null then
    update app.boards set canvas_error = left(p_error, 300), canvas_synced_at = now() where id = p_board;
    return jsonb_build_object('added', 0, 'updated', 0, 'error', p_error);
  end if;

  with _items as (
    select distinct on (x->>'id') x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(trim(x->>'subject'), ''), 40) as subject,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link,
           case when x ? 'submitted' then (x->>'submitted')::boolean end as submitted,
           nullif(x->>'submittedAt', '')::timestamptz as submitted_at,
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%'
      and coalesce(trim(x->>'title'), '') <> ''
      and coalesce(x->>'due', '') <> ''
  )
  update app.tasks t
     set canvas_title   = i.title,
         canvas_subject = i.subject,
         canvas_due     = i.due,
         link           = coalesce(i.link, t.link),
         title          = case when t.title_custom   then t.title   else i.title   end,
         subject        = case when t.subject_custom then t.subject else i.subject end,
         due            = case when t.due_custom     then t.due     else i.due     end,
         submitted_at   = coalesce(i.submitted_at, t.submitted_at),
         submission     = coalesce(i.submission, t.submission),
         done           = t.done or coalesce(i.submitted, false),
         done_at        = case when not t.done and coalesce(i.submitted, false)
                               then coalesce(i.submitted_at, now()) else t.done_at end,
         updated_at     = now()
    from _items i
   where t.board_id = p_board and t.id = i.id
     and ( (t.canvas_title, t.canvas_subject, t.canvas_due) is distinct from (i.title, i.subject, i.due)
        or (i.link is not null and i.link is distinct from t.link)
        or (i.submitted_at is not null and i.submitted_at is distinct from t.submitted_at)
        or (i.submission is not null and i.submission is distinct from t.submission)
        or (coalesce(i.submitted, false) and not t.done) );
  get diagnostics v_updated = row_count;

  v_room := greatest(0, 500 - (select count(*) from app.tasks where board_id = p_board));

  with _items as (
    select distinct on (x->>'id') x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(trim(x->>'subject'), ''), 40) as subject,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link,
           case when x ? 'submitted' then (x->>'submitted')::boolean end as submitted,
           nullif(x->>'submittedAt', '')::timestamptz as submitted_at,
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%'
      and coalesce(trim(x->>'title'), '') <> ''
      and coalesce(x->>'due', '') <> ''
  )
  insert into app.tasks (board_id, id, subject, title, due, done, done_at, source, link,
                         canvas_title, canvas_subject, canvas_due, submitted_at, submission)
  select p_board, i.id, i.subject, i.title, i.due,
         coalesce(i.submitted, i.due < now()),
         case when coalesce(i.submitted, false) then i.submitted_at end,
         'canvas', i.link, i.title, i.subject, i.due, i.submitted_at, i.submission
    from _items i
   where not exists (select 1 from app.tasks t where t.board_id = p_board and t.id = i.id)
   order by i.due
   limit v_room;
  get diagnostics v_added = row_count;

  update app.boards set canvas_synced_at = now(), canvas_error = null where id = p_board;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

-- 위젯에서 보드 코드로 호출하는 전체 가져오기
create or replace function public.dday_canvas_import(p_code text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 600 then
    raise exception 'invalid_import' using errcode = 'P0001';
  end if;
  return public.dday_svc_canvas_merge(v_board, p_items);
end $$;

revoke execute on function public.dday_canvas_import(text, jsonb) from public;
grant execute on function public.dday_canvas_import(text, jsonb) to anon, authenticated;
