import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { SignJWT, generateKeyPair } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createAuthorizer, createDatabaseReader, createMcpHandler, loadConfig, metadata } from '../lib/sday-mcp.js';

const a = '11111111-1111-1111-1111-111111111111';
const b = '22222222-2222-2222-2222-222222222222';
const key = 'a'.repeat(64), secondKey = 'b'.repeat(64);
const env = {
  SDAY_MCP_RESOURCE: 'https://sday.example/api/mcp',
  SDAY_MCP_ISSUER: 'https://identity.example/',
  SDAY_MCP_JWKS_URL: 'https://identity.example/jwks',
  SDAY_MCP_SUBJECT: 'sample-owner',
  SDAY_MCP_DATABASE_KEY: key,
  SDAY_SUPABASE_URL: 'https://database.example',
  SDAY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake',
};
const config = loadConfig(env);
const dates = { from: '2026-11-25', to: '2026-11-26' };

async function sampleDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema app;
    revoke all on schema app from public, anon, authenticated;
    create table app.boards (id uuid primary key);
    create table app.tasks (
      board_id uuid not null references app.boards(id), id text not null, title text not null,
      kind text not null, source text not null, due timestamptz not null, end_at timestamptz,
      all_day boolean not null default false, hidden boolean not null default false,
      memo text not null default 'private fixture memo', link text not null default 'https://example.com/private',
      primary key (board_id,id)
    );
    insert into app.boards values ('${a}'), ('${b}');
    insert into app.tasks (board_id,id,title,kind,source,due,end_at,all_day,hidden) values
      ('${a}','before','Before range','etc','manual','2026-11-24T14:59:59Z',null,false,false),
      ('${a}','a','Sample exam','exam','manual','2026-11-24T15:00:00Z','2026-11-24T16:00:00Z',false,false),
      ('${a}','b','Sample LMS assignment','assignment','canvas','2026-11-25T01:00:00Z',null,false,false),
      ('${a}','c','Sample all-day','etc','manual','2026-11-25T14:59:59Z',null,true,false),
      ('${a}','d','Hidden task','assignment','canvas','2026-11-25T04:00:00Z',null,false,true),
      ('${a}','e','After range','etc','manual','2026-11-25T15:00:00Z',null,false,false),
      ('${b}','f','Other board private fixture','assignment','manual','2026-11-25T02:00:00Z',null,false,false);
  `);
  const migration = await readFile(new URL('../supabase/migrations/20261125153000_mcp_read_events.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  for (const [id, secret] of [[a, key], [b, secondKey]]) {
    await db.query("insert into app.mcp_read_grants values (decode($1,'hex'),$2,'local test')",
      [createHash('sha256').update(secret).digest('hex'), id]);
  }
  return db;
}

const query = async (db, pKey, source = 'all', to = dates.to) =>
  (await db.query('select public.dday_mcp_list_events($1,$2,$3,$4) as result', [pKey, dates.from, to, source])).rows[0].result;
const titles = x => x.events.map(e => e.title);

test('configuration fails closed, and metadata advertises only sday:read', () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ ...env, SDAY_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_fake' }));
  assert.throws(() => loadConfig({ ...env, SDAY_MCP_RESOURCE: 'https://sday.example/api/mcp?key=example' }));
  assert.deepEqual(metadata(config), { resource: env.SDAY_MCP_RESOURCE,
    authorization_servers: [env.SDAY_MCP_ISSUER], scopes_supported: ['sday:read'], bearer_methods_supported: ['header'] });
});

test('SQL reads only its board, filters by Seoul date and source, omits private fields, and revokes instantly', async () => {
  const db = await sampleDatabase();
  try {
    await db.exec('set role anon');
    const all = await query(db, key);
    assert.deepEqual(titles(all), ['Sample exam', 'Sample LMS assignment', 'Sample all-day']);
    const manual = await query(db, key, 'manual');
    assert.deepEqual(titles(manual), ['Sample exam', 'Sample all-day']);
    assert.deepEqual(titles(await query(db, key, 'canvas')), ['Sample LMS assignment']);
    assert.deepEqual(titles(await query(db, secondKey)), ['Other board private fixture']);
    assert.deepEqual(Object.keys(manual.events[0]).sort(),
      ['all_day','date','end_at','kind','source','start_or_due_at','title']);
    assert.deepEqual(manual.events[1], { all_day:true, date:'2026-11-25', end_at:null,
      kind:'etc', source:'manual', start_or_due_at:null, title:'Sample all-day' });
    await assert.rejects(db.exec('select * from app.tasks'), e => e.code === '42501');
    await assert.rejects(query(db, 'c'.repeat(64)), e => e.code === '42501');
    await assert.rejects(query(db, key, 'all', '2027-02-26'), e => e.code === '22023');
    await assert.rejects(query(db, key, 'all', 'infinity'), e => e.code === '22023');
    await db.exec('reset role');
    await db.exec("delete from app.mcp_read_grants where board_id = '" + a + "'");
    await db.exec('set role anon');
    await assert.rejects(query(db, key), e => e.code === '42501');
  } finally { await db.close(); }
});

test('SQL bounds large responses and retains stable ordering', async () => {
  const db = await sampleDatabase();
  try {
    await db.query(`insert into app.tasks (board_id,id,title,kind,source,due)
      select $1, lpad(i::text,3,'0'), 'Sample ' || i,'exam','manual','2026-11-25T01:00:00Z'
        from generate_series(1,103) g(i)`, [a]);
    const data = await query(db, key, 'manual');
    assert.equal(data.events.length, 100);
    assert.equal(data.truncated, true);
    assert.equal(data.events.at(-1).title, 'Sample 99');
  } finally { await db.close(); }
});

test('MCP HTTP sample end-to-end with signed access tokens and the real SQL migration', async (t) => {
  const db = await sampleDatabase();
  t.after(() => db.close());
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const issue = ({subject = config.subject, audience = config.resource, scope = 'sday:read', expiry = '5m'} = {}) =>
    new SignJWT({scope}).setProtectedHeader({alg:'RS256'}).setIssuer(config.issuer)
      .setAudience(audience).setSubject(subject).setExpirationTime(expiry).sign(privateKey);
  const authorize = createAuthorizer(config, publicKey);
  let reads = 0;
  const reader = createDatabaseReader(config, async (url, init) => {
    reads++;
    assert.equal(url.href, 'https://database.example/rest/v1/rpc/dday_mcp_list_events');
    assert.equal(init.headers.apikey, env.SDAY_SUPABASE_PUBLISHABLE_KEY);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['p_from', 'p_key', 'p_source', 'p_to']);
    assert.equal(body.p_key, key);
    return Response.json((await db.query('select public.dday_mcp_list_events($1,$2,$3,$4) as result',
      [body.p_key,body.p_from,body.p_to,body.p_source])).rows[0].result);
  });
  const server = createServer(createMcpHandler({ config, authorize, read: reader }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = new URL('http://127.0.0.1:' + server.address().port + '/api/mcp');
  async function client(token) {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: token ? { headers: { Authorization: 'Bearer ' + token } } : {},
    });
    const mc = new Client({name:'sample-client', version:'1.0.0'});
    await mc.connect(transport);
    t.after(() => mc.close());
    return mc;
  }
  const args = { name: 'list_events', arguments: {...dates, source:'manual'} };
  const rejectedOrigin = await fetch(url, {method:'POST', headers:{Origin:'https://unknown.example'}});
  assert.equal(rejectedOrigin.status, 403);
  const noToken = await client();
  const tools = (await noToken.listTools()).tools;
  assert.deepEqual(tools.map(x => x.name), ['list_events']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  const denied = await noToken.callTool(args);
  assert.equal(denied.isError, true);
  assert.match(denied._meta['mcp/www_authenticate'][0], /resource_metadata=.*sday:read/);
  for (const opts of [{subject:'other-user'}, {audience:'https://different.example'},
    {scope:'other:read'}, {expiry: Math.floor(Date.now() / 1000) - 5}]) {
    const other = await client(await issue(opts));
    assert.equal((await other.callTool(args)).isError, true);
  }
  const user = await client(await issue());
  assert.equal((await user.callTool({ ...args, arguments: {...dates, to:'2027-04-01'} })).isError, true);
  assert.equal(reads, 0);
  const result = await user.callTool(args);
  assert.ok(!result.isError, JSON.stringify(result));
  assert.deepEqual(titles(result.structuredContent), ['Sample exam','Sample all-day']);
  assert.equal(result.structuredContent.timezone, 'Asia/Seoul');
  assert.equal(result.structuredContent.truncated, false);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json,/private fixture|https:\/\/example.com\/private|board_id|p_key/);
  assert.equal(reads,1);
});
