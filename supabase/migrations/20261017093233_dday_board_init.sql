-- 데이터는 API에 노출되지 않는 별도 스키마에 둔다
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;

create table app.boards (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  owner_id   uuid,                       -- 나중에 로그인 계정 연결용
  created_at timestamptz not null default now()
);

create table app.tasks (
  board_id   uuid not null references app.boards(id) on delete cascade,
  id         text not null check (char_length(id) between 1 and 40),
  subject    text not null default '' check (char_length(subject) <= 40),
  title      text not null check (char_length(title) between 1 and 200),
  due        timestamptz not null,
  done       boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (board_id, id)
);

alter table app.boards enable row level security;
alter table app.tasks  enable row level security;
revoke all on all tables in schema app from public, anon, authenticated;

-- 코드 정규화 후 해시
create or replace function app.hash_code(p_code text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
$$;

create or replace function app.board_for(p_code text)
returns uuid language plpgsql stable set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from app.boards where code_hash = app.hash_code(p_code);
  if v_id is null then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;
  return v_id;
end $$;

create or replace function app.task_json(t app.tasks)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'subject', t.subject, 'title', t.title,
    'due', to_char(t.due at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'done', t.done, 'updatedAt', t.updated_at);
$$;

-- 새 보드 만들기: 20자(약 100비트) 코드 반환
create or replace function public.dday_create_board()
returns text language plpgsql security definer set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 헷갈리는 0,O,1,I 제외
  bytes bytea := extensions.gen_random_bytes(20);
  raw text := '';
  i int;
begin
  for i in 0..19 loop
    raw := raw || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  insert into app.boards(code_hash) values (app.hash_code(raw));
  return substr(raw,1,5)||'-'||substr(raw,6,5)||'-'||substr(raw,11,5)||'-'||substr(raw,16,5);
end $$;

create or replace function public.dday_list(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return coalesce(
    (select jsonb_agg(app.task_json(t) order by t.due) from app.tasks t where t.board_id = v_board),
    '[]'::jsonb);
end $$;

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
    set subject = excluded.subject, title = excluded.title, due = excluded.due,
        done = excluded.done, updated_at = now()
  returning * into v_row;

  return app.task_json(v_row);
end $$;

create or replace function public.dday_delete(p_code text, p_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  delete from app.tasks where board_id = v_board and id = p_id;
end $$;

-- 기존 브라우저 데이터를 한 번에 옮길 때 사용 (이미 있는 id는 건너뜀)
create or replace function public.dday_import(p_code text, p_tasks jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_count int;
begin
  if jsonb_typeof(p_tasks) <> 'array' or jsonb_array_length(p_tasks) > 500 then
    raise exception 'invalid_import' using errcode = 'P0001';
  end if;
  insert into app.tasks (board_id, id, subject, title, due, done)
  select v_board, x->>'id', coalesce(trim(x->>'subject'), ''), trim(x->>'title'),
         (x->>'due')::timestamptz, coalesce((x->>'done')::boolean, false)
  from jsonb_array_elements(p_tasks) x
  where coalesce(x->>'id','') <> '' and coalesce(trim(x->>'title'),'') <> ''
  on conflict (board_id, id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- 외부에는 public 함수 5개만 실행 허용
revoke execute on all functions in schema app from public, anon, authenticated;
revoke execute on function public.dday_create_board(), public.dday_list(text),
  public.dday_upsert(text, jsonb), public.dday_delete(text, text), public.dday_import(text, jsonb)
  from public;
grant execute on function public.dday_create_board(), public.dday_list(text),
  public.dday_upsert(text, jsonb), public.dday_delete(text, text), public.dday_import(text, jsonb)
  to anon, authenticated;
