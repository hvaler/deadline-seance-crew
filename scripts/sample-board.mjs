// The 19 sample tickets of Deadline Séance (scripts/sample-board.csv, copied from its docs/examples/sample-board.csv),
// read into plain objects. Used by seed-jira.mjs and by the tests.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_CSV_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sample-board.csv');

/** RFC 4180 reader for a comma file. Enough for the sample; the real importer is Deadline Séance's. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const num = (s) => (s.trim() === '' ? null : Number(s));

/** Each sample row, with the key Jira will give it in an empty project (HB-101 -> HB-1, in file order). */
export function sampleTickets(text = readFileSync(SAMPLE_CSV_PATH, 'utf8')) {
  const [header, ...rows] = parseCsv(text);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`sample-board.csv has no column ${name}`);
    return i;
  };
  const c = {
    key: col('Issue key'), summary: col('Summary'), points: col('Story Points'), value: col('Value'), urgency: col('Urgency'), risk: col('Risk'),
    cod: col('Cost of Delay'), must: col('Must Have'), deps: col('Depends On'), past: col('Times Postponed'), fix: col('Fix Version/s'),
  };
  const tickets = rows.map((r, i) => ({
    sampleKey: r[c.key],
    jiraKey: `HB-${i + 1}`,
    summary: r[c.summary],
    points: num(r[c.points]),
    value: num(r[c.value]),
    urgency: num(r[c.urgency]),
    risk: num(r[c.risk]),
    cod: num(r[c.cod]),
    mustHave: r[c.must].trim().toLowerCase() === 'yes',
    dependsOn: r[c.deps].split(/[;,\s]+/).filter(Boolean),
    past: num(r[c.past]),
    fixVersion: r[c.fix],
  }));
  const keyOf = new Map(tickets.map((t) => [t.sampleKey, t.jiraKey]));
  for (const t of tickets) t.dependsOnJira = t.dependsOn.map((k) => keyOf.get(k) ?? k);
  return tickets;
}
