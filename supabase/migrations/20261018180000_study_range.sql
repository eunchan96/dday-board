-- 공부 기록 탭: 지난 주 · 지난 달 기록을 기간으로 불러오기 (한 번에 최대 45일)
create or replace function public.dday_study_range(p_code text, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '45 days' then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(app.study_session_json(s) order by s.started_at)
    from app.study_sessions s
    where s.board_id = v_board and not s.removed and s.started_at >= p_from and s.started_at < p_to), '[]'::jsonb);
end $$;

revoke execute on function public.dday_study_range(text, timestamptz, timestamptz) from public;
grant execute on function public.dday_study_range(text, timestamptz, timestamptz) to anon, authenticated;
