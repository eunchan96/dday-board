-- 스마트캠퍼스 과제도 종류(과제 · 시험 · 기타)를 바꿀 수 있게 (동기화는 종류를 건드리지 않음). 강의 영상(할 일)은 그대로
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.dday_upsert(text, jsonb)'::regprocedure);
  v_def := replace(v_def,
    $a$kind           = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.kind     else t.kind     end,$a$,
    $a$kind           = case when p_task ? 'kind'     and not (t.source = 'canvas' and t.kind = 'todo') then excluded.kind     else t.kind     end,$a$);
  v_def := replace(v_def,
    $a$etc_type       = case when p_task ? 'kind'     and t.source <> 'canvas' then excluded.etc_type else t.etc_type end,$a$,
    $a$etc_type       = case when p_task ? 'kind'     and not (t.source = 'canvas' and t.kind = 'todo') then excluded.etc_type else t.etc_type end,$a$);
  if v_def not like '%not (t.source = ''canvas'' and t.kind = ''todo'')%' then raise exception 'pattern_not_found'; end if;
  execute v_def;
end $$;
