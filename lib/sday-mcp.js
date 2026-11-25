import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { boardSettings } from './sday-board-oauth.js';

export const scope = 'sday:read';
const authScheme = { type: 'oauth2', scopes: [scope] };
const DAY_MS = 86_400_000;
const source = z.enum(['all', 'manual', 'canvas']);
const input = {
  from: z.iso.date().describe('Start date, inclusive, YYYY-MM-DD in Asia/Seoul.'),
  to: z.iso.date().describe('End date, exclusive, YYYY-MM-DD in Asia/Seoul; at most 31 days after from.'),
  source: source.default('all').describe('manual = user-added; canvas = imported from 스마트캠퍼스; all = both.'),
};
const event = z.object({
  title: z.string(),
  kind: z.enum(['assignment', 'exam', 'todo', 'etc']),
  source: z.enum(['manual', 'canvas']),
  date: z.iso.date(),
  start_or_due_at: z.iso.datetime({ offset: true }).nullable(),
  end_at: z.iso.datetime({ offset: true }).nullable(),
  all_day: z.boolean(),
});
const result = z.object({ timezone: z.literal('Asia/Seoul'), events: z.array(event).max(100), truncated: z.boolean() });

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Expected fixed HTTPS URL');
  return url;
}

export function loadConfig(env = process.env) {
  if (env.SDAY_MCP_AUTH_MODE === 'board') return boardSettings(env);
  if (env.SDAY_MCP_AUTH_MODE && env.SDAY_MCP_AUTH_MODE !== 'jwt') throw new Error('Unknown MCP auth mode');
  const resource = httpsUrl(env.SDAY_MCP_RESOURCE);
  if (resource.pathname !== '/api/mcp') throw new Error('Invalid MCP resource path');
  httpsUrl(env.SDAY_MCP_ISSUER);
  const jwks = httpsUrl(env.SDAY_MCP_JWKS_URL);
  const database = httpsUrl(env.SDAY_SUPABASE_URL);
  if (database.pathname !== '/') throw new Error('Invalid database base URL path');
  const subject = env.SDAY_MCP_SUBJECT?.trim();
  const dbKey = env.SDAY_MCP_DATABASE_KEY;
  const supabaseKey = env.SDAY_SUPABASE_PUBLISHABLE_KEY;
  if (!subject || !/^[0-9a-f]{64}$/.test(dbKey ?? '') ||
      !supabaseKey?.startsWith('sb_publishable_')) throw new Error('Incomplete MCP settings');
  return { resource: resource.href, issuer: env.SDAY_MCP_ISSUER,
    jwks, subject, database, dbKey, supabaseKey };
}

export function metadata(config) {
  return { resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: [scope], bearer_methods_supported: ['header'] };
}

export function createAuthorizer(config, keys) {
  if (config.mode === 'board') return async auth => typeof auth === 'string' && /^Bearer [0-9a-f]{64}$/i.test(auth) ? 'ok' : 'authenticate';
  keys ??= createRemoteJWKSet(config.jwks);
  return async (auth) => {
    const token = typeof auth === 'string' && /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(auth)?.[1];
    if (!token) return 'authenticate';
    let payload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ['RS256'], issuer: config.issuer, audience: config.resource,
        requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      }));
    } catch { return 'authenticate'; }
    if (payload.sub !== config.subject) return 'denied';
    if (typeof payload.scope !== 'string' || !payload.scope.split(/\s+/).includes(scope))
      return 'scope';
    return 'ok';
  };
}

export function createDatabaseReader(config, fetcher = fetch) {
  return async ({ from, to, source }, authorization) => {
    const response = await fetcher(new URL('/rest/v1/rpc/dday_mcp_list_events', config.database), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { apikey: config.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: config.mode === 'board' ? authorization.slice(7) : config.dbKey, p_from: from, p_to: to, p_source: source }),
    });
    if (!response.ok) {
      if (config.mode === 'board' && [401,403].includes(response.status) &&
          (await response.json().catch(() => null))?.code === '42501') throw new ReadTokenInvalid();
      throw new Error('Schedule database rejected the request');
    }
    return result.parse(await response.json());
  };
}

class ReadTokenInvalid extends Error {}

const error = (message, _meta) => ({ isError: true, content: [{ type: 'text', text: message }],
  ...(_meta ? { _meta } : {}) });

export function createMcpHandler({ config, authorize, read }) {
  const discovery = new URL('/.well-known/oauth-protected-resource/api/mcp', config.resource).href;
  const origins = new Set([new URL(config.resource).origin, 'https://chatgpt.com']);
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    const mcp = new McpServer({ name: 'sday-schedule', version: '1.0.0' });
    mcp.registerTool('list_events', {
      title: 'List S-DAY events',
      description: 'Read schedule items by Seoul date. Can filter items manually added by the user versus imported from Smart Campus. No writes, notes, links, or study history.',
      inputSchema: input, outputSchema: result,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [authScheme] },
    }, async (args) => {
      const status = await authorize(req.headers.authorization);
      if (status === 'denied') return error('This account is not authorized for this S-DAY board.');
      const needsAuth = kind => error('Connect your authorized S-DAY account to read its schedule.', {
        'mcp/www_authenticate': ['Bearer resource_metadata="' + discovery + '", scope="' + scope +
          '", error="' + (kind === 'scope' ? 'insufficient_scope' : 'invalid_token') +
          '", error_description="S-DAY approval is required"'],
      });
      if (status !== 'ok') return needsAuth(status);
      const days = (Date.parse(args.to) - Date.parse(args.from)) / DAY_MS;
      if (!(days > 0 && days <= 31)) return error('Choose a positive date range of at most 31 days.');
      try {
        const data = result.parse(await read(args, req.headers.authorization));
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (cause) {
        if (cause instanceof ReadTokenInvalid) return needsAuth('authenticate');
        return error('S-DAY is unavailable.');
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const close = () => { void transport.close().catch(() => {}); void mcp.close().catch(() => {}); };
    res.once('close', close);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else if (!res.writableEnded) res.end();
    }
  };
}
