import { loadConfig, metadata } from '../lib/sday-mcp.js';

export default function protectedResource(req, res) {
  if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
  try {
    const body = JSON.stringify(metadata(loadConfig()));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(503, { 'Cache-Control': 'no-store' }).end('S-DAY MCP is not configured.');
  }
}
