import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const readScope = 'sday:read';
export const ACCESS_SECONDS = 900;
const ttl = 300;
const maxStateBytes = 4096;
const maxTicketChars = 10000;
const maxFormChars = 12000;
const hex = /^[0-9a-f]{64}$/;
const pkce = /^[A-Za-z0-9_-]{43}$/;
const verifier = /^[A-Za-z0-9._~-]{43,128}$/;
const digest = v => createHash('sha256').update(v).digest('hex');
const random = () => randomBytes(32).toString('hex');
const enc = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const noRepeats = (p, names) => names.every(k => p.getAll(k).length <= 1);
const exact = (p, names) => noRepeats(p, names) && [...p.keys()].every(k => names.includes(k));
const content = 'application/x-www-form-urlencoded';

function https(value) {
  const u = new URL(value);
  if (u.protocol!=='https:' || u.username || u.password || u.search || u.hash) throw new Error('Invalid OAuth URL');
  return u;
}

export function boardSettings(env) {
  const resource = https(env.SDAY_MCP_RESOURCE);
  const db = https(env.SDAY_SUPABASE_URL);
  const redirect = https(env.SDAY_MCP_OAUTH_REDIRECT);
  const client = env.SDAY_MCP_OAUTH_CLIENT;
  const key = env.SDAY_MCP_OAUTH_SERVER_KEY;
  const publishable = env.SDAY_SUPABASE_PUBLISHABLE_KEY;
  if (resource.pathname!=='/api/mcp' || db.pathname!=='/' || !/^[A-Za-z0-9._~-]{8,128}$/.test(client??'') ||
      !hex.test(key??'') || !publishable?.startsWith('sb_publishable_')) throw new Error('Missing OAuth settings');
  if (redirect.origin!=='https://chatgpt.com' || !(redirect.pathname==='/connector_platform_oauth_redirect' ||
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(redirect.pathname))) throw new Error('Use exact ChatGPT callback');
  const binding = digest(JSON.stringify([client,redirect.href,resource.href]));
  return { resource:resource.href, issuer:resource.origin, db, database:db, redirect:redirect.href, client,
    serverKey:key, supabaseKey:publishable, binding, mode:'board' };
}

export function oauthMetadata(cfg) {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: cfg.issuer+'/api/mcp-oauth/authorize',
    token_endpoint: cfg.issuer+'/api/mcp-oauth/token',
    authorization_response_iss_parameter_supported: true,
    response_types_supported:['code'], response_modes_supported:['query'],
    grant_types_supported:['authorization_code','refresh_token'],
    token_endpoint_auth_methods_supported:['none'],
    code_challenge_methods_supported:['S256'], scopes_supported:[readScope],
  };
}

function sign(cfg, value) {
  return createHmac('sha256',Buffer.from(cfg.serverKey,'hex')).update('sday-consent-v1\0').update(value).digest();
}
function seal(cfg, data) {
  const payload = Buffer.from(JSON.stringify({ ...data, deadline: Math.floor(Date.now()/1000)+ttl })).toString('base64url');
  return payload+'.'+sign(cfg,payload).toString('base64url');
}
function unseal(cfg, token) {
  if (typeof token!=='string' || token.length>maxTicketChars || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split('.');
  if (!timingSafeEqual(sign(cfg,payload),Buffer.from(signature,'base64url'))) return null;
  const value = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  return value.deadline > Math.floor(Date.now()/1000) && value.binding === cfg.binding ? value : null;
}

async function form(req) {
  if (req.headers['content-type']?.split(';')[0].trim()!==content) return null;
  if (req.body && typeof req.body==='object' && !Buffer.isBuffer(req.body)) {
    if (Object.keys(req.body).length>12 || Object.values(req.body).some(x=>typeof x!=='string'||x.length>maxTicketChars)) return null;
    return new URLSearchParams(req.body);
  }
  let body = req.body==null ? '' : String(req.body);
  if (req.body==null) for await (const part of req) {
    body += part;
    if (body.length>maxFormChars) return null;
  }
  return body.length<=maxFormChars ? new URLSearchParams(body) : null;
}

export function createOauthDatabase(cfg, fetcher=fetch) {
  return async (op, p) => {
    const response = await fetcher(new URL('/rest/v1/rpc/dday_mcp_oauth',cfg.db),{
      method:'POST', redirect:'error', signal:AbortSignal.timeout(8000),
      headers:{apikey:cfg.supabaseKey,'Content-Type':'application/json'},
      body:JSON.stringify({p_server:cfg.serverKey,p_op:op,p}),
    });
    if (!response.ok) throw new Error('OAuth DB unavailable');
    return await response.json()===true;
  };
}

export function createOauthHandler(cfg, database=createOauthDatabase(cfg)) {
  const prefix='/api/mcp-oauth/';
  const reply=(res,status,type,body)=>res.writeHead(status,{'Content-Type':type}).end(body);
  const json=(res,status,body)=>reply(res,status,'application/json; charset=utf-8',JSON.stringify(body));
  const html=(res,status,body)=>reply(res,status,'text/html; charset=utf-8',
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>S-DAY 일정 연결</title><main>'+body+'</main></html>');
  const screen=(res,status,op,ticket,notice='')=>{
    // Native form navigation must retain a same-origin Origin header. Do not
    // send the OAuth URL, query, or POST data as an HTTP referrer.
    res.setHeader('Referrer-Policy','strict-origin');
    return html(res,status,
    '<h1>'+(op==='approve'?'S-DAY 일정 읽기 승인':'S-DAY 일정 연결 해제')+'</h1>'+
    '<p>'+(op==='approve'?'ChatGPT에 이 보드의 직접 입력 일정과 스마트캠퍼스 일정을 읽도록 허용합니다. 일정을 수정하거나 삭제할 수 없고, 보드 코드는 전달하지 않습니다.':'연결을 끊으면 이미 발급된 읽기 토큰도 즉시 사용할 수 없어요.')+'</p>'+
    (notice?'<p role="alert">'+enc(notice)+'</p>':'')+
    '<form action="'+prefix+(op==='approve'?'authorize':'revoke')+'" method="post">'+
    '<input type="hidden" name="ticket" value="'+enc(ticket)+'">'+
    '<label for="board-code">S-DAY 보드 코드</label> '+
    '<input id="board-code" name="board_code" type="password" required maxlength="80" autocomplete="off" spellcheck="false"> '+
    '<button type="submit">'+(op==='approve'?'읽기 허용':'연결 해제')+'</button></form>');
  };
  const cookie='__Host-sday-mcp-consent';
  const cookieOptions='; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=';
  const acceptTicket=(res,record,op)=>{
    res.setHeader('Set-Cookie',cookie+'='+record.rid+cookieOptions+ttl);
    screen(res,200,op,seal(cfg,{...record,binding:cfg.binding,op}));
  };
  return async (req,res,canonicalPath) => {
    try {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('X-Frame-Options','DENY');
      if (req.headers.host !== new URL(cfg.issuer).host) return json(res,400,{error:'invalid_request'});
      const u=new URL(req.url,cfg.issuer), p=u.searchParams;
      const path=canonicalPath??u.pathname;
      if (path==='/.well-known/oauth-authorization-server' && req.method==='GET') return json(res,200,oauthMetadata(cfg));
      if (path===prefix+'authorize' && req.method==='GET') {
        const names=['response_type','response_mode','client_id','redirect_uri','resource','scope','code_challenge','code_challenge_method','state'];
        // RFC 6749 permits unrecognized extension parameters and an omitted scope.
        // Never infer client, redirect, resource or PKCE from those extensions.
        const state = p.get('state');
        let reason;
        if (!noRepeats(p,names)) reason='duplicate_parameter';
        else if (p.get('response_type')!=='code'||(p.has('response_mode')&&p.get('response_mode')!=='query')) reason='unsupported_response';
        else if (p.get('client_id')!==cfg.client) reason='client_mismatch';
        else if (p.get('redirect_uri')!==cfg.redirect) reason='callback_mismatch';
        else if (p.get('resource')!==cfg.resource) reason='resource_mismatch';
        else if (p.get('scope')&&p.get('scope')!==readScope) reason='unsupported_scope';
        else if (p.get('code_challenge_method')!=='S256'||!pkce.test(p.get('code_challenge')??'')) reason='invalid_pkce';
        else if (!state||/[\x00-\x1f\x7f]/.test(state)||new URLSearchParams({state}).toString().length>maxStateBytes) reason='invalid_state';
        // Fixed labels only: never include the request URL, submitted values, or board code.
        if (reason) return json(res,400,{error:'invalid_request',error_description:reason});
        return acceptTicket(res,{rid:random(),state,challenge:p.get('code_challenge')},'approve');
      }
      if(path===prefix+'revoke' && req.method==='GET') return acceptTicket(res,{rid:random()},'revoke');
      if (req.method!=='POST') return json(res,405,{error:'invalid_request'});
      const body=await form(req);
      if (!body) return json(res,400,{error:'invalid_request'});
      if (path===prefix+'authorize'||path===prefix+'revoke') {
        if(req.headers.origin!==cfg.issuer||!exact(body,['ticket','board_code'])) return json(res,403,{error:'invalid_request'});
        const op=path.endsWith('/authorize')?'approve':'revoke';
        const ticket=unseal(cfg,body.get('ticket'));
        const incoming=String(req.headers.cookie??'').split(/;\s*/).find(x=>x.startsWith(cookie+'='))?.slice(cookie.length+1);
        if (!ticket||ticket.op!==op||incoming!==ticket.rid) return html(res,403,'<h1>승인 요청이 만료됐어요</h1><p>연결을 다시 시작해 주세요.</p>');
        const board=body.get('board_code')??'';
        if (!/^[A-Za-z0-9 -]{20,40}$/.test(board)) return screen(res,403,op,body.get('ticket'),'보드 코드를 확인해 주세요.');
        if (op==='revoke') {
          if(!await database('revoke',{board_code:board})) return screen(res,403,op,body.get('ticket'),'이 보드의 코드를 확인해 주세요.');
          res.setHeader('Set-Cookie',cookie+'='+cookieOptions+0);
          return html(res,200,'<h1>연결을 끊었어요</h1><p>기존 토큰으로 더 이상 일정을 읽을 수 없어요.</p>');
        }
        const code=random();
        if(!await database('approve',{board_code:board,rid:ticket.rid,code:digest(code),binding:cfg.binding,challenge:ticket.challenge}))
          return screen(res,403,op,body.get('ticket'),'보드 코드 또는 승인 요청을 확인해 주세요.');
        res.setHeader('Set-Cookie',cookie+'='+cookieOptions+0);
        const callback=new URL(cfg.redirect);
        callback.searchParams.set('code',code); callback.searchParams.set('state',ticket.state);
        callback.searchParams.set('iss',cfg.issuer);
        return res.writeHead(303,{Location:callback.href}).end();
      }
      if (path!==prefix+'token') return json(res,404,{error:'invalid_request'});
      if (req.headers.authorization||body.has('client_secret')||body.has('client_assertion')||
          body.has('client_assertion_type')||body.get('client_id')!==cfg.client)
        return json(res,400,{error:'invalid_client'});
      const fields=['grant_type','client_id','code','code_verifier','redirect_uri','resource','refresh_token','scope'];
      if(!noRepeats(body,fields)) return json(res,400,{error:'invalid_request'});
      const grant=body.get('grant_type'), exchange=grant==='authorization_code';
      if(!exchange&&grant!=='refresh_token') return json(res,400,{error:'unsupported_grant_type'});
      if(body.get('resource')!==cfg.resource) return json(res,400,{error:'invalid_target'});
      if(body.get('scope')&&body.get('scope')!==readScope) return json(res,400,{error:'invalid_scope'});
      if(exchange?body.has('refresh_token'):['code','code_verifier','redirect_uri'].some(k=>body.has(k)))
        return json(res,400,{error:'invalid_request'});
      const proof=body.get(exchange?'code':'refresh_token')??'';
      const v=body.get('code_verifier')??'';
      if(!hex.test(proof)||(exchange&&(!verifier.test(v)||body.get('redirect_uri')!==cfg.redirect)))
        return json(res,400,{error:'invalid_grant'});
      const access=random(), refresh=random();
      const ok=await database(exchange?'exchange':'refresh',{
        proof:digest(proof),binding:cfg.binding,access:digest(access),refresh:digest(refresh),
        ...(exchange?{challenge:createHash('sha256').update(v).digest('base64url')}:{}),
      });
      if(!ok) return json(res,400,{error:'invalid_grant'});
      return json(res,200,{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:ACCESS_SECONDS,scope:readScope});
    } catch {
      if(!res.headersSent) return json(res,503,{error:'temporarily_unavailable'});
      if(!res.writableEnded) res.end();
    }
  };
}
