-- 묶음(학기 · 기간 · 넓은 의미의 과목): 사용자가 만들고 고치는 묶음과 과목 소속
--  { "groups":  [{ "id", "name", "start": "YYYY-MM-DD"|null, "end": "YYYY-MM-DD"|null, "auto": bool }],
--    "members": { "과목": ["묶음 id", ...] | ["*"] },   -- "*" = 모든 묶음에 항상
--    "removed": ["2026-1", ...] }                       -- 지운 자동 학기 (다시 만들지 않음)
alter table app.boards add column if not exists subject_groups jsonb not null default '{}'::jsonb;

create or replace function public.dday_subject_prefs(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  return (select jsonb_build_object('colors', subject_colors, 'order', subject_order,
                                    'custom', custom_subjects, 'groups', subject_groups)
            from app.boards where id = v_board);
end $$;

create or replace function public.dday_set_groups(p_code text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if jsonb_typeof(p_data) <> 'object' or pg_column_size(p_data) > 60000
     or jsonb_typeof(coalesce(p_data->'groups', '[]')) <> 'array'
     or jsonb_typeof(coalesce(p_data->'members', '{}')) <> 'object'
     or jsonb_typeof(coalesce(p_data->'removed', '[]')) <> 'array'
     or jsonb_array_length(coalesce(p_data->'groups', '[]')) > 60
     or exists (select 1 from jsonb_array_elements(coalesce(p_data->'groups', '[]')) g
                where jsonb_typeof(g) <> 'object'
                   or char_length(coalesce(g->>'id', '')) not between 1 and 40
                   or char_length(btrim(coalesce(g->>'name', ''))) not between 1 and 30
                   or (g->>'start' is not null and g->>'start' !~ '^\d{4}-\d{2}-\d{2}$')
                   or (g->>'end' is not null and g->>'end' !~ '^\d{4}-\d{2}-\d{2}$'))
     or exists (select 1 from jsonb_each(coalesce(p_data->'members', '{}')) m
                where jsonb_typeof(m.value) <> 'array' or jsonb_array_length(m.value) > 60
                   or char_length(m.key) not between 1 and 40) then
    raise exception 'invalid_groups' using errcode = 'P0001';
  end if;
  update app.boards set subject_groups = p_data where id = v_board;
  return p_data;
end $$;

revoke execute on function public.dday_set_groups(text, jsonb) from public;
grant execute on function public.dday_set_groups(text, jsonb) to anon, authenticated;
