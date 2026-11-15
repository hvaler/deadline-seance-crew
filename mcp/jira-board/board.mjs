// Reads the open issues of one Jira Cloud project and writes them as the CSV Deadline Séance imports.
// Read-only: two kinds of request, GET /rest/api/3/field and POST /rest/api/3/search/jql (a search, it changes nothing).
//
// Secrets: the three JIRA_* variables are read here and only here. Their values never go into a result, an error or a log line.
// Personal data: only summary, labels, links, fix versions and the number fields are requested; no people fields.

import { HEADERS, guardCell, serializeCsv } from './csv.mjs';

export const ENV_NAMES = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];

/** Jira field names, matched by name through GET /rest/api/3/field (case and spaces ignored). */
export const FIELD_NAMES = {
  points: 'Story point estimate',
  value: 'Value',
  urgency: 'Urgency',
  risk: 'Risk',
  past: 'Times Postponed',
  cod: 'Cost of Delay',
};
const REQUIRED_FIELDS = ['points', 'value', 'urgency', 'risk', 'past'];

/** The importer's limit on open tickets (CSV_LIMITS.tickets in Deadline Séance). */
export const MAX_ISSUES = 60;
export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
const TIMEOUT_MS = 20_000;

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Present or absent and the length of each variable. Never the value. */
export function checkEnv(env) {
  return Object.fromEntries(ENV_NAMES.map((name) => {
    const v = env[name];
    return [name, { present: typeof v === 'string' && v !== '', length: typeof v === 'string' ? v.length : 0 }];
  }));
}

function readConfig(env) {
  const missing = ENV_NAMES.filter((n) => typeof env[n] !== 'string' || env[n].trim() === '');
  if (missing.length > 0) throw new BoardError('missing-config', `Set ${missing.join(', ')} in the environment Crew starts this server with.`);
  let url;
  try {
    url = new URL(env.JIRA_BASE_URL.trim());
  } catch {
    throw new BoardError('bad-config', 'JIRA_BASE_URL is not a URL. It should look like https://<site>.atlassian.net');
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.atlassian.net') || url.username !== '' || url.password !== '') {
    throw new BoardError('bad-config', 'JIRA_BASE_URL must be https://<site>.atlassian.net (Jira Cloud only).');
  }
  const auth = `Basic ${Buffer.from(`${env.JIRA_EMAIL.trim()}:${env.JIRA_API_TOKEN.trim()}`).toString('base64')}`;
  return { origin: url.origin, auth };
}

const STATUS_TEXT = {
  400: ['bad-request', 'Jira did not accept the search (HTTP 400). Check the project key and the fix version.'],
  401: ['auth', 'Jira refused the credentials (HTTP 401). Check JIRA_EMAIL and JIRA_API_TOKEN.'],
  403: ['forbidden', 'The Jira user may not browse this project (HTTP 403).'],
  404: ['not-found', 'Jira did not find the project or the endpoint (HTTP 404).'],
  429: ['rate-limited', 'Jira is limiting requests (HTTP 429). Try again in a minute.'],
};

async function call(cfg, fetchImpl, path, init = {}) {
  let response;
  try {
    response = await fetchImpl(`${cfg.origin}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Authorization: cfg.auth, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    // The error text of fetch can carry the URL; it is not passed on.
    throw new BoardError('network', 'Could not reach Jira.');
  }
  if (!response.ok) {
    const [code, message] = STATUS_TEXT[response.status] ?? ['http-error', `Jira answered HTTP ${response.status}.`];
    throw new BoardError(code, message);
  }
  try {
    return await response.json();
  } catch {
    throw new BoardError('bad-response', 'Jira sent a response that is not JSON.');
  }
}

const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

/** Field ids by meaning, from the list GET /rest/api/3/field returns. */
export function resolveFields(list) {
  if (!Array.isArray(list)) throw new BoardError('bad-response', 'Jira sent an unexpected field list.');
  const ids = {};
  const missing = [];
  for (const [meaning, name] of Object.entries(FIELD_NAMES)) {
    const found = list.filter((f) => f && typeof f.name === 'string' && norm(f.name) === norm(name));
    if (found.length > 1) throw new BoardError('ambiguous-field', `Jira has ${found.length} fields named "${name}" (${found.map((f) => f.id).join(', ')}). Rename all but one.`);
    if (found.length === 1) ids[meaning] = found[0].id;
    else if (REQUIRED_FIELDS.includes(meaning)) missing.push(name);
  }
  if (missing.length > 0) throw new BoardError('missing-field', `Jira has no field named ${missing.map((n) => `"${n}"`).join(', ')}.`);
  return ids;
}

export function validateInput(input) {
  const args = input ?? {};
  if (typeof args.project !== 'string' || !/^[A-Z][A-Z0-9_]{1,9}$/.test(args.project)) {
    throw new BoardError('bad-input', 'project must be a Jira project key such as HB (capital letters, digits, underscore).');
  }
  if (args.fixVersion !== undefined) {
    if (typeof args.fixVersion !== 'string' || args.fixVersion.trim() === '' || args.fixVersion.length > 100 || /[\u0000-\u001f]/.test(args.fixVersion)) {
      throw new BoardError('bad-input', 'fixVersion must be a version name of 1 to 100 characters.');
    }
  }
  return { project: args.project, fixVersion: args.fixVersion?.trim() };
}

const jqlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Open means "not in the Done status category": team-managed projects often leave the resolution empty on Done. */
export function buildJql({ project, fixVersion }) {
  let jql = `project = ${jqlString(project)} AND statusCategory != Done`;
  if (fixVersion !== undefined) jql += ` AND fixVersion = ${jqlString(fixVersion)}`;
  return `${jql} ORDER BY key ASC`;
}

function numberCell(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value); // not a number: the importer names it
}

/** The CSV rows for a list of Jira issues. Links to issues outside the list are dropped, with a warning. */
export function issuesToCsv(issues, ids) {
  const keys = new Set(issues.map((i) => i.key));
  const warnings = [];
  const rows = issues.map((issue) => {
    const f = issue.fields ?? {};
    const deps = new Set();
    for (const link of Array.isArray(f.issuelinks) ? f.issuelinks : []) {
      if (norm(link?.type?.name ?? '') !== 'blocks') continue;
      const target = link.inwardIssue?.key; // on this issue, an inward Blocks link means "this is blocked by target"
      if (typeof target !== 'string') continue;
      if (keys.has(target)) deps.add(target);
      else warnings.push({ code: 'link-dropped', key: issue.key, target, message: `${issue.key} is blocked by ${target}, which is done or not in this project; the link was left out.` });
    }
    const labels = Array.isArray(f.labels) ? f.labels.map(norm) : [];
    const versions = Array.isArray(f.fixVersions) ? f.fixVersions.map((v) => v?.name).filter((n) => typeof n === 'string') : [];
    const points = numberCell(f[ids.points]);
    if (points === '') warnings.push({ code: 'missing-points', key: issue.key, message: `${issue.key} has no Story point estimate.` });
    return [
      guardCell(issue.key),
      guardCell(typeof f.summary === 'string' ? f.summary : ''),
      points,
      numberCell(f[ids.value]),
      numberCell(f[ids.urgency]),
      numberCell(f[ids.risk]),
      ids.cod ? numberCell(f[ids.cod]) : '',
      labels.includes('must-have') ? 'yes' : 'no',
      guardCell([...deps].sort().join(';')),
      numberCell(f[ids.past]),
      guardCell(versions.join(';')),
      '',
    ];
  });
  return { csv: serializeCsv([HEADERS, ...rows]), warnings };
}

/**
 * A setup check with two read-only requests: GET the project (only the HTTP status is kept) and GET /rest/api/3/field (only whether each
 * needed name exists). Returns no value from Jira beyond that.
 */
export async function checkSetup(input, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const { project } = validateInput(input);
  const cfg = readConfig(env);
  let projectStatus;
  try {
    const r = await fetchImpl(`${cfg.origin}/rest/api/3/project/${encodeURIComponent(project)}`, {
      headers: { Accept: 'application/json', Authorization: cfg.auth },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    projectStatus = r.status;
    await r.body?.cancel?.();
  } catch {
    projectStatus = null;
  }
  let fields = null;
  let fieldsError = null;
  try {
    const list = await call(cfg, fetchImpl, '/rest/api/3/field');
    if (!Array.isArray(list)) throw new BoardError('bad-response', 'Jira sent an unexpected field list.');
    fields = Object.fromEntries(Object.values(FIELD_NAMES).map((name) => [name, list.filter((f) => f && typeof f.name === 'string' && norm(f.name) === norm(name)).length]));
  } catch (error) {
    fieldsError = error instanceof BoardError ? error.code : 'internal';
  }
  return { project: { key: project, httpStatus: projectStatus }, fields, fieldsError, required: REQUIRED_FIELDS.map((m) => FIELD_NAMES[m]) };
}

/** The whole tool: fields, then every page of the search, then the CSV. */
export async function readBoard(input, { env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
  const args = validateInput(input);
  const cfg = readConfig(env);
  const ids = resolveFields(await call(cfg, fetchImpl, '/rest/api/3/field'));
  const fields = ['summary', 'labels', 'issuelinks', 'fixVersions', ...Object.values(ids)];
  const jql = buildJql(args);
  const issues = [];
  const seen = new Set();
  let token;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new BoardError('too-many-pages', `The search did not end after ${MAX_PAGES} pages.`);
    const body = { jql, fields, maxResults: PAGE_SIZE, ...(token ? { nextPageToken: token } : {}) };
    const data = await call(cfg, fetchImpl, '/rest/api/3/search/jql', { method: 'POST', body: JSON.stringify(body) });
    if (!data || !Array.isArray(data.issues)) throw new BoardError('bad-response', 'Jira sent an unexpected search result.');
    for (const issue of data.issues) {
      if (typeof issue?.key !== 'string' || seen.has(issue.key)) continue;
      seen.add(issue.key);
      issues.push(issue);
    }
    if (issues.length > MAX_ISSUES) throw new BoardError('too-many-issues', `The project has more than ${MAX_ISSUES} open issues; Deadline Séance reads at most ${MAX_ISSUES}. Use fixVersion to narrow it.`);
    const next = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : undefined;
    if (data.isLast === true || next === undefined) break;
    if (next === token) throw new BoardError('pagination-loop', 'Jira sent the same page token twice.');
    token = next;
  }
  if (issues.length === 0) throw new BoardError('no-issues', `The project ${args.project} has no open issues${args.fixVersion ? ' with that fix version' : ''}.`);
  const { csv, warnings } = issuesToCsv(issues, ids);
  return { csv, issueCount: issues.length, warnings };
}
