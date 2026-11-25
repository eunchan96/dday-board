-- No service-role key or board code is retained by the OAuth server.
alter table app.mcp_read_grants add column expires_at timestamptz;
alter function public.dday_mcp_list_events(text,date,date,text) rename to dday_mcp_list_events_unchecked;
alter function public.dday_mcp_list_events_unchecked(text,date,date,text) set schema app;
revoke all on function app.dday_mcp_list_events_unchecked(text,date,date,text) from public, anon, authenticated;
create function public.dday_mcp_list_events(p_key text,p_from date,p_to date,p_source text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' or not exists (
    select 1 from app.mcp_read_grants where key_hash=pg_catalog.sha256(pg_catalog.convert_to(p_key,'UTF8'))
    and (expires_at is null or expires_at > now())
  ) then raise exception 'read_grant_invalid' using errcode='42501'; end if;
  return app.dday_mcp_list_events_unchecked(p_key,p_from,p_to,p_source);
end $$;
revoke all on function public.dday_mcp_list_events(text,date,date,text) from public, anon, authenticated;
grant execute on function public.dday_mcp_list_events(text,date,date,text) to anon;

create table app.mcp_oauth_config (
  board_id uuid primary key references app.boards(id) on delete cascade,
  server_hash bytea not null unique check (octet_length(server_hash)=32)
);
create table app.mcp_oauth_codes (
  request_id text primary key,
  board_id uuid not null references app.mcp_oauth_config(board_id) on delete cascade,
  code_hash bytea not null unique,
  binding text not null,
  challenge text not null,
  expires_at timestamptz not null,
  used boolean not null default false
);
create table app.mcp_oauth_links (
  board_id uuid primary key references app.mcp_oauth_config(board_id) on delete cascade,
  binding text not null,
  access_hash bytea not null,
  refresh_hash bytea not null,
  refresh_expires_at timestamptz not null
);
alter table app.mcp_oauth_config enable row level security;
alter table app.mcp_oauth_codes enable row level security;
alter table app.mcp_oauth_links enable row level security;
revoke all on app.mcp_oauth_config,app.mcp_oauth_codes,app.mcp_oauth_links from public,anon,authenticated;

create function app.mcp_oauth_board(p_server text) returns uuid
language sql stable set search_path='' as $$
  select board_id from app.mcp_oauth_config
   where p_server ~ '^[0-9a-f]{64}$' and server_hash=pg_catalog.sha256(pg_catalog.convert_to(p_server,'UTF8'))
$$;
revoke all on function app.mcp_oauth_board(text) from public,anon,authenticated;

-- The configuration row lock serializes code exchange, refresh and revocation for this one board.
-- An exact board-code hash is required for consent and for revocation.
create function public.dday_mcp_oauth(p_server text,p_op text,p jsonb)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare
  b uuid := app.mcp_oauth_board(p_server);
  a bytea;
  r bytea;
  previous_access bytea;
  auth_code app.mcp_oauth_codes%rowtype;
  old_link app.mcp_oauth_links%rowtype;
begin
  if b is null or p is null or jsonb_typeof(p)<>'object' then return false; end if;
  perform 1 from app.mcp_oauth_config where board_id=b for update;
  if not found then return false; end if;
  if p_op in ('approve','revoke') then
    if length(coalesce(p->>'board_code','')) > 80 or not exists (
      select 1 from app.boards where id=b and code_hash=app.hash_code(p->>'board_code')
    ) then return false; end if;
    if p_op='revoke' then
      delete from app.mcp_oauth_codes where board_id=b;
      delete from app.mcp_oauth_links where board_id=b returning access_hash into previous_access;
      delete from app.mcp_read_grants where key_hash=previous_access;
      return true;
    end if;
    if coalesce(p->>'rid','') !~ '^[0-9a-f]{64}$' or coalesce(p->>'code','') !~ '^[0-9a-f]{64}$'
      or coalesce(p->>'binding','') !~ '^[0-9a-f]{64}$' or coalesce(p->>'challenge','') !~ '^[A-Za-z0-9_-]{43}$'
    then return false; end if;
    delete from app.mcp_oauth_codes where board_id=b and expires_at < now()-interval '10 minutes';
    insert into app.mcp_oauth_codes(request_id,board_id,code_hash,binding,challenge,expires_at)
    values (p->>'rid',b,decode(p->>'code','hex'),p->>'binding',p->>'challenge',now()+interval '2 minutes')
    on conflict do nothing;
    return found;
  end if;
  if coalesce(p->>'proof','') !~ '^[0-9a-f]{64}$' or coalesce(p->>'binding','') !~ '^[0-9a-f]{64}$'
    or coalesce(p->>'access','') !~ '^[0-9a-f]{64}$' or coalesce(p->>'refresh','') !~ '^[0-9a-f]{64}$'
  then return false; end if;
  a:=decode(p->>'access','hex'); r:=decode(p->>'refresh','hex');
  select * into old_link from app.mcp_oauth_links where board_id=b;
  if p_op='exchange' then
    select * into auth_code from app.mcp_oauth_codes where board_id=b and code_hash=decode(p->>'proof','hex')
      and not used and expires_at>now() and binding=p->>'binding' and challenge=p->>'challenge';
    if not found then return false; end if;
    update app.mcp_oauth_codes set used=true where request_id=auth_code.request_id;
    -- Older, unexchanged approvals must not be able to replace the newly connected client.
    update app.mcp_oauth_codes set used=true where board_id=b and not used;
  elsif p_op='refresh' then
    if old_link.refresh_hash is distinct from decode(p->>'proof','hex')
       or old_link.binding is distinct from p->>'binding' or old_link.refresh_expires_at<=now()
    then return false; end if;
  else return false;
  end if;
  delete from app.mcp_read_grants where key_hash=old_link.access_hash;
  insert into app.mcp_read_grants(key_hash,board_id,label,expires_at)
  values(a,b,'S-DAY OAuth read',now()+interval '15 minutes');
  insert into app.mcp_oauth_links(board_id,binding,access_hash,refresh_hash,refresh_expires_at)
  values (b,p->>'binding',a,r,now()+interval '90 days')
  on conflict(board_id) do update set binding=excluded.binding,access_hash=excluded.access_hash,
    refresh_hash=excluded.refresh_hash,refresh_expires_at=excluded.refresh_expires_at;
  return true;
end $$;
revoke all on function public.dday_mcp_oauth(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.dday_mcp_oauth(text,text,jsonb) to anon;
