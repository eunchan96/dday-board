import { boardSettings, createOauthHandler } from './sday-board-oauth.js';

// Use static function paths: a dynamic route's path parameter can be injected
// into the query string by the deployment runtime and is not an OAuth parameter.
export function oauthRoute(path, env=process.env, factory=createOauthHandler) {
  let handler;
  return (req,res) => {
    if (env.SDAY_MCP_AUTH_MODE !== 'board') {
      return res.writeHead(404,{'Cache-Control':'no-store'}).end();
    }
    try {
      handler ??= factory(boardSettings(env));
    } catch {
      return res.writeHead(503,{'Cache-Control':'no-store'}).end('S-DAY OAuth is not configured.');
    }
    return handler(req,res,path);
  };
}
