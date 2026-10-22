-- 직접 추가한 과목을 보드에 저장 (기기마다 따로 기억하던 것을 모든 기기에서 같게)
alter table app.boards add column if not exists custom_subjects jsonb not null default '[]'::jsonb;

create or replace function public.dday_subject_prefs(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select jsonb_build_object('colors', subject_colors, 'order', subject_order, 'custom', custom_subjects)
            from app.boards where id = v_board);
end $$;

create or replace function public.dday_set_custom_subjects(p_code text, p_list jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) > 100
     or exists (select 1 from jsonb_array_elements(p_list) x
                where jsonb_typeof(x) <> 'string' or char_length(btrim(x #>> '{}')) not between 1 and 40) then
    raise exception 'invalid_subjects' using errcode = 'P0001';
  end if;
  update app.boards set custom_subjects = p_list where id = v_board;
  return p_list;
end $$;

revoke execute on function public.dday_set_custom_subjects(text, jsonb) from public;
grant execute on function public.dday_set_custom_subjects(text, jsonb) to anon, authenticated;
