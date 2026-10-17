-- 스마트캠퍼스 액세스 토큰 연동
-- - 학생이 스마트캠퍼스 설정에서 만든 토큰으로 서버가 API를 직접 읽는다 (학기 전체 과제 + 제출 파일)
-- - 토큰은 내 계정으로 무엇이든 할 수 있는 값이라 테이블에 두지 않고 Vault에 암호화해 저장한다.
--   보드에는 Vault 비밀값 id와 끝 4자리만 남기고, 화면으로는 끝 4자리만 돌려준다.
-- - 토큰이 있으면 동기화는 API로 하고 캘린더 피드는 쓰지 않는다 (둘이 마감 시각을 번갈아 바꾸지 않게).

alter table app.boards
  add column canvas_token_secret uuid,                 -- vault.secrets.id
  add column canvas_token_hint   text,                 -- 끝 4자리. null이면 토큰 없음
  add column canvas_api_origin   text not null default 'https://canvas.ssu.ac.kr';

create or replace function public.dday_set_canvas_token(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_token text := nullif(regexp_replace(coalesce(p_token, ''), '\s', '', 'g'), '');
  v_secret uuid;
begin
  -- 형식은 학교마다 달라서 길이와 문자만 확인하고, 진짜인지는 첫 동기화(401 여부)로 판단한다
  if v_token is not null and v_token !~ '^[A-Za-z0-9~_.+/=-]{20,400}$' then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  select canvas_token_secret into v_secret from app.boards where id = v_board;

  if v_secret is null then
    -- 해제 요청인데 저장된 토큰도 없으면 할 일 없음
    if v_token is null then return public.dday_canvas_status(p_code); end if;
    v_secret := vault.create_secret(v_token, 'dday_canvas_token_' || v_board::text, 'D-day 보드 스마트캠퍼스 토큰');
  else
    -- 해제할 때는 값을 비워 둔다 (Vault 항목은 다음에 다시 쓴다)
    perform vault.update_secret(v_secret, coalesce(v_token, ''));
  end if;

  update app.boards
     set canvas_token_secret = v_secret,
         canvas_token_hint   = case when v_token is null then null else right(v_token, 4) end,
         canvas_synced_at    = null,
         canvas_error        = null
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
    'connected', b.canvas_feed_url is not null or b.canvas_token_hint is not null,
    'feed',      b.canvas_feed_url is not null,
    'token',     b.canvas_token_hint is not null,
    'tokenHint', b.canvas_token_hint,
    'syncedAt',  b.canvas_synced_at,
    'error',     b.canvas_error);
end $$;

grant execute on function public.dday_set_canvas_token(text, text) to anon;

/* ───── Edge Function(service_role) 전용 ───── */

-- 동기화 대상: 토큰이 있으면 토큰, 없으면 피드
create or replace function public.dday_svc_canvas_targets(p_code text default null)
returns table(board_id uuid, feed_url text, api_origin text, token text)
language sql stable security definer set search_path = '' as $$
  select b.id,
         b.canvas_feed_url,
         b.canvas_api_origin,
         case when b.canvas_token_hint is not null then
           (select s.decrypted_secret from vault.decrypted_secrets s where s.id = b.canvas_token_secret)
         end
    from app.boards b
   where (p_code is null and (b.canvas_feed_url is not null or b.canvas_token_hint is not null))
      or (p_code is not null and b.code_hash = app.hash_code(p_code));
$$;
revoke execute on function public.dday_svc_canvas_targets(text) from public, anon, authenticated;
grant execute on function public.dday_svc_canvas_targets(text) to service_role;

-- 처음 들어오는 과제는 이미 마감이 지났으면 제출 여부와 상관없이 완료로 넣는다
-- (토큰·북마클릿은 제출하지 않은 지난 과제도 보내므로, 피드 동기화와 같은 규칙으로 맞춤)
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
         coalesce(i.submitted, false) or i.due < now(),
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
