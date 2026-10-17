-- canvas-sync Edge Function을 하루 3번(한국 시간 07:03, 13:03, 21:03) 자동 실행
-- - 인증용 비밀값은 Vault(dday_cron_secret)에만 두고, 함수는 dday_svc_cron_ok로 확인한다.
-- - 다른 프로젝트에 적용할 때는 아래 함수 URL의 프로젝트 ref를 바꾼다.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'dday_cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'dday_cron_secret',
      'canvas-sync 예약 실행 인증용');
  end if;
end $$;

create or replace function public.dday_svc_cron_ok(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'dday_cron_secret' and decrypted_secret = p_secret
  );
$$;
revoke execute on function public.dday_svc_cron_ok(text) from public, anon, authenticated;
grant execute on function public.dday_svc_cron_ok(text) to service_role;

select cron.schedule(
  'dday-canvas-sync',
  '3 4,12,22 * * *',   -- UTC 기준 = 한국 13:03, 21:03, 07:03
  $job$
  select net.http_post(
    url := 'https://azwiggxcvmeppkfvdbln.supabase.co/functions/v1/canvas-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dday_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
