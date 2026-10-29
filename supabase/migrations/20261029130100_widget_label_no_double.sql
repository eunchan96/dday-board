-- 위젯 이름: 이름에 이미 과목(줄임말)이 들어 있으면 다시 붙이지 않음 (예: "OS 휴강"이 "OS OS 휴강"이 되지 않게)
create or replace function app.widget_label(t app.tasks, p_short jsonb, p_etc jsonb)
returns text language sql immutable set search_path = '' as $$
  with s as (select coalesce(p_short ->> t.subject, t.subject) as subj,
                    coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = t.etc_type limit 1), '기타') as etc_name)
  select left(case
    when t.kind = 'todo' and t.source = 'canvas' then
      case when t.subject = '' then t.title else s.subj || ' ' ||
        coalesce((select e ->> 'name' from jsonb_array_elements(p_etc) e where e ->> 'id' = 'video' limit 1), '영상 시청') end
    when t.kind in ('exam', 'etc') then
      case when t.subject = '' then t.title
           when t.kind = 'etc' and t.title = s.etc_name then s.subj || ' ' || s.etc_name
           when position(t.subject in t.title) > 0 then replace(t.title, t.subject, s.subj)
           when position(s.subj in t.title) > 0 then t.title
           else s.subj || ' ' || t.title end
    when t.subject = '' or t.kind = 'todo' then t.title
    else s.subj || ' 과제'
  end, 60) from s;
$$;
