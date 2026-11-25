import { boardSettings, createOauthHandler } from '../../lib/sday-board-oauth.js';

let handler;
export default function oauth(req,res) {
  if (process.env.SDAY_MCP_AUTH_MODE !== 'board') {
    return res.writeHead(404,{'Cache-Control':'no-store'}).end();
  }
  try {
    handler ??= createOauthHandler(boardSettings(process.env));
  } catch {
    return res.writeHead(503,{'Cache-Control':'no-store'}).end('S-DAY OAuth is not configured.');
  }
  const path = new URL(req.url,'https://localhost').pathname;
  const action = req.query?.action ?? path.split('/').at(-1);
  if (!['authorize','token','revoke','metadata','oauth-authorization-server'].includes(action))
    return res.writeHead(404,{'Cache-Control':'no-store'}).end();
  const canonicalPath = ['metadata','oauth-authorization-server'].includes(action)
    ? '/.well-known/oauth-authorization-server' : '/api/mcp-oauth/'+action;
  return handler(req,res,canonicalPath);
}
