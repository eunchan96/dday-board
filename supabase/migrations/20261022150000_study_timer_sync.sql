-- 공부 타이머를 기기끼리 맞추기: 지금 돌고 있는 타이머 상태를 보드에 하나 저장
-- (마지막에 바꾼 기기가 이김: 상태 안의 updatedAt(ms)이 더 큰 쪽만 받음)
alter table app.boards add column if not exists study_timer jsonb;

create or replace function public.dday_timer(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select study_timer from app.boards where id = v_board);
end $$;

create or replace function public.dday_timer_set(p_code text, p_state jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_at numeric;
begin
  if jsonb_typeof(p_state) <> 'object' or length(p_state::text) > 2000 then
    raise exception 'invalid_timer' using errcode = 'P0001';
  end if;
  begin
    v_at := (p_state->>'updatedAt')::numeric;
  exception when others then
    raise exception 'invalid_timer' using errcode = 'P0001';
  end;
  if v_at is null then raise exception 'invalid_timer' using errcode = 'P0001'; end if;
  update app.boards
  set study_timer = p_state
  where id = v_board
    and (study_timer is null or coalesce((study_timer->>'updatedAt')::numeric, 0) < v_at);
  return (select study_timer from app.boards where id = v_board);
end $$;

revoke execute on function public.dday_timer(text), public.dday_timer_set(text, jsonb) from public;
grant execute on function public.dday_timer(text), public.dday_timer_set(text, jsonb) to anon, authenticated;
