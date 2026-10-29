-- 스마트캠퍼스에서 새 과제 · 강의 영상이 들어오면 알림 (처음 연결해서 한꺼번에 가져올 때와 이미 마감이 지난 것은 빼고)
create or replace function app.canvas_new_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select n.board_id, (n.kind = 'todo') as lecture, count(*) as cnt,
           (array_agg(n.title order by n.due))[1] as first_title,
           (array_agg(n.subject order by n.due))[1] as first_subject,
           (array_agg(n.due order by n.due))[1] as first_due
      from new_rows n
     where n.source = 'canvas' and n.due > now()
       -- 이 보드가 전에 스마트캠퍼스 일정을 받은 적이 있을 때만 (처음 연결은 알리지 않음)
       and exists (select 1 from app.tasks t where t.board_id = n.board_id and t.source = 'canvas'
                     and not exists (select 1 from new_rows x where x.board_id = t.board_id and x.id = t.id))
     group by n.board_id, (n.kind = 'todo')
  loop
    insert into app.push_outbox(board_id, title, body, url, tag)
    values (
      r.board_id,
      case when r.lecture then '새 강의 영상' else '새 과제' end
        || case when r.cnt > 1 then ' ' || r.cnt || '개' else case when r.first_subject <> '' then ' · ' || r.first_subject else '' end end,
      case when r.cnt > 1 then coalesce(nullif(r.first_subject, '') || ' ', '') || r.first_title || ' 외 ' || (r.cnt - 1) || '개'
           else r.first_title end
        || ' · ' || to_char(r.first_due at time zone 'Asia/Seoul', 'FMMM/FMDD HH24:MI') || ' 마감',
      'https://s-day-board.vercel.app/#list',
      'canvas-new-' || case when r.lecture then 'lecture' else 'task' end);
  end loop;
  return null;
end $$;

drop trigger if exists tasks_canvas_new on app.tasks;
create trigger tasks_canvas_new after insert on app.tasks
  referencing new table as new_rows
  for each statement execute function app.canvas_new_notify();
