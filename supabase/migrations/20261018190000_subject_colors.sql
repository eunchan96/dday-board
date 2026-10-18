-- 과목 색: 기본은 과목 이름 순으로 정해지고, 바꾼 색만 보드에 저장해 모든 기기에서 같게
alter table app.boards add column if not exists subject_colors jsonb not null default '{}'::jsonb;

create or replace function public.dday_subject_colors(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select subject_colors from app.boards where id = v_board);
end $$;

-- p_color가 null이면 기본 색으로 되돌림
create or replace function public.dday_set_subject_color(p_code text, p_subject text, p_color text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_name text := trim(coalesce(p_subject, ''));
  v_out jsonb;
begin
  if char_length(v_name) < 1 or char_length(v_name) > 40 then
    raise exception 'invalid_subject' using errcode = 'P0001';
  end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'invalid_color' using errcode = 'P0001';
  end if;
  update app.boards
  set subject_colors = case when p_color is null then subject_colors - v_name
                            else subject_colors || jsonb_build_object(v_name, upper(p_color)) end
  where id = v_board
  returning subject_colors into v_out;
  if (select count(*) from jsonb_object_keys(v_out)) > 200 then
    raise exception 'too_many_colors' using errcode = 'P0001';
  end if;
  return v_out;
end $$;

revoke execute on function public.dday_subject_colors(text), public.dday_set_subject_color(text, text, text) from public;
grant execute on function public.dday_subject_colors(text), public.dday_set_subject_color(text, text, text) to anon, authenticated;
