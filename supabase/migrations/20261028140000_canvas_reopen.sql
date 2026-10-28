-- 스마트캠퍼스: 마감이 지나 저절로 완료됐던 과제가 다시 열려 마감이 뒤로 가면 다시 할 일로
create or replace function public.dday_svc_canvas_merge(p_board uuid, p_items jsonb, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_added int := 0;
  v_updated int := 0;
  v_room int;
  v_prev text;
  v_alias jsonb := coalesce((select subject_aliases from app.boards where id = p_board), '{}'::jsonb);
begin
  if p_error is not null then
    select canvas_error into v_prev from app.boards where id = p_board;
    update app.boards set canvas_error = left(p_error, 300), canvas_synced_at = now() where id = p_board;
    -- 토큰이 막 만료됐을 때 한 번만 알림
    if p_error = 'token_invalid' and v_prev is distinct from 'token_invalid' then
      insert into app.push_outbox(board_id, title, body, url, tag)
      values (p_board, '스마트캠퍼스 토큰이 만료됐어요',
              '새 토큰을 넣어야 과제를 계속 가져와요. 눌러서 설정을 열어 주세요.',
              'https://dday-board-pink.vercel.app/#settings', 'token');
    end if;
    return jsonb_build_object('added', 0, 'updated', 0, 'error', p_error);
  end if;

  with _items as (
    select distinct on (x->>'id') x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(v_alias->>trim(x->>'subject'), trim(x->>'subject'), ''), 40) as subject,
           (v_alias ? coalesce(trim(x->>'subject'), '')) as aliased,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link,
           case when x ? 'submitted' then (x->>'submitted')::boolean end as submitted,
           nullif(x->>'submittedAt', '')::timestamptz as submitted_at,
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission,
           case when x ? 'missing' then (x->>'missing')::boolean end as missing,
           case when x->>'kind' = 'todo' then 'todo' else 'assignment' end as kind
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
         missing        = coalesce(i.missing, t.missing) and not coalesce(i.submitted, false),
         -- 자동으로 완료 처리됐던(직접 완료하지 않은) 지난 과제가 미제출이면 다시 꺼내 보인다
         done           = case
                            when coalesce(i.submitted, false) then true
                            when coalesce(i.missing, false) and t.done and t.done_at is null and t.submitted_at is null then false
                            -- 저절로 완료 처리됐던(마감이 지나서) 과제가 다시 열려 마감이 뒤로 가면 다시 꺼냄
                            when t.done and t.done_at is null and t.submitted_at is null and i.due > now() and t.kind <> 'todo' then false
                            else t.done end,
         done_at        = case when not t.done and coalesce(i.submitted, false)
                               then coalesce(i.submitted_at, now()) else t.done_at end,
         updated_at     = now()
    from _items i
   where t.board_id = p_board and t.id = i.id
     and ( (t.canvas_title, t.canvas_subject, t.canvas_due) is distinct from (i.title, i.subject, i.due)
        or (i.link is not null and i.link is distinct from t.link)
        or (i.submitted_at is not null and i.submitted_at is distinct from t.submitted_at)
        or (i.submission is not null and i.submission is distinct from t.submission)
        or (i.missing is not null and i.missing is distinct from t.missing)
        or (coalesce(i.submitted, false) and not t.done)
        or (coalesce(i.missing, false) and t.done and t.done_at is null and t.submitted_at is null)
        or (t.done and t.done_at is null and t.submitted_at is null and i.due > now() and t.kind <> 'todo' and not coalesce(i.submitted, false)) );
  get diagnostics v_updated = row_count;

  v_room := greatest(0, 500 - (select count(*) from app.tasks where board_id = p_board));

  with _items as (
    select distinct on (x->>'id') x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(v_alias->>trim(x->>'subject'), trim(x->>'subject'), ''), 40) as subject,
           (v_alias ? coalesce(trim(x->>'subject'), '')) as aliased,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link,
           case when x ? 'submitted' then (x->>'submitted')::boolean end as submitted,
           nullif(x->>'submittedAt', '')::timestamptz as submitted_at,
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission,
           coalesce((x->>'missing')::boolean, false) as missing,
           case when x->>'kind' = 'todo' then 'todo' else 'assignment' end as kind
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%'
      and coalesce(trim(x->>'title'), '') <> ''
      and coalesce(x->>'due', '') <> ''
  )
  insert into app.tasks (board_id, id, kind, subject, title, due, done, done_at, source, link,
                         canvas_title, canvas_subject, canvas_due, submitted_at, submission, missing, subject_custom)
  select p_board, i.id, i.kind, i.subject, i.title, i.due,
         coalesce(i.submitted, false) or (i.due < now() and not i.missing),
         case when coalesce(i.submitted, false) then i.submitted_at end,
         'canvas', i.link, i.title, i.subject, i.due, i.submitted_at, i.submission, i.missing, i.aliased
    from _items i
   where not exists (select 1 from app.tasks t where t.board_id = p_board and t.id = i.id)
     -- 강의 영상(할 일)은 아직 안 본 것만 새로 넣고, 이미 본 건 있던 항목을 완료로 바꾸기만
     and not (i.kind = 'todo' and (coalesce(i.submitted, false) or i.due < now()))
   order by i.due
   limit v_room;
  get diagnostics v_added = row_count;

  update app.boards set canvas_synced_at = now(), canvas_error = null where id = p_board;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;
