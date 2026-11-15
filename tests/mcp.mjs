// A tiny MCP stdio client for the tests: newline-delimited JSON-RPC.
import { spawn } from 'node:child_process';

export function startServer(script, { env = {} } = {}) {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
  let buffer = '';
  let stdout = '';
  let stderr = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  let next = 0;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return {
    request,
    async init() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      notify('notifications/initialized');
      return r;
    },
    call: (name, args) => request('tools/call', { name, arguments: args }),
    output: () => stdout + stderr,
    stop: () => child.kill(),
  };
}
