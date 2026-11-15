// scripts/seed-jira.mjs against a recorded, empty HB project. No real Jira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError } from '../mcp/jira-board/board.mjs';
import { issuesToCsv, resolveFields } from '../mcp/jira-board/board.mjs';
import { linkBody, linksOnly, seed } from '../scripts/seed-jira.mjs';
import { sampleTickets } from '../scripts/sample-board.mjs';
import { FAKE_ENV, assertNoSecret, fakeFetch, fixture, issue, json } from './helpers.mjs';

function emptyProject({ fields = fixture('fields.json'), issues = [], reversed = false } = {}) {
  let n = 0;
  const links = [];
  const fetch = fakeFetch({
    'GET /rest/api/3/project/HB': () => json(200, { key: 'HB' }),
    'GET /rest/api/3/field': () => json(200, fields),
    'POST /rest/api/3/search/jql': () => json(200, { issues, isLast: true }),
    'POST /rest/api/3/issue': () => json(201, { id: String(10000 + ++n), key: `HB-${n}` }),
    'POST /rest/api/3/issueLink': (body) => {
      links.push(body);
      return new Response(null, { status: 201 });
    },
  });
  const inner = fetch;
  const wrapped = async (url, init) => {
    const u = new URL(url);
    if ((init?.method ?? 'GET') === 'GET' && u.pathname.startsWith('/rest/api/3/issue/')) {
      const key = decodeURIComponent(u.pathname.split('/').pop());
      // Jira: inwardIssue is the blocker, outwardIssue the blocked issue. The blocked one then lists the blocker as inwardIssue.
      const l = links.find((x) => x.outwardIssue.key === key);
      const end = reversed ? { outwardIssue: { key: l.inwardIssue.key } } : { inwardIssue: { key: l.inwardIssue.key } };
      return json(200, { key, fields: { issuelinks: [{ type: { name: 'Blocks' }, ...end }] } });
    }
    return inner(url, init);
  };
  wrapped.calls = inner.calls;
  wrapped.links = links;
  return wrapped;
}

const quiet = () => {};

test('a dry run only reads', async () => {
  const fetch = emptyProject();
  const lines = [];
  await seed({ env: FAKE_ENV, fetch, log: (l) => lines.push(l) });
  assert.ok(fetch.calls.every((c) => c.method === 'GET' || c.path === '/rest/api/3/search/jql'));
  assert.match(lines.join('\n'), /19 Stories, 5 Blocks links/);
  assert.match(lines.join('\n'), /Dry run/);
});

test('--yes creates 19 Stories with the numbers, the label and the links', async (t) => {
  const fetch = emptyProject();
  const lines = [];
  const result = await seed({ env: FAKE_ENV, fetch, yes: true, log: (l) => lines.push(l) });
  assert.equal(result.created.length, 19);
  const bodies = fetch.calls.filter((c) => c.path === '/rest/api/3/issue').map((c) => c.body.fields);
  assert.deepEqual(bodies[0], {
    project: { key: 'HB' },
    issuetype: { name: 'Story' },
    summary: 'Fix stale balance after a transfer',
    labels: ['must-have'],
    customfield_10016: 5,
    customfield_10101: 8,
    customfield_10102: 5,
    customfield_10103: 5,
    customfield_10104: 0,
  });
  const savings = bodies[10]; // HB-111 in the sample: a cost of delay, no Value/Urgency/Risk
  assert.equal(savings.customfield_10105, 14);
  assert.equal(savings.customfield_10101, undefined);
  // HB-106 depends on HB-104: HB-6 is blocked by HB-4. Jira's inwardIssue is the blocker, outwardIssue the blocked issue.
  assert.deepEqual(fetch.links[0], { type: { name: 'Blocks' }, inwardIssue: { key: 'HB-4' }, outwardIssue: { key: 'HB-6' } });
  assert.equal(fetch.links.length, 5);
  assertNoSecret(t, lines.join('\n'));
});

test('without a Cost of Delay field it stops before writing (HB-111 needs it)', async () => {
  const fetch = emptyProject({ fields: fixture('fields.json').filter((f) => f.name !== 'Cost of Delay') });
  await assert.rejects(seed({ env: FAKE_ENV, fetch, yes: true, log: quiet }), (e) => e instanceof BoardError && e.code === 'missing-field' && /Cost of Delay/.test(e.message) && /HB-111/.test(e.message));
  assert.ok(!fetch.calls.some((c) => c.path === '/rest/api/3/issue'));
});

test('a project that already has issues is refused', async () => {
  const fetch = emptyProject({ issues: [{ key: 'HB-1' }] });
  await assert.rejects(seed({ env: FAKE_ENV, fetch, yes: true, log: quiet }), (e) => e.code === 'not-empty');
  assert.ok(!fetch.calls.some((c) => c.path === '/rest/api/3/issue'));
});

test('a reversed first link stops the links', async () => {
  const fetch = emptyProject({ reversed: true });
  await assert.rejects(seed({ env: FAKE_ENV, fetch, yes: true, log: quiet }), (e) => e.code === 'link-direction');
  assert.equal(fetch.links.length, 1);
});

// ---- direction, pinned ----

const BLOCKS = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };

test('linkBody: "A is blocked by B" sends B as inwardIssue and A as outwardIssue, and jira-board reads B in A\'s Depends On', () => {
  // A depends on B (A needs B).
  assert.deepEqual(linkBody('HB-2', 'HB-1'), { type: { name: 'Blocks' }, inwardIssue: { key: 'HB-2' }, outwardIssue: { key: 'HB-1' } });
  const body = linkBody('HB-2', 'HB-1'); // blocker HB-2, blocked HB-1
  // What Jira stores for that body, in the shape of tests/fixtures/make-fixtures.mjs: the blocked issue holds the blocker as inwardIssue, the blocker holds the blocked issue as outwardIssue.
  const issues = [
    issue('HB-1', { issuelinks: [{ type: BLOCKS, inwardIssue: { key: body.inwardIssue.key } }] }),
    issue('HB-2', { issuelinks: [{ type: BLOCKS, outwardIssue: { key: body.outwardIssue.key } }] }),
  ];
  const rows = issuesToCsv(issues, resolveFields(fixture('fields.json'))).csv.split('\r\n');
  assert.equal(rows[1].split(',')[8], 'HB-2'); // HB-1 depends on HB-2
  assert.equal(rows[2].split(',')[8], '');
});

test('the seed sends the first sample dependency in that direction', async () => {
  const fetch = emptyProject();
  await seed({ env: FAKE_ENV, fetch, yes: true, log: quiet });
  const [first] = sampleTickets().flatMap((t) => t.dependsOnJira.map((dep) => ({ blocked: t.jiraKey, blocker: dep })));
  assert.deepEqual(fetch.calls.find((c) => c.path === '/rest/api/3/issueLink').body, linkBody(first.blocker, first.blocked));
});

// ---- --links-only ----

/** HB-1..HB-19 already exist with the sample summaries. `links` is a list of [blocker, blocked] already stored, in either direction. */
function existingProject({ links = [], mutate = (list) => list } = {}) {
  const tickets = sampleTickets();
  const stored = [...links];
  const issues = () =>
    mutate(tickets.map((t) => ({ key: t.jiraKey, fields: { summary: t.summary, issuelinks: [] } }))).map((i) => ({
      ...i,
      fields: {
        ...i.fields,
        issuelinks: stored.flatMap(([blocker, blocked]) => [
          ...(blocked === i.key ? [{ type: BLOCKS, inwardIssue: { key: blocker } }] : []),
          ...(blocker === i.key ? [{ type: BLOCKS, outwardIssue: { key: blocked } }] : []),
        ]),
      },
    }));
  const posted = [];
  const fetch = fakeFetch({
    'GET /rest/api/3/project/HB': () => json(200, { key: 'HB' }),
    'POST /rest/api/3/search/jql': () => json(200, { issues: issues(), isLast: true }),
    'POST /rest/api/3/issueLink': (body) => {
      posted.push(body);
      stored.push([body.inwardIssue.key, body.outwardIssue.key]);
      return new Response(null, { status: 201 });
    },
  });
  const wrapped = async (url, init) => {
    const u = new URL(url);
    if ((init?.method ?? 'GET') === 'GET' && u.pathname.startsWith('/rest/api/3/issue/')) {
      const key = decodeURIComponent(u.pathname.split('/').pop());
      return json(200, { key, fields: { issuelinks: issues().find((i) => i.key === key).fields.issuelinks } });
    }
    return fetch(url, init);
  };
  wrapped.calls = fetch.calls;
  wrapped.posted = posted;
  return wrapped;
}

const writes = (fetch) => fetch.calls.filter((c) => c.method !== 'GET' && c.path !== '/rest/api/3/search/jql');

test('--links-only dry run: lists the 5 missing links and writes nothing', async () => {
  const fetch = existingProject();
  const lines = [];
  await linksOnly({ env: FAKE_ENV, fetch, log: (l) => lines.push(l) });
  assert.equal(writes(fetch).length, 0);
  assert.match(lines.join('\n'), /5 planned, 0 already there, 5 to create/);
  assert.match(lines.join('\n'), /HB-6 is blocked by HB-4/);
  assert.match(lines.join('\n'), /Dry run/);
});

test('--links-only --yes creates all 5 in the right direction and no Story', async (t) => {
  const fetch = existingProject();
  const lines = [];
  const r = await linksOnly({ env: FAKE_ENV, fetch, yes: true, log: (l) => lines.push(l) });
  assert.equal(r.links.length, 5);
  assert.equal(fetch.posted.length, 5);
  assert.deepEqual(fetch.posted[0], linkBody('HB-4', 'HB-6'));
  assert.ok(fetch.calls.every((c) => c.method === 'GET' || c.path === '/rest/api/3/search/jql' || c.path === '/rest/api/3/issueLink'));
  assertNoSecret(t, lines.join('\n'));
});

test('--links-only creates only the links that are missing, and never twice', async () => {
  const fetch = existingProject({ links: [['HB-4', 'HB-6']] });
  const lines = [];
  await linksOnly({ env: FAKE_ENV, fetch, yes: true, log: (l) => lines.push(l) });
  assert.equal(fetch.posted.length, 4);
  assert.match(lines.join('\n'), /5 planned, 1 already there, 4 to create/);
  const again = existingProject({ links: [['HB-4', 'HB-6']] });
  const second = await linksOnly({ env: FAKE_ENV, fetch: again, yes: true, log: quiet });
  assert.equal(second.links.length, 4);
  const done = existingProject({ links: sampleTickets().flatMap((t) => t.dependsOnJira.map((d) => [d, t.jiraKey])) });
  const nothing = await linksOnly({ env: FAKE_ENV, fetch: done, yes: true, log: quiet });
  assert.equal(nothing.links.length, 0);
  assert.equal(done.posted.length, 0);
});

test('--links-only: a Blocks link in the wrong direction is named and nothing is created', async () => {
  const fetch = existingProject({ links: [['HB-6', 'HB-4']] }); // HB-6 blocks HB-4: reversed (HB-6 should be blocked by HB-4)
  await assert.rejects(linksOnly({ env: FAKE_ENV, fetch, yes: true, log: quiet }), (e) => e instanceof BoardError && e.code === 'link-direction' && /HB-6 blocks HB-4, but it should be "HB-6 is blocked by HB-4"/.test(e.message) && /Nothing was created/.test(e.message));
  assert.equal(fetch.posted.length, 0);
});

test('--links-only: a missing or duplicated summary is refused and nothing is created', async () => {
  const missing = existingProject({ mutate: (list) => list.slice(1) });
  await assert.rejects(linksOnly({ env: FAKE_ENV, fetch: missing, yes: true, log: quiet }), (e) => e.code === 'summary-map' && /is not in HB/.test(e.message));
  assert.equal(missing.posted.length, 0);
  const twice = existingProject({ mutate: (list) => [...list, { key: 'HB-20', fields: { summary: list[0].fields.summary, issuelinks: [] } }] });
  await assert.rejects(linksOnly({ env: FAKE_ENV, fetch: twice, yes: true, log: quiet }), (e) => e.code === 'summary-map' && /2 times \(HB-1, HB-20\)/.test(e.message));
  assert.equal(twice.posted.length, 0);
});

test('--links-only works on a project that is not empty and does not check the number fields', async () => {
  const fetch = existingProject();
  await linksOnly({ env: FAKE_ENV, fetch, log: quiet });
  assert.ok(!fetch.calls.some((c) => c.path === '/rest/api/3/field'));
});
