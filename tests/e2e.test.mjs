// The CSV jira-board makes from the recorded HB project, sent to the vendored Deadline Séance server.
// The recorded project holds the 19 sample tickets, so the numbers must be the sample's (keys HB-101.. become HB-1..).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readBoard } from '../mcp/jira-board/board.mjs';
import { FAKE_ENV, ROOT, recordedJira } from './helpers.mjs';
import { startServer } from './mcp.mjs';

const VENDOR = join(ROOT, 'vendor', 'deadline-seance-mcp.mjs');
const NOW = '2026-11-16T09:00:00+01:00';
const FREEZE = '2026-11-20T18:00:00+01:00';

test('what_if Ana away all week, on the Jira CSV: 59 -> 39, 12 -> 9 kept, 167 -> 124, HB-13, HB-15, HB-18 out', async (t) => {
  const { csv } = await readBoard({ project: 'HB' }, { env: FAKE_ENV, fetch: recordedJira() });
  const server = startServer(VENDOR);
  t.after(() => server.stop());
  const init = await server.init();
  assert.equal(init.result.serverInfo.name, 'deadline-seance');
  const tools = await server.request('tools/list', {});
  assert.deepEqual(tools.result.tools.map((x) => x.name).sort(), ['death_certificate', 'solve_freeze', 'what_if']);

  const r = await server.call('what_if', { board: { source: 'csv', text: csv }, now: NOW, freezeAt: FREEZE, change: { kind: 'away', person: 'Ana' } });
  assert.notEqual(r.result.isError, true, JSON.stringify(r.result.content));
  const out = r.result.structuredContent;
  assert.deepEqual([out.before.capacity, out.after.capacity], [59, 39]);
  assert.deepEqual([out.before.tickets, out.after.tickets], [12, 9]);
  assert.deepEqual([out.before.cod, out.after.cod], [167, 124]);
  assert.equal(out.cod_delta, -43);
  assert.deepEqual(out.goes_out.map((x) => x.key), ['HB-13', 'HB-15', 'HB-18']);
  assert.deepEqual(out.comes_in, []);
});

test('death_certificate on the Jira CSV passes its own guard', async (t) => {
  const { csv } = await readBoard({ project: 'HB' }, { env: FAKE_ENV, fetch: recordedJira() });
  const server = startServer(VENDOR);
  t.after(() => server.stop());
  await server.init();
  const r = await server.call('death_certificate', { board: { source: 'csv', text: csv }, now: NOW, freezeAt: FREEZE, release: 'Hollow Bank app 3.2' });
  assert.notEqual(r.result.isError, true, JSON.stringify(r.result.content));
  assert.equal(r.result.structuredContent.guard.ok, true);
  assert.match(r.result.structuredContent.markdown, /HB-\d+/);
});
