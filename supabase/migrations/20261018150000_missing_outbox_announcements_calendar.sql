-- 미제출 표시, 알림 보낼 함(outbox), 스마트캠퍼스 공지, 캘린더 구독 주소
-- (행을 지우지 않고 sent_at · read 같은 표시로 관리)

/* ───── 미제출 ───── */
-- Canvas 제출 정보의 missing(마감 지남 + 미제출, 면제 제외)을 그대로 저장한다.
alter table app.tasks add column missing boolean not null default false;

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
    'missing', t.missing);
$$;

/* ───── 알림 보낼 함 ───── */
-- 마감 알림 말고 한 번만 보내는 알림(토큰 만료, 새 공지)을 쌓아 두면 push-notify가 10분마다 보낸다.
create table app.push_outbox (
  id         bigint generated always as identity primary key,
  board_id   uuid not null references app.boards(id) on delete cascade,
  title      text not null,
  body       text not null default '',
  url        text,
  tag        text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index push_outbox_pending on app.push_outbox(created_at) where sent_at is null;
alter table app.push_outbox enable row level security;
revoke all on app.push_outbox from public, anon, authenticated;

-- 보낼 것을 꺼내면서 보낸 것으로 표시 (같은 알림을 두 번 보내지 않게)
create or replace function public.dday_svc_outbox_take()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  with taken as (
    update app.push_outbox o set sent_at = now()
     where o.sent_at is null and o.created_at > now() - interval '1 day'
    returning o.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'title', t.title, 'body', t.body, 'url', t.url, 'tag', t.tag,
           'subs', (select coalesce(jsonb_agg(jsonb_build_object(
                      'subId', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
                    from app.push_subs s where s.board_id = t.board_id))), '[]'::jsonb)
    into v from taken t;
  return v;
end $$;
revoke execute on function public.dday_svc_outbox_take() from public, anon, authenticated;
grant execute on function public.dday_svc_outbox_take() to service_role;

/* ───── 병합: 미제출 반영 + 토큰 만료 알림 ───── */
create or replace function public.dday_svc_canvas_merge(p_board uuid, p_items jsonb, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_added int := 0;
  v_updated int := 0;
  v_room int;
  v_prev text;
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
           left(coalesce(trim(x->>'subject'), ''), 40) as subject,
           (x->>'due')::timestamptz as due,
           nullif(left(coalesce(x->>'link', ''), 300), '') as link,
           case when x ? 'submitted' then (x->>'submitted')::boolean end as submitted,
           nullif(x->>'submittedAt', '')::timestamptz as submitted_at,
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission,
           case when x ? 'missing' then (x->>'missing')::boolean end as missing
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
        or (coalesce(i.missing, false) and t.done and t.done_at is null and t.submitted_at is null) );
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
           case when jsonb_typeof(x->'submission') = 'object' then x->'submission' end as submission,
           coalesce((x->>'missing')::boolean, false) as missing
    from jsonb_array_elements(p_items) x
    where coalesce(x->>'id', '') like 'canvas-%'
      and coalesce(trim(x->>'title'), '') <> ''
      and coalesce(x->>'due', '') <> ''
  )
  insert into app.tasks (board_id, id, subject, title, due, done, done_at, source, link,
                         canvas_title, canvas_subject, canvas_due, submitted_at, submission, missing)
  select p_board, i.id, i.subject, i.title, i.due,
         coalesce(i.submitted, false) or (i.due < now() and not i.missing),
         case when coalesce(i.submitted, false) then i.submitted_at end,
         'canvas', i.link, i.title, i.subject, i.due, i.submitted_at, i.submission, i.missing
    from _items i
   where not exists (select 1 from app.tasks t where t.board_id = p_board and t.id = i.id)
   order by i.due
   limit v_room;
  get diagnostics v_added = row_count;

  update app.boards set canvas_synced_at = now(), canvas_error = null where id = p_board;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end $$;

/* ───── 스마트캠퍼스 공지 ───── */
create table app.announcements (
  board_id   uuid not null references app.boards(id) on delete cascade,
  id         text not null,                       -- Canvas 공지 id
  subject    text not null default '',
  title      text not null,
  preview    text not null default '',            -- 본문 앞부분 (태그 뺀 글자)
  url        text,
  posted_at  timestamptz not null,
  read       boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (board_id, id)
);
alter table app.announcements enable row level security;
revoke all on app.announcements from public, anon, authenticated;

-- 새 공지만 넣고, 최근 이틀 안에 올라온 새 공지는 알림도 쌓는다 (처음 가져올 때 알림 폭탄 방지)
create or replace function public.dday_svc_announcements_merge(p_board uuid, p_items jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_added int;
begin
  with ins as (
    insert into app.announcements(board_id, id, subject, title, preview, url, posted_at, read)
    select p_board, x->>'id', left(coalesce(x->>'subject', ''), 40), left(coalesce(x->>'title', ''), 200),
           left(coalesce(x->>'preview', ''), 300), nullif(left(coalesce(x->>'url', ''), 300), ''),
           (x->>'postedAt')::timestamptz,
           (x->>'postedAt')::timestamptz < now() - interval '14 days'   -- 오래된 공지는 읽은 것으로
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x
     where coalesce(x->>'id', '') <> '' and coalesce(x->>'postedAt', '') <> ''
    on conflict (board_id, id) do nothing
    returning *
  ), outbox as (
    insert into app.push_outbox(board_id, title, body, url, tag)
    select p_board, '새 공지 · ' || coalesce(nullif(subject, ''), '스마트캠퍼스'), title,
           'https://dday-board-pink.vercel.app/#notices', 'notice-' || id
      from ins where posted_at > now() - interval '2 days'
     limit 5
    returning 1
  )
  select count(*) into v_added from ins;
  return v_added;
end $$;
revoke execute on function public.dday_svc_announcements_merge(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.dday_svc_announcements_merge(uuid, jsonb) to service_role;

create or replace function public.dday_announcements(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'subject', a.subject, 'title', a.title,
             'preview', a.preview, 'url', a.url, 'postedAt', a.posted_at, 'read', a.read)
             order by a.posted_at desc)
      from (select * from app.announcements where board_id = v_board order by posted_at desc limit 40) a
  ), '[]'::jsonb);
end $$;

create or replace function public.dday_announcements_read(p_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.announcements set read = true where board_id = v_board and not read;
end $$;

grant execute on function public.dday_announcements(text) to anon;
grant execute on function public.dday_announcements_read(text) to anon;

/* ───── 캘린더 구독 주소 ───── */
-- 보드 코드와 다른 읽기 전용 열쇠. 해시만 저장하고, 새로 만들면 이전 주소는 더 이상 열리지 않는다.
alter table app.boards add column calendar_key_hash text unique;

create or replace function public.dday_calendar_key(p_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_key text;
begin
  v_key := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  update app.boards set calendar_key_hash = encode(extensions.digest(v_key, 'sha256'), 'hex') where id = v_board;
  return v_key;
end $$;

create or replace function public.dday_calendar_status(p_code text)
returns boolean language sql stable security definer set search_path = '' as $$
  select calendar_key_hash is not null from app.boards where id = app.board_for(p_code);
$$;

grant execute on function public.dday_calendar_key(text) to anon;
grant execute on function public.dday_calendar_status(text) to anon;

create or replace function public.dday_svc_calendar(p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_board uuid;
begin
  select id into v_board from app.boards
   where calendar_key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  if v_board is null then return null; end if;
  return coalesce((
    select jsonb_agg(app.task_json(t) order by t.due)
      from app.tasks t
     where t.board_id = v_board and not t.hidden
       and t.due > now() - interval '60 days'
  ), '[]'::jsonb);
end $$;
revoke execute on function public.dday_svc_calendar(text) from public, anon, authenticated;
grant execute on function public.dday_svc_calendar(text) to service_role;
