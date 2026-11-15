import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { callTool, handle } from '../mcp/jira-board/server.mjs';
import { FAKE_ENV, ROOT, assertNoSecret, fixture, json, recordedJira } from './helpers.mjs';
import { startServer } from './mcp.mjs';

const MAIN = join(ROOT, 'mcp', 'jira-board', 'main.mjs');

test('over stdio: one tool, read-only, and check "env" gives presence and length only', async (t) => {
  const server = startServer(MAIN, { env: FAKE_ENV });
  t.after(() => server.stop());
  const init = await server.init();
  assert.equal(init.result.serverInfo.name, 'jira-board');
  const list = await server.request('tools/list', {});
  assert.deepEqual(list.result.tools.map((x) => x.name), ['jira_board_csv']);
  assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
  const r = await server.call('jira_board_csv', { check: 'env' });
  assert.deepEqual(r.result.structuredContent.env, {
    JIRA_BASE_URL: { present: true, length: FAKE_ENV.JIRA_BASE_URL.length },
    JIRA_EMAIL: { present: true, length: FAKE_ENV.JIRA_EMAIL.length },
    JIRA_API_TOKEN: { present: true, length: FAKE_ENV.JIRA_API_TOKEN.length },
  });
  assertNoSecret(t, server.output());
});

test('over stdio without the variables: absent, and a read names what is missing', async (t) => {
  const server = startServer(MAIN);
  t.after(() => server.stop());
  await server.init();
  const env = (await server.call('jira_board_csv', { check: 'env' })).result.structuredContent.env;
  assert.deepEqual(Object.values(env).map((v) => v.present), [false, false, false]);
  const read = await server.call('jira_board_csv', { project: 'HB' });
  assert.equal(read.result.isError, true);
  assert.match(read.result.content[0].text, /^missing-config: Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
});

test('check "setup" makes exactly two GETs and reports only a status and which field names exist', async (t) => {
  const fetch = recordedJira({ 'GET /rest/api/3/project/HB': () => json(200, { key: 'HB', lead: { displayName: 'Someone' } }) });
  const r = await callTool({ project: 'HB', check: 'setup' }, { env: FAKE_ENV, fetch });
  assert.deepEqual(fetch.calls.map((c) => `${c.method} ${c.path}`), ['GET /rest/api/3/project/HB', 'GET /rest/api/3/field']);
  const out = r.structuredContent;
  assert.deepEqual(out.project, { key: 'HB', httpStatus: 200 });
  assert.deepEqual(out.fields, { 'Story point estimate': 1, Value: 1, Urgency: 1, Risk: 1, 'Times Postponed': 1, 'Cost of Delay': 1 });
  assert.ok(!JSON.stringify(out).includes('Someone'));
  assertNoSecret(t, JSON.stringify(r));
});

test('check "setup" reports a missing field as 0', async () => {
  const fields = fixture('fields.json').filter((f) => f.name !== 'Story point estimate');
  const fetch = recordedJira({ 'GET /rest/api/3/project/HB': () => json(404, {}), 'GET /rest/api/3/field': () => json(200, fields) });
  const out = (await callTool({ project: 'HB', check: 'setup' }, { env: FAKE_ENV, fetch })).structuredContent;
  assert.equal(out.project.httpStatus, 404);
  assert.equal(out.fields['Story point estimate'], 0);
});

test('tool errors are results with isError, and never hold a secret', async (t) => {
  const cases = [
    [{ project: 'hb' }, recordedJira()],
    [{ project: 'HB' }, recordedJira({ 'GET /rest/api/3/field': () => json(401, { message: FAKE_ENV.JIRA_API_TOKEN }) })],
    [{ project: 'HB', check: 'nope' }, recordedJira()],
  ];
  for (const [args, fetch] of cases) {
    const r = await callTool(args, { env: FAKE_ENV, fetch });
    assert.equal(r.isError, true);
    assertNoSecret(t, JSON.stringify(r));
  }
});

test('JSON-RPC: notifications get no answer, unknown methods and tools are errors', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).error.code, -32601);
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'other' } })).error.code, -32602);
  assert.deepEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
});
