-- 스마트캠퍼스(Canvas) 캘린더 피드 연동
-- - 보드별로 피드 주소를 저장하고, Edge Function이 주기적으로 읽어 과제를 병합한다.
-- - 사용자가 직접 고친 칸(제목/과목/마감)은 이후 동기화가 덮어쓰지 않는다.

alter table app.boards
  add column canvas_feed_url  text,
  add column canvas_synced_at timestamptz,
  add column canvas_error     text;

alter table app.tasks
  add column source         text not null default 'manual' check (source in ('manual', 'canvas')),
  add column link           text check (link is null or char_length(link) <= 300),
  add column canvas_title   text,
  add column canvas_subject text,
  add column canvas_due     timestamptz,
  add column title_custom   boolean not null default false,
  add column subject_custom boolean not null default false,
  add column due_custom     boolean not null default false;

create or replace function app.task_json(t app.tasks)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'subject', t.subject, 'title', t.title,
    'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'done', t.done, 'updatedAt', t.updated_at,
    'source', t.source, 'link', t.link);
$$;

-- 수정: Canvas에서 온 과제를 사용자가 바꾸면 해당 칸을 '직접 수정됨'으로 표시
create or replace function public.dday_upsert(p_code text, p_task jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_row app.tasks;
begin
  if (select count(*) from app.tasks where board_id = v_board) >= 500
     and not exists (select 1 from app.tasks where board_id = v_board and id = p_task->>'id') then
    raise exception 'too_many_tasks' using errcode = 'P0001';
  end if;

  insert into app.tasks as t (board_id, id, subject, title, due, done)
  values (v_board, p_task->>'id', coalesce(trim(p_task->>'subject'), ''), trim(p_task->>'title'),
          (p_task->>'due')::timestamptz, coalesce((p_task->>'done')::boolean, false))
  on conflict (board_id, id) do update
    set subject        = excluded.subject,
        title          = excluded.title,
        due            = excluded.due,
        done           = excluded.done,
        title_custom   = t.title_custom   or (t.source = 'canvas' and excluded.title   is distinct from t.title),
        subject_custom = t.subject_custom or (t.source = 'canvas' and excluded.subject is distinct from t.subject),
        due_custom     = t.due_custom     or (t.source = 'canvas' and excluded.due     is distinct from t.due),
        updated_at     = now()
  returning * into v_row;

  return app.task_json(v_row);
end $$;

-- 피드 주소 등록/해제 (빈 값이면 해제). 주소는 다시 읽어갈 수 없다.
create or replace function public.dday_set_canvas_feed(p_code text, p_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_url text := nullif(trim(coalesce(p_url, '')), '');
begin
  if v_url is not null then
    v_url := regexp_replace(v_url, '^webcal://', 'https://');
    if v_url !~ '^https://[A-Za-z0-9.-]+/feeds/calendars/[A-Za-z0-9_-]+\.ics$' then
      raise exception 'invalid_feed_url' using errcode = 'P0001';
    end if;
  end if;
  update app.boards
     set canvas_feed_url = v_url, canvas_synced_at = null, canvas_error = null
   where id = v_board;
  return public.dday_canvas_status(p_code);
end $$;

create or replace function public.dday_canvas_status(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  b app.boards;
begin
  select * into b from app.boards where id = v_board;
  return jsonb_build_object(
    'connected', b.canvas_feed_url is not null,
    'syncedAt',  b.canvas_synced_at,
    'error',     b.canvas_error);
end $$;

-- ───── 아래는 Edge Function(service_role) 전용 ─────

create or replace function public.dday_svc_board_feed(p_code text)
returns table(board_id uuid, feed_url text)
language sql stable security definer set search_path = '' as $$
  select id, canvas_feed_url from app.boards where code_hash = app.hash_code(p_code);
$$;

create or replace function public.dday_svc_feeds()
returns table(board_id uuid, feed_url text)
language sql stable security definer set search_path = '' as $$
  select id, canvas_feed_url from app.boards where canvas_feed_url is not null;
$$;

-- 피드에서 읽은 과제를 병합
--  - 새 과제: 추가. 이미 마감이 지났으면 완료 상태로.
--  - 기존 과제: Canvas 값 갱신, 사용자가 직접 고친 칸은 유지, 완료 상태는 건드리지 않음.
--  - 피드에서 사라진 과제: 그대로 둠.
-- p_error가 있으면 병합하지 않고 오류만 기록한다.
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

  with items as (
    select x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(trim(x->>'subject'), ''), 40) as subject,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%' and coalesce(trim(x->>'title'), '') <> ''
  )
  update app.tasks t
     set canvas_title   = i.title,
         canvas_subject = i.subject,
         canvas_due     = i.due,
         link           = i.link,
         title          = case when t.title_custom   then t.title   else i.title   end,
         subject        = case when t.subject_custom then t.subject else i.subject end,
         due            = case when t.due_custom     then t.due     else i.due     end,
         updated_at     = now()
    from items i
   where t.board_id = p_board and t.id = i.id
     and (t.canvas_title, t.canvas_subject, t.canvas_due, t.link)
         is distinct from (i.title, i.subject, i.due, i.link);
  get diagnostics v_updated = row_count;

  v_room := greatest(0, 500 - (select count(*) from app.tasks where board_id = p_board));

  with items as (
    select x->>'id' as id,
           left(coalesce(trim(x->>'title'), ''), 200) as title,
           left(coalesce(trim(x->>'subject'), ''), 40) as subject,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%' and coalesce(trim(x->>'title'), '') <> ''
  ), fresh as (
    select i.* from items i
    where not exists (select 1 from app.tasks t where t.board_id = p_board and t.id = i.id)
    order by i.due
    limit v_room
  )
  insert into app.tasks (board_id, id, subject, title, due, done, source, link,
                         canvas_title, canvas_subject, canvas_due)
  select p_board, id, subject, title, due, due < now(), 'canvas', link, title, subject, due
  from fresh;
  get diagnostics v_added = row_count;

  update app.boards set canvas_synced_at = now(), canvas_error = null where id = p_board;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

-- 권한: 사용자용 함수는 anon/authenticated, svc 함수는 service_role만
revoke execute on function public.dday_set_canvas_feed(text, text), public.dday_canvas_status(text),
  public.dday_svc_board_feed(text), public.dday_svc_feeds(), public.dday_svc_canvas_merge(uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.dday_set_canvas_feed(text, text), public.dday_canvas_status(text)
  to anon, authenticated;
grant execute on function public.dday_svc_board_feed(text), public.dday_svc_feeds(),
  public.dday_svc_canvas_merge(uuid, jsonb, text)
  to service_role;
