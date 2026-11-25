import { loadConfig, createMcpHandler, createAuthorizer, createDatabaseReader } from '../lib/sday-mcp.js';

let handler;
export default function mcp(req, res) {
  if (!handler) {
    try {
      const config = loadConfig();
      handler = createMcpHandler({ config, authorize: createAuthorizer(config), read: createDatabaseReader(config) });
    } catch {
      res.writeHead(503, { 'Cache-Control': 'no-store' }).end('S-DAY MCP is not configured.');
      return;
    }
  }
  return handler(req, res);
}
