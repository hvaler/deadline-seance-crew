// jira-board: a stdio MCP server with one read-only tool, jira_board_csv. Started by main.mjs.
// stdout carries JSON-RPC only. Nothing is logged, so nothing secret can be.

import { createInterface } from 'node:readline';
import { BoardError, checkEnv, checkSetup, readBoard } from './board.mjs';

export const TOOL = {
  name: 'jira_board_csv',
  title: 'Jira board as CSV',
  description:
    'Reads the open issues (status category not Done) of one Jira Cloud project and returns them as the Jira CSV that Deadline Séance imports. ' +
    'Pass the text to the deadline-seance tools as { "source": "csv", "text": <csv> }. Read-only. ' +
    'check: "env" or "setup" is a diagnostic instead (see the check field); it never returns a credential value.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,9}$', description: 'The project key, for example HB.' },
      fixVersion: { type: 'string', maxLength: 100, description: 'Only issues with this fix version.' },
      check: {
        type: 'string',
        enum: ['env', 'setup'],
        description:
          '"env": only report whether the three JIRA_* variables reach this server, and their lengths; no request. ' +
          '"setup": also GET the project (HTTP status only) and GET the field list (whether each needed field name exists). No issue is read.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const SERVER_INFO = { name: 'jira-board', version: '0.1.0' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export async function callTool(args, deps) {
  try {
    if (args?.check !== undefined) {
      if (args.check !== 'env' && args.check !== 'setup') throw new BoardError('bad-input', 'check must be "env" or "setup".');
      const env = checkEnv(deps?.env ?? process.env);
      const out = args.check === 'env' ? { env } : { env, ...(await checkSetup(args, deps)) };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
    }
    const result = await readBoard(args, deps);
    return { content: [{ type: 'text', text: result.csv }], structuredContent: result };
  } catch (error) {
    const e = error instanceof BoardError ? error : new BoardError('internal', 'jira-board failed unexpectedly.');
    return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}` }], structuredContent: { error: { code: e.code, message: e.message } } };
  }
}

export async function handle(message, deps) {
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });
  if (typeof method !== 'string') return id === undefined ? null : fail(-32600, 'Invalid request');
  if (id === undefined) return null; // a notification
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [TOOL] });
    case 'tools/call':
      if (params?.name !== TOOL.name) return fail(-32602, `Unknown tool: ${String(params?.name).slice(0, 60)}`);
      return reply(await callTool(params.arguments ?? {}, deps));
    default:
      return fail(-32601, 'Method not found');
  }
}

export function serve(input = process.stdin, output = process.stdout, deps = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    const answer = await handle(message, deps);
    if (answer !== null) output.write(`${JSON.stringify(answer)}\n`);
  });
  return lines;
}
