-- 과목 순서: 사용자가 정한 순서를 보드에 저장 (목록 · 필터 · 과목 고르기에 같은 순서)
alter table app.boards add column if not exists subject_order jsonb not null default '[]'::jsonb;

-- 과목 색 + 순서를 한 번에
create or replace function public.dday_subject_prefs(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select jsonb_build_object('colors', subject_colors, 'order', subject_order) from app.boards where id = v_board);
end $$;

create or replace function public.dday_set_subject_order(p_code text, p_order jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if jsonb_typeof(p_order) <> 'array' or jsonb_array_length(p_order) > 200
     or exists (select 1 from jsonb_array_elements(p_order) x
                where jsonb_typeof(x) <> 'string' or char_length(x #>> '{}') not between 1 and 40) then
    raise exception 'invalid_order' using errcode = 'P0001';
  end if;
  update app.boards set subject_order = p_order where id = v_board;
  return p_order;
end $$;

revoke execute on function public.dday_subject_prefs(text), public.dday_set_subject_order(text, jsonb) from public;
grant execute on function public.dday_subject_prefs(text), public.dday_set_subject_order(text, jsonb) to anon, authenticated;
