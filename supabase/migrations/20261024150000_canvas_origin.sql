-- 다른 학교(Canvas를 쓰는 학교)도: 스마트캠퍼스(LMS) 주소를 보드마다 정할 수 있게
-- - https://호스트 만 받는다 (경로 · 포트 · IP 주소 · localhost 안 됨)
-- - 바꾸면 다음 동기화부터 그 주소로 토큰을 보낸다 (토큰은 그 학교에서 만든 것이어야 함)
create or replace function public.dday_set_canvas_origin(p_code text, p_origin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_origin text := lower(btrim(coalesce(p_origin, '')));
begin
  v_origin := regexp_replace(v_origin, '/+$', '');
  if v_origin = '' then v_origin := 'https://canvas.ssu.ac.kr'; end if;
  if v_origin !~ '^https://' then v_origin := 'https://' || regexp_replace(v_origin, '^[a-z]+://', ''); end if;
  if char_length(v_origin) > 120
     or v_origin !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
     or v_origin ~ '(^https://|\.)localhost$' then
    raise exception 'invalid_origin' using errcode = 'P0001';
  end if;
  update app.boards
     set canvas_api_origin = v_origin,
         canvas_synced_at = case when canvas_api_origin is distinct from v_origin then null else canvas_synced_at end,
         canvas_error     = case when canvas_api_origin is distinct from v_origin then null else canvas_error end
   where id = v_board;
  return public.dday_canvas_status(p_code);
end $$;

revoke execute on function public.dday_set_canvas_origin(text, text) from public;
grant execute on function public.dday_set_canvas_origin(text, text) to anon, authenticated;

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
    'origin',    b.canvas_api_origin,
    'syncedAt',  b.canvas_synced_at,
    'error',     b.canvas_error);
end $$;
