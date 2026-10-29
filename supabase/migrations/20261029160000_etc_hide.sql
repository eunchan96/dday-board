-- 기타 종류마다 "목록에는 안 보이게"(hide): 캘린더 · 위젯에만 보임. 휴강은 기본으로 켬
create or replace function public.dday_set_etc_types(p_code text, p_list jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_out jsonb;
begin
  if jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) > 30 then
    raise exception 'invalid_etc' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_list) e
              where coalesce(e->>'id', '') !~ '^[a-z0-9]{1,20}$'
                 or char_length(btrim(coalesce(e->>'name', ''))) not between 1 and 20
                 or coalesce(e->>'color', '') !~ '^#[0-9A-Fa-f]{6}$') then
    raise exception 'invalid_etc' using errcode = 'P0001';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'name', btrim(e->>'name'), 'color', upper(e->>'color'))
                            || case when coalesce((e->>'hide')::boolean, false) then '{"hide": true}'::jsonb else '{}'::jsonb end
                            order by o), '[]'::jsonb)
    into v_out
    from jsonb_array_elements(p_list) with ordinality as a(e, o);
  update app.boards set etc_types = v_out where id = v_board;
  return v_out;
end $$;

update app.boards b set etc_types = (
  select jsonb_agg(case when e->>'name' = '휴강' then e || '{"hide": true}'::jsonb else e end order by o)
    from jsonb_array_elements(b.etc_types) with ordinality as a(e, o))
 where exists (select 1 from jsonb_array_elements(b.etc_types) e where e->>'name' = '휴강');

alter table app.boards alter column etc_types set default
  '[{"id":"todo","name":"할 일","color":"#3D6BE0"},{"id":"cancel","name":"휴강","color":"#9AA0AA","hide":true}]'::jsonb;
