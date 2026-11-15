import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BoardError, MAX_ISSUES, buildJql, readBoard } from '../mcp/jira-board/board.mjs';
import { SAMPLE_CSV_PATH } from '../scripts/sample-board.mjs';
import { FAKE_ENV, assertNoSecret, fixture, issue, json, oneSearch, recordedJira } from './helpers.mjs';

const deps = (fetch, env = FAKE_ENV) => ({ fetch, env });

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => e instanceof BoardError && e.code === code);
}

test('the recorded HB project becomes the sample CSV, with the keys Jira gives', async () => {
  const result = await readBoard({ project: 'HB' }, deps(recordedJira()));
  const expected = readFileSync(SAMPLE_CSV_PATH, 'utf8')
    .replace(/HB-1(\d\d)/g, (_, n) => `HB-${Number(n)}`)
    .replace(/\r?\n/g, '\r\n');
  assert.equal(result.csv, expected);
  assert.equal(result.issueCount, 19);
  assert.deepEqual(result.warnings, []);
});

test('it reads with POST /rest/api/3/search/jql, follows nextPageToken, and asks only for the fields it needs', async () => {
  const fetch = recordedJira();
  await readBoard({ project: 'HB' }, deps(fetch));
  assert.deepEqual(fetch.calls.map((c) => `${c.method} ${c.path}`), ['GET /rest/api/3/field', 'POST /rest/api/3/search/jql', 'POST /rest/api/3/search/jql']);
  const [, first, second] = fetch.calls;
  assert.equal(first.origin, 'https://example.atlassian.net');
  assert.equal(first.body.jql, 'project = "HB" AND statusCategory != Done ORDER BY key ASC');
  assert.equal(first.body.nextPageToken, undefined);
  assert.equal(second.body.nextPageToken, 'invented-token-page-2');
  assert.deepEqual(first.body.fields.slice(0, 4), ['summary', 'labels', 'issuelinks', 'fixVersions']);
  assert.ok(!first.body.fields.includes('assignee'), 'no people fields');
  assert.ok(!first.body.fields.includes('*all'));
  assert.equal(first.headers.Authorization, `Basic ${Buffer.from(`${FAKE_ENV.JIRA_EMAIL}:${FAKE_ENV.JIRA_API_TOKEN}`).toString('base64')}`);
});

test('fixVersion narrows the JQL and is quoted', () => {
  assert.equal(buildJql({ project: 'HB', fixVersion: 'App "3.2" \\ beta' }), 'project = "HB" AND statusCategory != Done AND fixVersion = "App \\"3.2\\" \\\\ beta" ORDER BY key ASC');
});

test('a bad project key or fix version is refused before any request', async () => {
  for (const project of ['hb', 'H', 'HB" OR project != "X', '', 42, undefined]) {
    const fetch = recordedJira();
    await rejects(readBoard({ project }, deps(fetch)), 'bad-input');
    assert.equal(fetch.calls.length, 0);
  }
  await rejects(readBoard({ project: 'HB', fixVersion: 'a\nb' }, deps(recordedJira())), 'bad-input');
  await rejects(readBoard({ project: 'HB', fixVersion: 'x'.repeat(101) }, deps(recordedJira())), 'bad-input');
});

test('missing variables are named, never shown', async (t) => {
  const fetch = recordedJira();
  const error = await readBoard({ project: 'HB' }, deps(fetch, { JIRA_BASE_URL: FAKE_ENV.JIRA_BASE_URL })).catch((e) => e);
  assert.equal(error.code, 'missing-config');
  assert.match(error.message, /JIRA_EMAIL, JIRA_API_TOKEN/);
  assertNoSecret(t, error.message);
  assert.equal(fetch.calls.length, 0);
});

test('only https://<site>.atlassian.net is accepted as the base URL', async (t) => {
  for (const url of ['http://example.atlassian.net', 'https://example.com', 'https://user:pw@example.atlassian.net', 'not a url', 'https://atlassian.net.example.com']) {
    const error = await readBoard({ project: 'HB' }, deps(recordedJira(), { ...FAKE_ENV, JIRA_BASE_URL: url })).catch((e) => e);
    assert.equal(error.code, 'bad-config', url);
    assert.ok(!error.message.includes(url));
    assertNoSecret(t, error.message);
  }
});

test('HTTP errors become plain sentences without the URL or credentials', async (t) => {
  for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [404, 'not-found'], [429, 'rate-limited'], [500, 'http-error']]) {
    const fetch = recordedJira({ 'GET /rest/api/3/field': () => json(status, { errorMessages: [`${FAKE_ENV.JIRA_EMAIL} is not allowed`] }) });
    const error = await readBoard({ project: 'HB' }, deps(fetch)).catch((e) => e);
    assert.equal(error.code, code);
    assertNoSecret(t, error.message);
  }
});

test('a network error does not pass on the text fetch gives (it can hold the URL)', async (t) => {
  const fetch = async () => {
    throw new TypeError(`fetch failed for https://example.atlassian.net with ${FAKE_ENV.JIRA_API_TOKEN}`);
  };
  const error = await readBoard({ project: 'HB' }, deps(fetch)).catch((e) => e);
  assert.equal(error.code, 'network');
  assertNoSecret(t, error.message);
});

test('a missing or doubled field name is an error that names the field', async () => {
  const without = fixture('fields.json').filter((f) => f.name !== 'Times Postponed');
  await rejects(readBoard({ project: 'HB' }, deps(recordedJira({ 'GET /rest/api/3/field': () => json(200, without) }))), 'missing-field');
  const doubled = [...fixture('fields.json'), { id: 'customfield_19999', name: 'risk ', custom: true }];
  const error = await readBoard({ project: 'HB' }, deps(recordedJira({ 'GET /rest/api/3/field': () => json(200, doubled) }))).catch((e) => e);
  assert.equal(error.code, 'ambiguous-field');
  assert.match(error.message, /"Risk"/);
});

test('Cost of Delay is optional: without the field the column is empty', async () => {
  const fields = fixture('fields.json').filter((f) => f.name !== 'Cost of Delay');
  const routes = recordedJira({ 'GET /rest/api/3/field': () => json(200, fields), 'POST /rest/api/3/search/jql': () => json(200, { issues: [issue('HB-1')], isLast: true }) });
  const { csv } = await readBoard({ project: 'HB' }, deps(routes));
  assert.equal(csv.split('\r\n')[1], 'HB-1,Ticket HB-1,3,5,3,2,,no,,0,,');
});

test('more open issues than Deadline Séance reads is refused, not cut', async () => {
  const many = Array.from({ length: MAX_ISSUES + 1 }, (_, i) => issue(`HB-${i + 1}`));
  await rejects(readBoard({ project: 'HB' }, deps(oneSearch(many))), 'too-many-issues');
  const exactly = Array.from({ length: MAX_ISSUES }, (_, i) => issue(`HB-${i + 1}`));
  assert.equal((await readBoard({ project: 'HB' }, deps(oneSearch(exactly)))).issueCount, MAX_ISSUES);
});

test('the same page token twice stops the loop', async () => {
  const fetch = recordedJira({ 'POST /rest/api/3/search/jql': () => json(200, { issues: [issue('HB-1')], nextPageToken: 'same' }) });
  await rejects(readBoard({ project: 'HB' }, deps(fetch)), 'pagination-loop');
});

test('an empty project is an error, not an empty board', async () => {
  await rejects(readBoard({ project: 'HB' }, deps(oneSearch([]))), 'no-issues');
});

test('cells a spreadsheet would run get an apostrophe; commas, quotes and line breaks are quoted', async () => {
  const issues = [
    issue('HB-1', { summary: '=HYPERLINK("http://x")' }),
    issue('HB-2', { summary: 'Fix "login", then\nship', labels: ['Must-Have'] }),
  ];
  const lines = (await readBoard({ project: 'HB' }, deps(oneSearch(issues)))).csv;
  assert.ok(lines.includes(`HB-1,"'=HYPERLINK(""http://x"")",3,`));
  assert.ok(lines.includes('HB-2,"Fix ""login"", then\nship",3,5,3,2,,yes,'));
});

test('Blocks links: "is blocked by" becomes Depends On; links to issues not on the board are dropped with a warning', async () => {
  const blocks = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
  const issues = [
    issue('HB-1', { issuelinks: [{ type: blocks, outwardIssue: { key: 'HB-2' } }] }),
    issue('HB-2', { issuelinks: [{ type: blocks, inwardIssue: { key: 'HB-1' } }, { type: blocks, inwardIssue: { key: 'HB-99' } }, { type: { name: 'Relates' }, inwardIssue: { key: 'HB-1' } }] }),
  ];
  const { csv, warnings } = await readBoard({ project: 'HB' }, deps(oneSearch(issues)));
  const rows = csv.split('\r\n');
  assert.equal(rows[1].split(',')[8], '');
  assert.equal(rows[2].split(',')[8], 'HB-1');
  assert.deepEqual(warnings.map((w) => [w.code, w.key, w.target]), [['link-dropped', 'HB-2', 'HB-99']]);
});

test('numbers that are not whole are passed on, so the importer names them', async () => {
  const { csv } = await readBoard({ project: 'HB' }, deps(oneSearch([issue('HB-1', { customfield_10016: 2.5 })])));
  assert.equal(csv.split('\r\n')[1].split(',')[2], '2.5');
});
