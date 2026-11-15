// jira-board over MCP Streamable HTTP, for running OUTSIDE Crew in the user's own terminal.
//
// Why outside Crew: Crew scrubs JIRA_API_TOKEN from every process it starts, on purpose. So the reader runs in the user's
// terminal, with the user's environment, and Crew reaches it by url.
//
// Guards, in order, on every request:
//   1. bound to 127.0.0.1 only (there is no option to bind anywhere else);
//   2. Host must be 127.0.0.1 or localhost (DNS-rebinding protection), and Origin, when sent, must be too;
//   3. Authorization: Bearer <local token> must match (constant time). The token is not the Jira token: it is a random
//      value in a user-only file (localtoken.mjs) that only Crew's session and this server know.
// Then POST /mcp takes one JSON-RPC message and answers with one JSON body (the spec allows JSON instead of SSE).
// Nothing is logged per request.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { handle } from './server.mjs';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 47821;
export const PATH = '/mcp';
const MAX_BODY = 1_048_576;
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** The port from DSC_JIRA_BOARD_PORT, or the default. 0 means "any free port" and is for tests. */
export function portFrom(env) {
  const raw = env.DSC_JIRA_BOARD_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw.trim())) throw new Error('DSC_JIRA_BOARD_PORT must be a port number.');
  const port = Number(raw.trim());
  if (port !== 0 && (port < 1024 || port > 65535)) throw new Error('DSC_JIRA_BOARD_PORT must be 1024 to 65535.');
  return port;
}

/** Host header: `127.0.0.1`, `localhost`, optionally with this server's port. Anything else is refused. */
export function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const m = /^([a-z0-9.]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m) return false;
  if (!ALLOWED_HOSTNAMES.has(m[1].toLowerCase())) return false;
  return m[2] === undefined || Number(m[2]) === port;
}

/** Origin header: absent is fine (not a browser); present must be http(s)://127.0.0.1 or localhost. */
export function originAllowed(origin) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ALLOWED_HOSTNAMES.has(u.hostname) && u.username === '' && u.pathname === '/';
  } catch {
    return false;
  }
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

function bearerMatches(header, token) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header.trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

function send(res, status, body, extra = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(text);
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

/**
 * The HTTP server, not yet listening. `token` is required. `deps` goes to the tool (env, fetch), as in the stdio server.
 * Call `listen(port)`; it always binds to 127.0.0.1.
 */
export function createHttpServer({ token, deps = {} }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new Error('A local token of 32 or more URL-safe characters is required.');
  let boundPort = null;
  const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    // 1 and 2: who is asking, before anything else is read.
    if (!hostAllowed(req.headers.host, boundPort)) return send(res, 403, rpcError(-32000, 'Host not allowed.'));
    if (!originAllowed(req.headers.origin)) return send(res, 403, rpcError(-32000, 'Origin not allowed.'));
    const path = (req.url ?? '').split('?')[0];
    if (path !== PATH) return send(res, 404, rpcError(-32000, 'Not found.'));
    // 3: the shared local token.
    if (!bearerMatches(req.headers.authorization, token)) return send(res, 401, rpcError(-32001, 'Unauthorized.'), { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return send(res, 405, rpcError(-32000, 'Method not allowed.'), { Allow: 'POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, rpcError(-32000, 'Content-Type must be application/json.'));

    let size = 0;
    const chunks = [];
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        refused = true; // keep reading (and dropping) so the client gets the answer; requestTimeout bounds it
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (refused) return send(res, 413, rpcError(-32000, 'Request too large.'), { Connection: 'close' });
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, rpcError(-32700, 'Parse error'));
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) return send(res, 400, rpcError(-32600, 'Invalid request'));
      try {
        const answer = await handle(message, deps);
        if (answer === null) return send(res, 202); // a notification or a response: accepted, no body
        return send(res, 200, answer);
      } catch {
        return send(res, 500, rpcError(-32603, 'Internal error'));
      }
    });
    req.on('error', () => {});
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: HOST, port, exclusive: true }, () => {
          server.off('error', reject);
          const address = server.address();
          boundPort = address.port;
          resolve(address);
        });
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
