#!/usr/bin/env node
// Creates the 19 Deadline Séance sample tickets (scripts/sample-board.csv) as Stories in an EMPTY Jira Cloud project,
// with story points, Value, Urgency, Risk, Times Postponed (and Cost of Delay), the label must-have and Blocks links.
//
//   node scripts/seed-jira.mjs                 dry run: read-only checks, prints the plan, creates nothing
//   node scripts/seed-jira.mjs --yes           creates the issues and links
//   node scripts/seed-jira.mjs --project KEY   another project key (default HB)
//   node scripts/seed-jira.mjs --links-only    only the 5 Blocks links, between sample issues that already exist (dry run)
//   node scripts/seed-jira.mjs --links-only --yes   creates the missing links
//
// Credentials: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN from the environment. They are never printed.
// It writes to Jira only with --yes. It never deletes or edits anything.

import { pathToFileURL } from 'node:url';
import { BoardError, FIELD_NAMES, validateInput } from '../mcp/jira-board/board.mjs';
import { sampleTickets } from './sample-board.mjs';

const TIMEOUT_MS = 20_000;

function config(env) {
  const names = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
  const missing = names.filter((n) => !env[n] || env[n].trim() === '');
  if (missing.length) throw new BoardError('missing-config', `Set ${missing.join(', ')}.`);
  let url;
  try {
    url = new URL(env.JIRA_BASE_URL.trim());
  } catch {
    throw new BoardError('bad-config', 'JIRA_BASE_URL is not a URL.');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.atlassian.net')) throw new BoardError('bad-config', 'JIRA_BASE_URL must be https://<site>.atlassian.net.');
  return { origin: url.origin, auth: `Basic ${Buffer.from(`${env.JIRA_EMAIL.trim()}:${env.JIRA_API_TOKEN.trim()}`).toString('base64')}` };
}

function client(cfg, fetchImpl) {
  return async (method, path, body) => {
    let r;
    try {
      r = await fetchImpl(`${cfg.origin}${path}`, {
        method,
        headers: { Accept: 'application/json', Authorization: cfg.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new BoardError('network', `Could not reach Jira (${method} ${path.split('?')[0]}).`);
    }
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) {
      // Jira's own error messages name fields ("Field 'customfield_10016' cannot be set"), which helps; they hold no credential.
      const detail = data ? [...(data.errorMessages ?? []), ...Object.entries(data.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ') : '';
      throw new BoardError('http-error', `${method} ${path.split('?')[0]} answered HTTP ${r.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return data;
  };
}

/** The create body of one ticket. Empty numbers are left out. */
export function issueBody(project, t, ids) {
  const fields = { project: { key: project }, issuetype: { name: 'Story' }, summary: t.summary, labels: t.mustHave ? ['must-have'] : [] };
  const set = (meaning, value) => {
    if (value !== null && value !== undefined) fields[ids[meaning]] = value;
  };
  set('points', t.points);
  set('value', t.value);
  set('urgency', t.urgency);
  set('risk', t.risk);
  set('past', t.past);
  if (t.cod !== null) set('cod', t.cod);
  return { fields };
}

/** The Blocks links: each "A depends on B" is "B blocks A". */
export function plannedLinks(tickets) {
  return tickets.flatMap((t) => t.dependsOn.map((dep) => ({ blocker: dep, blocked: t.sampleKey })));
}

export async function seed({ env = process.env, fetch: fetchImpl = globalThis.fetch, yes = false, project = 'HB', log = console.log } = {}) {
  validateInput({ project });
  const jira = client(config(env), fetchImpl);
  const tickets = sampleTickets();

  // ---- read-only checks ----
  await jira('GET', `/rest/api/3/project/${encodeURIComponent(project)}`);
  const list = await jira('GET', '/rest/api/3/field');
  const ids = {};
  const missing = [];
  for (const [meaning, name] of Object.entries(FIELD_NAMES)) {
    const found = list.filter((f) => typeof f?.name === 'string' && f.name.trim().toLowerCase() === name.toLowerCase());
    if (found.length > 1) throw new BoardError('ambiguous-field', `Jira has ${found.length} fields named "${name}".`);
    if (found.length === 1) ids[meaning] = found[0].id;
    else missing.push(name);
  }
  const needsCod = tickets.some((t) => t.cod !== null);
  const blocking = missing.filter((n) => n !== FIELD_NAMES.cod || needsCod);
  if (blocking.length) {
    throw new BoardError('missing-field', `Create these number fields first: ${blocking.map((n) => `"${n}"`).join(', ')}` + (missing.includes(FIELD_NAMES.cod) && needsCod ? ` (Cost of Delay: ${tickets.filter((t) => t.cod !== null).map((t) => t.sampleKey).join(', ')} has a cost of delay and no Value, Urgency, Risk).` : '.'));
  }
  const any = await jira('POST', '/rest/api/3/search/jql', { jql: `project = "${project}"`, fields: ['summary'], maxResults: 1 });
  if ((any?.issues?.length ?? 0) > 0) {
    throw new BoardError('not-empty', `The project ${project} already has issues. The seed only runs on an empty project, so nothing is created twice.`);
  }

  const links = plannedLinks(tickets);
  log(`Plan for ${project}: ${tickets.length} Stories, ${links.length} Blocks links. Fields: ${Object.values(FIELD_NAMES).filter((n) => !missing.includes(n)).join(', ')}.`);
  if (!yes) {
    log('Dry run: nothing was created. Run again with --yes to create them.');
    return { created: [], links: [] };
  }

  // ---- writes ----
  const keyOf = new Map();
  for (const t of tickets) {
    const r = await jira('POST', '/rest/api/3/issue', issueBody(project, t, ids));
    keyOf.set(t.sampleKey, r.key);
    log(`created ${r.key} (${t.sampleKey}) ${t.summary}`);
  }
  const made = [];
  for (const [i, link] of links.entries()) {
    const blocker = keyOf.get(link.blocker);
    const blocked = keyOf.get(link.blocked);
    await jira('POST', '/rest/api/3/issueLink', linkBody(blocker, blocked));
    made.push(`${blocker} blocks ${blocked}`);
    if (i === 0) await checkDirection(jira, blocker, blocked);
    log(`linked ${blocker} blocks ${blocked}`);
  }
  log(`Done: ${keyOf.size} issues, ${made.length} links.`);
  return { created: [...keyOf.values()], links: made };
}

/**
 * The POST /issueLink body for "blocked is blocked by blocker". Jira reads the ends the other way round from what the names suggest:
 * inwardIssue is the blocker, outwardIssue is the issue that is blocked. Pinned by a test, checked live by checkDirection.
 */
export function linkBody(blocker, blocked) {
  return { type: { name: 'Blocks' }, inwardIssue: { key: blocker }, outwardIssue: { key: blocked } };
}

/** Reads the blocked issue back, the way jira-board does: its own issuelinks must hold the blocker as inwardIssue ("is blocked by"). */
async function checkDirection(jira, blocker, blocked) {
  const r = await jira('GET', `/rest/api/3/issue/${encodeURIComponent(blocked)}?fields=issuelinks`);
  const ok = (r?.fields?.issuelinks ?? []).some((l) => isBlocks(l) && l.inwardIssue?.key === blocker);
  if (!ok) {
    throw new BoardError('link-direction', `The first link came out reversed: open ${blocked} and make it "is blocked by ${blocker}". The other links were not created.`);
  }
}

const isBlocks = (l) => typeof l?.type?.name === 'string' && l.type.name.trim().toLowerCase() === 'blocks';

/** Every issue of the project (key, summary, issuelinks), following nextPageToken. Read-only. */
async function readProject(jira, project) {
  const issues = [];
  const seen = new Set();
  let token;
  for (let page = 0; ; page++) {
    if (page >= 10) throw new BoardError('too-many-pages', 'The search did not end after 10 pages.');
    const data = await jira('POST', '/rest/api/3/search/jql', { jql: `project = "${project}" ORDER BY key ASC`, fields: ['summary', 'issuelinks'], maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
    if (!data || !Array.isArray(data.issues)) throw new BoardError('bad-response', 'Jira sent an unexpected search result.');
    for (const i of data.issues) if (typeof i?.key === 'string' && !seen.has(i.key)) { seen.add(i.key); issues.push(i); }
    const next = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : undefined;
    if (data.isLast === true || next === undefined) break;
    if (next === token) throw new BoardError('pagination-loop', 'Jira sent the same page token twice.');
    token = next;
  }
  return issues;
}

/**
 * Only the missing Blocks links, between sample issues that already exist. The sample keys are mapped to the existing keys by summary
 * (refused if one is missing or found twice). Dry run unless yes. It never deletes or edits. A Blocks link that already runs the wrong way
 * between two planned issues is named and nothing is created.
 */
export async function linksOnly({ env = process.env, fetch: fetchImpl = globalThis.fetch, yes = false, project = 'HB', log = console.log } = {}) {
  validateInput({ project });
  const jira = client(config(env), fetchImpl);
  const tickets = sampleTickets();

  await jira('GET', `/rest/api/3/project/${encodeURIComponent(project)}`);
  const issues = await readProject(jira, project);

  // sample key -> existing key, by summary
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const problems = [];
  const sampleSummaries = new Map();
  for (const t of tickets) sampleSummaries.set(norm(t.summary), [...(sampleSummaries.get(norm(t.summary)) ?? []), t.sampleKey]);
  const keyOf = new Map();
  for (const t of tickets) {
    if (sampleSummaries.get(norm(t.summary)).length > 1) problems.push(`${t.sampleKey} has the same summary as another sample ticket`);
    const hits = issues.filter((i) => norm(i.fields?.summary) === norm(t.summary));
    if (hits.length === 0) problems.push(`${t.sampleKey} "${t.summary}" is not in ${project}`);
    else if (hits.length > 1) problems.push(`${t.sampleKey} "${t.summary}" is in ${project} ${hits.length} times (${hits.map((h) => h.key).join(', ')})`);
    else keyOf.set(t.sampleKey, hits[0].key);
  }
  if (problems.length) throw new BoardError('summary-map', `Cannot map the sample to ${project} by summary: ${problems.join('; ')}.`);

  // existing Blocks edges, as "blocker -> blocked", read from the issues themselves (both ends)
  const mapped = new Set(keyOf.values());
  const existing = new Set();
  for (const i of issues) {
    if (!mapped.has(i.key)) continue;
    for (const l of i.fields?.issuelinks ?? []) {
      if (!isBlocks(l)) continue;
      if (l.inwardIssue?.key) existing.add(`${l.inwardIssue.key}>${i.key}`); // i is blocked by inward
      if (l.outwardIssue?.key) existing.add(`${i.key}>${l.outwardIssue.key}`); // i blocks outward
    }
  }

  const planned = plannedLinks(tickets).map((l) => ({ blocker: keyOf.get(l.blocker), blocked: keyOf.get(l.blocked) }));
  const reversed = planned.filter((l) => !existing.has(`${l.blocker}>${l.blocked}`) && existing.has(`${l.blocked}>${l.blocker}`));
  if (reversed.length) {
    throw new BoardError('link-direction', `A Blocks link runs the wrong way: ${reversed.map((l) => `${l.blocked} blocks ${l.blocker}, but it should be "${l.blocked} is blocked by ${l.blocker}"`).join('; ')}. Nothing was created. Remove it by hand and run again.`);
  }
  const missing = planned.filter((l) => !existing.has(`${l.blocker}>${l.blocked}`));
  const have = planned.length - missing.length;
  log(`Links for ${project}: ${planned.length} planned, ${have} already there, ${missing.length} to create.`);
  for (const l of missing) log(`  ${l.blocked} is blocked by ${l.blocker}`);
  if (!yes || missing.length === 0) {
    log(missing.length === 0 ? 'Nothing to do.' : 'Dry run: nothing was created. Run again with --yes to create them.');
    return { links: [] };
  }

  const made = [];
  for (const [i, l] of missing.entries()) {
    await jira('POST', '/rest/api/3/issueLink', linkBody(l.blocker, l.blocked));
    made.push(`${l.blocker} blocks ${l.blocked}`);
    if (i === 0) await checkDirection(jira, l.blocker, l.blocked);
    log(`linked ${l.blocker} blocks ${l.blocked}`);
  }
  log(`Done: ${made.length} links.`);
  return { links: made };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const p = argv.indexOf('--project');
  (argv.includes('--links-only') ? linksOnly : seed)({ yes: argv.includes('--yes'), project: p >= 0 ? argv[p + 1] : 'HB' }).catch((error) => {
    console.error(error instanceof BoardError ? `${error.code}: ${error.message}` : 'seed-jira failed unexpectedly.');
    process.exit(1);
  });
}
