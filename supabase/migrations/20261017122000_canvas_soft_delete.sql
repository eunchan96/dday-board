-- 스마트캠퍼스에서 가져온 과제를 지우면 다음 동기화 때 다시 생기지 않도록
-- 실제로 지우지 않고 숨김 처리한다. (직접 추가한 과제는 그대로 삭제)

alter table app.tasks add column hidden boolean not null default false;

create or replace function public.dday_list(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return coalesce(
    (select jsonb_agg(app.task_json(t) order by t.due)
       from app.tasks t where t.board_id = v_board and not t.hidden),
    '[]'::jsonb);
end $$;

create or replace function public.dday_delete(p_code text, p_id text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  update app.tasks set hidden = true, updated_at = now()
   where board_id = v_board and id = p_id and source = 'canvas';
  delete from app.tasks
   where board_id = v_board and id = p_id and source <> 'canvas';
end $$;
