-- 사이트 주소가 s-day-board.vercel.app으로 바뀜 (예전 주소는 넘겨주기만 함): 알림에 넣는 주소도 새 주소로
do $$
declare r record; v_def text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prokind = 'f'
              and (case when p.prokind = 'f' then pg_get_functiondef(p.oid) end) like '%dday-board-pink.vercel.app%'
  loop
    v_def := replace(pg_get_functiondef(r.oid), 'dday-board-pink.vercel.app', 's-day-board.vercel.app');
    execute v_def;
  end loop;
end $$;
