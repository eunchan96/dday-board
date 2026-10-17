-- 마감 알림(Web Push)
-- - 기기마다 푸시 구독(endpoint + 키)을 보드에 연결해 저장한다.
-- - push-notify Edge Function이 10분마다 "알림 시점이 지난" 과제를 받아 보내고, 보낸 기록을 남긴다.
-- - 같은 과제라도 마감이 바뀌면(due가 달라지면) 다시 알린다.

create table app.push_subs (
  id          uuid primary key default gen_random_uuid(),
  board_id    uuid not null references app.boards(id) on delete cascade,
  endpoint    text not null unique check (char_length(endpoint) <= 1000 and endpoint like 'https://%'),
  p256dh      text not null check (char_length(p256dh) between 20 and 200),
  auth        text not null check (char_length(auth) between 8 and 100),
  leads       int[] not null default '{1440,180}',   -- 마감 몇 분 전에 알릴지
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  fail_count  int not null default 0
);
create index push_subs_board on app.push_subs(board_id);

create table app.push_sent (
  sub_id   uuid not null references app.push_subs(id) on delete cascade,
  task_id  text not null,
  due      timestamptz not null,
  lead     int not null,
  sent_at  timestamptz not null default now(),
  primary key (sub_id, task_id, due, lead)
);

alter table app.push_subs enable row level security;
alter table app.push_sent enable row level security;
revoke all on app.push_subs, app.push_sent from public, anon, authenticated;

-- 알림 시점 목록 정리: 10분~7일, 중복 제거, 최대 4개
create or replace function app.clean_leads(p_leads int[])
returns int[] language sql immutable set search_path = '' as $$
  select coalesce(
    (select array_agg(l order by l desc)
       from (select distinct l from unnest(coalesce(p_leads, '{}'::int[])) as l
             where l between 10 and 10080 order by l desc limit 4) s),
    '{}'::int[]);
$$;

/* ───── 화면에서 부르는 함수 ───── */

create or replace function public.dday_push_subscribe(p_code text, p_sub jsonb, p_leads int[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_leads int[] := app.clean_leads(p_leads);
  v_endpoint text := p_sub->>'endpoint';
begin
  if v_endpoint is null or p_sub#>>'{keys,p256dh}' is null or p_sub#>>'{keys,auth}' is null then
    raise exception 'invalid_subscription' using errcode = 'P0001';
  end if;
  if (select count(*) from app.push_subs where board_id = v_board and endpoint <> v_endpoint) >= 20 then
    raise exception 'too_many_devices' using errcode = 'P0001';
  end if;
  -- 같은 기기가 다른 보드로 옮겨 구독하면 그 보드로 바뀐다
  insert into app.push_subs(board_id, endpoint, p256dh, auth, leads)
  values (v_board, v_endpoint, p_sub#>>'{keys,p256dh}', p_sub#>>'{keys,auth}', v_leads)
  on conflict (endpoint) do update
    set board_id = excluded.board_id, p256dh = excluded.p256dh, auth = excluded.auth,
        leads = excluded.leads, fail_count = 0;
  return jsonb_build_object('subscribed', true, 'leads', to_jsonb(v_leads));
end $$;

create or replace function public.dday_push_unsubscribe(p_code text, p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_board uuid := app.board_for(p_code);
begin
  delete from app.push_subs where board_id = v_board and endpoint = p_endpoint;
end $$;

create or replace function public.dday_push_status(p_code text, p_endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_sub app.push_subs;
begin
  select * into v_sub from app.push_subs where board_id = v_board and endpoint = p_endpoint;
  if v_sub.id is null then return jsonb_build_object('subscribed', false); end if;
  return jsonb_build_object('subscribed', true, 'leads', to_jsonb(v_sub.leads),
                            'lastOkAt', v_sub.last_ok_at);
end $$;

grant execute on function public.dday_push_subscribe(text, jsonb, int[]) to anon;
grant execute on function public.dday_push_unsubscribe(text, text) to anon;
grant execute on function public.dday_push_status(text, text) to anon;

/* ───── Edge Function(service_role) 전용 ───── */

-- 지금 보낼 알림 목록.
-- 과제마다 "이미 지난 알림 시점 중 마감에 가장 가까운 것" 하나만 고른다.
-- (1일 전·3시간 전 알림이 있는데 마감 2시간 전에 과제를 넣었다면 3시간 전 알림 하나만 보냄)
create or replace function public.dday_svc_push_due()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'subId', c.sub_id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
      'taskId', t.id, 'title', t.title, 'subject', t.subject, 'kind', t.kind,
      'location', t.location, 'due', t.due, 'lead', c.lead))
    from (
      select s.id as sub_id, t.board_id, t.id as task_id,
             (select min(l) from unnest(s.leads) l where now() >= t.due - make_interval(mins => l)) as lead
      from app.push_subs s
      join app.tasks t on t.board_id = s.board_id
      where not t.done and not t.hidden
        and t.due > now()
        and t.due <= now() + make_interval(mins => coalesce((select max(l) from unnest(s.leads) l), 0))
    ) c
    join app.push_subs s on s.id = c.sub_id
    join app.tasks t on t.board_id = c.board_id and t.id = c.task_id
    where c.lead is not null
      and not exists (
        select 1 from app.push_sent p
        where p.sub_id = c.sub_id and p.task_id = c.task_id and p.due = t.due and p.lead <= c.lead)
  ), '[]'::jsonb);
end $$;

-- 보낸 결과 기록. p_sent: [{subId, taskId, due, lead}], p_gone: 더 이상 유효하지 않은 구독 id
create or replace function public.dday_svc_push_done(p_sent jsonb, p_gone uuid[], p_failed uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into app.push_sent(sub_id, task_id, due, lead)
  select (x->>'subId')::uuid, x->>'taskId', (x->>'due')::timestamptz, (x->>'lead')::int
  from jsonb_array_elements(coalesce(p_sent, '[]'::jsonb)) x
  on conflict do nothing;

  update app.push_subs set last_ok_at = now(), fail_count = 0
  where id in (select distinct (x->>'subId')::uuid from jsonb_array_elements(coalesce(p_sent, '[]'::jsonb)) x);

  delete from app.push_subs where id = any(coalesce(p_gone, '{}'));

  -- 계속 실패하는 구독은 정리 (하루치 = 144번)
  update app.push_subs set fail_count = fail_count + 1 where id = any(coalesce(p_failed, '{}'));
  delete from app.push_subs where fail_count >= 144;

  delete from app.push_sent where sent_at < now() - interval '30 days';
end $$;

-- 테스트 알림용: 보드 코드 + endpoint로 구독 한 개
create or replace function public.dday_svc_push_one(p_code text, p_endpoint text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_board uuid := app.board_for(p_code);
  v_sub app.push_subs;
begin
  select * into v_sub from app.push_subs where board_id = v_board and endpoint = p_endpoint;
  if v_sub.id is null then return null; end if;
  return jsonb_build_object('subId', v_sub.id, 'endpoint', v_sub.endpoint,
                            'p256dh', v_sub.p256dh, 'auth', v_sub.auth);
end $$;

revoke execute on function public.dday_svc_push_due() from public, anon, authenticated;
revoke execute on function public.dday_svc_push_done(jsonb, uuid[], uuid[]) from public, anon, authenticated;
revoke execute on function public.dday_svc_push_one(text, text) from public, anon, authenticated;
grant execute on function public.dday_svc_push_due() to service_role;
grant execute on function public.dday_svc_push_done(jsonb, uuid[], uuid[]) to service_role;
grant execute on function public.dday_svc_push_one(text, text) to service_role;

-- VAPID 키: 개인 키는 Vault(dday_vapid_private)에만 둔다. 저장소에는 올리지 않는다.
--   select vault.create_secret('<개인 키>', 'dday_vapid_private', 'push-notify VAPID 개인 키');
create or replace function public.dday_svc_vapid()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'dday_vapid_private';
$$;
revoke execute on function public.dday_svc_vapid() from public, anon, authenticated;
grant execute on function public.dday_svc_vapid() to service_role;

-- 10분마다 실행 (canvas-sync와 같은 Vault 비밀값으로 인증)
select cron.schedule(
  'dday-push-notify',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://azwiggxcvmeppkfvdbln.supabase.co/functions/v1/push-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dday_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $job$
);
