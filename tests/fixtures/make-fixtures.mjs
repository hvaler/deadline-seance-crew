// Writes the recorded Jira responses the tests use: how Jira Cloud would answer for the HB project after
// scripts/seed-jira.mjs created the 19 sample tickets. Everything is invented: the site, the field ids, the issue ids.
// Run: node tests/fixtures/make-fixtures.mjs   (the output is committed; tests never call this)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleTickets } from '../../scripts/sample-board.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const write = (name, data) => writeFileSync(join(here, name), `${JSON.stringify(data, null, 2)}\n`);

export const IDS = {
  points: 'customfield_10016',
  value: 'customfield_10101',
  urgency: 'customfield_10102',
  risk: 'customfield_10103',
  past: 'customfield_10104',
  cod: 'customfield_10105',
};

write('fields.json', [
  { id: 'summary', name: 'Summary', custom: false },
  { id: 'labels', name: 'Labels', custom: false },
  { id: 'issuelinks', name: 'Linked Issues', custom: false },
  { id: 'fixVersions', name: 'Fix versions', custom: false },
  { id: 'assignee', name: 'Assignee', custom: false },
  { id: 'customfield_10020', name: 'Sprint', custom: true },
  { id: IDS.points, name: 'Story point estimate', custom: true },
  { id: IDS.value, name: 'Value', custom: true },
  { id: IDS.urgency, name: 'Urgency', custom: true },
  { id: IDS.risk, name: 'Risk', custom: true },
  { id: IDS.past, name: 'Times Postponed', custom: true },
  { id: IDS.cod, name: 'Cost of Delay', custom: true },
]);

const tickets = sampleTickets();
const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const issues = tickets.map((t, i) => {
  const links = [];
  for (const dep of t.dependsOnJira) links.push({ id: `2${i}0${links.length}`, type: blocks, inwardIssue: { key: dep } });
  for (const other of tickets) if (other.dependsOnJira.includes(t.jiraKey)) links.push({ id: `3${i}0${links.length}`, type: blocks, outwardIssue: { key: other.jiraKey } });
  return {
    id: String(10001 + i),
    key: t.jiraKey,
    fields: {
      summary: t.summary,
      labels: t.mustHave ? ['must-have'] : [],
      issuelinks: links,
      fixVersions: t.fixVersion ? [{ id: t.fixVersion === 'Next release' ? '10201' : '10200', name: t.fixVersion }] : [],
      [IDS.points]: t.points,
      [IDS.value]: t.value,
      [IDS.urgency]: t.urgency,
      [IDS.risk]: t.risk,
      [IDS.past]: t.past,
      [IDS.cod]: t.cod,
    },
  };
});

write('search-page-1.json', { issues: issues.slice(0, 10), nextPageToken: 'invented-token-page-2', isLast: false });
write('search-page-2.json', { issues: issues.slice(10), isLast: true });
