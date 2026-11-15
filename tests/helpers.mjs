import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8'));

/** Invented values. None of them is a real site, account or token. */
export const FAKE_ENV = Object.freeze({
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'nobody@example.invalid',
  JIRA_API_TOKEN: 'test-not-a-secret-0123456789',
});

/** Every string that must never show up in an output. */
export const SECRETS = [FAKE_ENV.JIRA_EMAIL, FAKE_ENV.JIRA_API_TOKEN, 'example.atlassian.net', Buffer.from(`${FAKE_ENV.JIRA_EMAIL}:${FAKE_ENV.JIRA_API_TOKEN}`).toString('base64')];

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A fetch that answers from recorded responses. `routes` maps "METHOD path" to a function (body, call) -> Response.
 * Every call is kept in `calls`; an unknown route fails the test loudly.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, path: u.pathname, origin: u.origin, headers: init.headers ?? {}, body };
    calls.push(call);
    const route = routes[`${method} ${u.pathname}`];
    if (!route) throw new Error(`unexpected request ${method} ${u.pathname}`);
    return route(body, call, calls);
  };
  fn.calls = calls;
  return fn;
}

/** The recorded HB project: fields, then two search pages. */
export function recordedJira(overrides = {}) {
  return fakeFetch({
    'GET /rest/api/3/field': () => json(200, fixture('fields.json')),
    'POST /rest/api/3/search/jql': (body) => json(200, body.nextPageToken ? fixture('search-page-2.json') : fixture('search-page-1.json')),
    ...overrides,
  });
}

/** One issue in the shape the search returns, with the fixture's field ids. */
export function issue(key, fields = {}) {
  return {
    id: '1',
    key,
    fields: {
      summary: `Ticket ${key}`,
      labels: [],
      issuelinks: [],
      fixVersions: [],
      customfield_10016: 3,
      customfield_10101: 5,
      customfield_10102: 3,
      customfield_10103: 2,
      customfield_10104: 0,
      customfield_10105: null,
      ...fields,
    },
  };
}

export function oneSearch(issues) {
  return recordedJira({ 'POST /rest/api/3/search/jql': () => json(200, { issues, isLast: true }) });
}

export function assertNoSecret(t, text) {
  for (const s of SECRETS) if (String(text).includes(s)) t.assert.fail(`output contains a secret-like string (${s.length} chars)`);
}
