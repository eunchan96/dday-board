import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boardSettings, createOauthDatabase, createOauthHandler } from '../lib/sday-board-oauth.js';
import { oauthRoute } from '../lib/sday-oauth-route.js';
import { createAuthorizer, createDatabaseReader, createMcpHandler, metadata } from '../lib/sday-mcp.js';

const A='11111111-1111-1111-1111-111111111111', B='22222222-2222-2222-2222-222222222222';
const ownerCode='ABCDE-FGHJK-LMNPR-STUVW', otherCode='VWUTS-RPNML-KJHGF-EDCBA';
const key=randomBytes(32).toString('hex');
const hash=v=>createHash('sha256').update(v).digest('hex');
const scope='sday:read';
const args={name:'list_events',arguments:{from:'2026-11-25',to:'2026-11-26'}};

test('board code approval, SDK PKCE and read-only data, rotation and immediate revocation',async (t)=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema app;
    revoke all on schema app from public,anon,authenticated;
    create function app.hash_code(text) returns text language sql immutable set search_path='' as
    $$ select encode(pg_catalog.sha256(pg_catalog.convert_to(upper(regexp_replace(coalesce($1,''),'[^A-Za-z0-9]','','g')),'UTF8')),'hex') $$;
    create table app.boards(id uuid primary key,code_hash text not null);
    create table app.tasks(board_id uuid references app.boards, id text, title text, kind text, source text,
      due timestamptz, end_at timestamptz, all_day boolean not null default false, hidden boolean not null default false);
    insert into app.boards values ('${A}',app.hash_code('${ownerCode}')),('${B}',app.hash_code('${otherCode}'));
    insert into app.tasks values
     ('${A}','1','Manual test','exam','manual','2026-11-25 02:00Z',null,false,false),
     ('${A}','2','LMS test','assignment','canvas','2026-11-25 03:00Z',null,false,false),
     ('${A}','3','Hidden test','exam','manual','2026-11-25 03:00Z',null,false,true),
     ('${B}','1','Other board test','exam','manual','2026-11-25 02:00Z',null,false,false);
  `);
  for(const name of ['20261125153000_mcp_read_events.sql','20261125154000_mcp_board_oauth.sql']){
    await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  }
  await db.query("insert into app.mcp_oauth_config values ($1,decode($2,'hex'))",[A,hash(key)]);
  // Dedicated database client, with the same anonymous privileges as PostgREST.
  await db.exec('set role anon');
  await assert.rejects(db.exec('select * from app.mcp_oauth_config'),e=>e.code==='42501');
  await assert.rejects(db.exec("select app.dday_mcp_list_events_unchecked('','2026-11-25','2026-11-26','all')"),e=>e.code==='42501');
  let calls=0;
  const dataFetch=async (url,init)=>{
    assert.equal(init.headers.apikey,cfg.supabaseKey);
    const p=JSON.parse(init.body);
    try{
      if(url.pathname.endsWith('/dday_mcp_oauth')){
        return Response.json((await db.query('select public.dday_mcp_oauth($1,$2,$3) as ok',
          [p.p_server,p.p_op,p.p])).rows[0].ok);
      }
      calls++;
      return Response.json((await db.query('select public.dday_mcp_list_events($1,$2,$3,$4) as value',
        [p.p_key,p.p_from,p.p_to,p.p_source])).rows[0].value);
    }catch(e){return Response.json({code:e.code},{status:401});}
  };
  const dir=await mkdtemp(join(tmpdir(),'sday-board-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const crt=join(dir,'preview.crt'), pem=join(dir,'preview.key');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',pem,'-out',crt],{stdio:'pipe'});
  const certificate=await readFile(crt,'utf8');
  const trust=tls.getCACertificates('default');
  tls.setDefaultCACertificates([...trust,certificate]);
  t.after(()=>tls.setDefaultCACertificates(trust));
  const server=createServer({cert:certificate,key:await readFile(pem)},(req,res)=>{
    if(req.url==='/api/mcp') return mcp(req,res);
    if(req.url==='/.well-known/oauth-protected-resource/api/mcp'){
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(metadata(cfg)));return;
    }
    return (routes[new URL(req.url,cfg.issuer).pathname] ?? ((_req,res)=>res.writeHead(404).end()))(req,res);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const resource='https://127.0.0.1:'+server.address().port+'/api/mcp';
  const env={SDAY_MCP_AUTH_MODE:'board',SDAY_MCP_RESOURCE:resource,SDAY_SUPABASE_URL:'https://database.example',
    SDAY_MCP_OAUTH_REDIRECT:'https://chatgpt.com/connector/oauth/example-flow',SDAY_MCP_OAUTH_CLIENT:'sday-preview-client',
    SDAY_MCP_OAUTH_SERVER_KEY:key,SDAY_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic'};
  const cfg=boardSettings(env);
  const routes=Object.fromEntries(['/.well-known/oauth-authorization-server','/api/mcp-oauth/authorize',
    '/api/mcp-oauth/token','/api/mcp-oauth/revoke'].map(path=>[path,
      oauthRoute(path,env,c=>createOauthHandler(c,createOauthDatabase(c,dataFetch)))]));
  const mcp=createMcpHandler({config:cfg,authorize:createAuthorizer(cfg),read:createDatabaseReader(cfg,dataFetch)});
  const fetcher=(u,init={})=>{
    assert.equal(new URL(u).origin,cfg.issuer);
    return fetch(u,{...init,redirect:'manual'});
  };

  let consent, tokens, verifier;
  const provider={
    redirectUrl:cfg.redirect,clientMetadata:{redirect_uris:[cfg.redirect],token_endpoint_auth_method:'none',
      grant_types:['authorization_code','refresh_token'],response_types:['code']},
    state:()=> 'test-state',
    clientInformation:()=>({client_id:cfg.client,issuer:cfg.issuer}),
    tokens:()=>tokens,saveTokens:v=>{tokens=v;},redirectToAuthorization:u=>{consent=u;},
    saveCodeVerifier:v=>{verifier=v;},codeVerifier:()=>verifier,
  };
  const mc=new Client({name:'oauth-test',version:'1.0'});
  await mc.connect(new StreamableHTTPClientTransport(new URL(resource),{fetch:fetcher,authProvider:provider}));
  t.after(()=>mc.close());
  const noToken=await mc.callTool(args);
  assert.equal(noToken.isError,true);
  assert.equal(calls,0);
  const authOptions={serverUrl:resource,scope,fetchFn:fetcher,
    resourceMetadataUrl:new URL(/resource_metadata="([^"]+)"/.exec(noToken._meta['mcp/www_authenticate'][0])[1])};
  assert.equal(await auth(provider,authOptions),'REDIRECT');
  const bad=new URL(consent);
  bad.searchParams.set('redirect_uri','https://example.org/wrong');
  const wrongCallback=await fetcher(bad);
  assert.equal(wrongCallback.status,400);
  assert.deepEqual(await wrongCallback.json(),{error:'invalid_request',error_description:'callback_mismatch'});
  assert.equal((await fetcher(new URL(consent+'&state=extra'))).status,400);
  const screen=async path=>{
    const res=await fetcher(path);
    assert.equal(res.status,200);
    assert.match(res.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const cookie=res.headers.get('set-cookie').split(';')[0];
    const html=await res.text();
    assert.doesNotMatch(html,new RegExp(ownerCode));
    return {cookie,ticket:/name="ticket" value="([^"]+)"/.exec(html)[1]};
  };
  const origin=cfg.issuer;
  const submit=(path,info,board,from=origin)=>fetcher(cfg.issuer+'/api/mcp-oauth/'+path,{method:'POST',
    headers:{origin:from,cookie:info.cookie},body:new URLSearchParams({ticket:info.ticket,board_code:board})});
  const compat = new URL(consent);
  compat.searchParams.delete('scope');
  compat.searchParams.set('state','signed-client-state-'.repeat(70));
  compat.searchParams.set('client_extension','a-supported-opaque-client-parameter');
  assert.equal((await fetcher(compat)).status,200);
  compat.searchParams.set('resource','https://another.example/api/mcp');
  assert.equal((await fetcher(compat)).status,400);
  const pending=await screen(consent);
  assert.equal((await submit('authorize',pending,ownerCode,'https://other.example')).status,403);
  assert.equal((await submit('authorize',{...pending,cookie:''},ownerCode)).status,403);
  assert.equal((await submit('authorize',pending,otherCode)).status,403);
  const approval=await submit('authorize',pending,ownerCode);
  assert.equal(approval.status,303);
  assert.equal((await submit('authorize',pending,ownerCode)).status,403);
  const returnUrl=new URL(approval.headers.get('location'));
  assert.equal(returnUrl.pathname,new URL(cfg.redirect).pathname);
  assert.equal(returnUrl.searchParams.get('iss'),origin);
  assert.equal(returnUrl.searchParams.get('state'),'test-state');
  assert.doesNotMatch(returnUrl.href,new RegExp(ownerCode));
  const authorizationCode=returnUrl.searchParams.get('code');
  const params={...authOptions,authorizationCode};
  await assert.rejects(auth({...provider,codeVerifier:()=> 'z'.repeat(43)},params),{name:'InvalidGrantError'});
  assert.equal(await auth(provider,params),'AUTHORIZED');
  await assert.rejects(auth(provider,params),{name:'InvalidGrantError'});
  const first=tokens;
  assert.notEqual(first.access_token,ownerCode);
  const initial=await mc.callTool(args);
  assert.deepEqual(initial.structuredContent.events.map(x=>x.title),['Manual test','LMS test']);
  assert.doesNotMatch(JSON.stringify(initial),/Other board|Hidden test|board_id|project_key/);

  const refreshBody={client_id:cfg.client,grant_type:'refresh_token',refresh_token:first.refresh_token,resource};
  const exchange=p=>fetcher(cfg.issuer+'/api/mcp-oauth/token',{method:'POST',body:new URLSearchParams(p)});
  assert.equal((await exchange({...refreshBody,resource:'https://other.example/mcp'})).status,400);
  const refreshed=await exchange({...refreshBody,client_extension:'opaque-client-value'});
  assert.equal(refreshed.status,200);
  tokens=await refreshed.json();
  assert.equal((await exchange(refreshBody)).status,400);
  await assert.rejects(createDatabaseReader(cfg,dataFetch)({...args.arguments,source:'all'},'Bearer '+first.access_token));
  assert.equal((await mc.callTool(args)).isError,undefined);

  await db.exec('reset role; update app.mcp_read_grants set expires_at=now()-interval \'1 second\'; set role anon;');
  assert.equal((await mc.callTool(args)).isError,true);
  const currentRefresh=(await exchange({...refreshBody,refresh_token:tokens.refresh_token}));
  assert.equal(currentRefresh.status,200);
  tokens=await currentRefresh.json();
  assert.equal((await mc.callTool(args)).isError,undefined);
  const revokeForm=await screen(cfg.issuer+'/api/mcp-oauth/revoke');
  assert.equal((await submit('revoke',revokeForm,otherCode)).status,403);
  assert.equal((await submit('revoke',revokeForm,ownerCode)).status,200);
  assert.equal((await mc.callTool(args)).isError,true);
  assert.equal((await exchange({...refreshBody,refresh_token:tokens.refresh_token})).status,400);
});
