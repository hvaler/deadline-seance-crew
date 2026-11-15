# deadline-seance-crew: design

Status: v0.1.0, 49 tests pass. Tried end to end on 2026-11-15 against a real Jira Cloud space: 19 issues and 5 Blocks links were seeded with `scripts/seed-jira.mjs`, and `solve_freeze` and `what_if`, asked through the undertaker agent, gave the same cut as the sample board: capacity 59, 12 kept, cost of delay 167. With Ana away all week: capacity 59 -> 39, cost of delay 167 -> 124, 12 -> 9 kept. The fog differs (2 nights in 1,000 against 3), because the hash uses the issue key. `jira-board` runs **outside Crew** over HTTP (section 1.4).

## 1. What was found on Windows (Crew 0.12.2)

### 1.1 Install and enable

| Step | Result |
|---|---|
| `kirocrew app install <local path>` | Works. No bash. |
| `kirocrew app enable` | Needs the app trusted from the dashboard (`agent.apps_trusted`). **Uninstall removes the trust**; enable again from the Library. |
| `kirocrew app update` from the CLI | Fails: "No running gateway answered". The dashboard's Update failed with WinError 5 (installed folder in use). Uninstall + install + enable from the Library works. |
| `permissions.cron` | Required when `crons` is declared; install refuses without it. |
| `platform.os: ["windows","macos","linux"]` | Accepted by install and enable. |
| Agent tool reference | Must be `@<app>:<server>`, e.g. `@deadline-seance-crew:jira-board`. `@deadline-seance` did not resolve. |

### 1.2 How stdio `mcpServers` launch

Crew starts app stdio servers from the session's working folder, not the app folder.

| Style | Result |
|---|---|
| `"command": "node", "args": ["vendor/deadline-seance-mcp.mjs"]` (plain relative) | **Fails**: "failed to start". Crew leaves this entry as written. |
| `"command": "python", "args": ["bin/node-launch.py", "<script>"]` (relative `.py` launcher) | **Works.** Crew rewrites it to its own `python.exe -s <absolute app path>\bin\node-launch.py <script>`. The launcher finds the script next to itself and starts `node`. |

`deadline-seance` uses the launcher.

### 1.3 Jira credentials are scrubbed by Crew, on purpose

| Where | `JIRA_BASE_URL` | `JIRA_EMAIL` | `JIRA_API_TOKEN` |
|---|---|---|---|
| Windows user environment | present, 32 | present, 20 | present, 192 |
| A process started by Crew | absent | absent | absent |

From Crew's code: `JIRA_API_TOKEN` (and `JIRA_TOKEN_*`) is on `_AGENT_DENIED_ENV_KEYS` in `kiro_crew/sandbox_tiers.py`. Crew removes those names from every child it starts. `${env:…}` placeholders and `agent.env` drop the same names. `secret://` in an app stdio server's env is not resolved (KiroCrew issue 10641).

**Decision (2026-11-15):** do not rename the variable. `jira-board` runs outside Crew, in the user's terminal, and Crew reaches it by url.

### 1.4 How Crew passes headers to a url server

From `kiro_crew/mcp_gateway/secret_uri.py` (`REMOTE_HEADER_ALTERNATIVE`): on the kiro-cli backend, a remote server's header value may use `${env:NAME}`. kiro-cli expands it at session time. `NAME` is set in Crew's own `.env` file (`~/.kiro/crew/.env`; `config/loader_credentials.py` reads `config_dir() / ".env"`). `secret://` in a header is **not** resolved for remote servers.

So `app.json` holds only the placeholder `Bearer ${env:DSC_JIRA_BOARD_TOKEN}`, never the value. The value goes in Crew's `.env`, outside the repo. `DSC_JIRA_BOARD_TOKEN` matches none of Crew's scrub lists (`_AGENT_DENIED_ENV_KEYS`, `ENV_SCRUB_PREFIXES` = `AWS_SECRET`, `AWS_SESSION`, `OAUTH`). It is a new local token, not the Jira credential, so nothing is routed around.

Other facts from the code: an app url server with no `backend.entryPoint` is "self-managed". Its url is kept as written and not port-rewritten (`apps/bridges_mcp.py`, `agent_materialization/mcp_sources.py`). Install accepted the entry with `url` and `headers`.

Seen live on 2026-11-15: after `DSC_JIRA_BOARD_TOKEN` was added to Crew's `.env` and Crew was restarted, the agent called `jira_board_csv` over `127.0.0.1` with the header expanded.

### 1.5 Other facts

- The importer has no fix-version column; people away are not in the CSV.
- A `{source:'csv'}` board uses Deadline Séance's sample team (Ana and the rest).
- Team-managed projects often leave Resolution empty on Done, so "open" is `statusCategory != Done`.
- `/rest/api/3/search` is removed; the tool uses `POST /rest/api/3/search/jql` with `nextPageToken`.

## 2. app.json (as in the repo)

```json
{
  "name": "deadline-seance-crew",
  "version": "0.1.0",
  "displayName": "Deadline Séance Crew",
  "agents": ["agents/undertaker.json"],
  "skills": ["skills/deadline-seance"],
  "mcpServers": {
    "deadline-seance": { "command": "python", "args": ["bin/node-launch.py", "vendor/deadline-seance-mcp.mjs"] },
    "jira-board": { "url": "http://127.0.0.1:47821/mcp", "headers": { "Authorization": "Bearer ${env:DSC_JIRA_BOARD_TOKEN}" } }
  },
  "crons": [{ "name": "nightly-certificate", "cron_expr": "0 20 * * 1-5", "timezone": "Europe/Madrid", "agent": "undertaker", "enabled": false, "message": "..." }],
  "permissions": { "network": true, "cron": true },
  "platform": { "os": ["windows", "macos", "linux"] }
}
```

(Description, author, licence, tags and highlights left out.) `timezone` on the cron is not in the manifest docs; check it in Schedule after enable. The cron needs `jira-board` running at 20:00, or it reports a connection error.

## 3. Agent and skill

`undertaker` uses `@deadline-seance-crew:jira-board` and `@deadline-seance-crew:deadline-seance`. Its prompt:
1. Get the board with `jira_board_csv` (HB by default) and pass it unchanged as `{source:'csv', text}`.
2. Use `what_if` for one change, `solve_freeze` for the cut, and `death_certificate` for the certificate.
3. Always send `now` and `freezeAt`.
4. State only returned numbers. On an error, quote it and stop.
5. Never show credentials or personal data.

The skill holds the change shapes and how to read `what_if`.

## 4. jira-board

| File | Job |
|---|---|
| `mcp/jira-board/board.mjs` | Jira reads, field match, CSV rows |
| `mcp/jira-board/csv.mjs` | CSV writer |
| `mcp/jira-board/server.mjs` | MCP JSON-RPC handler (shared by both transports) |
| `mcp/jira-board/main.mjs` | stdio entry (tests only now) |
| `mcp/jira-board/http.mjs` | Streamable HTTP transport |
| `mcp/jira-board/localtoken.mjs` | the local bearer token file |
| `mcp/jira-board/serve-http.mjs` | entry the user runs: `npm run jira-board` |

### 4.1 The tool

`jira_board_csv` is read-only (`readOnlyHint: true`).

| Input | Meaning |
|---|---|
| `project` | `^[A-Z][A-Z0-9_]{1,9}$` |
| `fixVersion` | optional, 1–100 characters, quoted into JQL |
| `check` | `"env"`: present and length of the three variables, no request. `"setup"`: also `GET /rest/api/3/project/{key}` (status only) and `GET /rest/api/3/field` (count per needed name). |

Requests: `GET /rest/api/3/field`, then `POST /rest/api/3/search/jql`, JQL `project = "HB" AND statusCategory != Done [AND fixVersion = "…"] ORDER BY key ASC`. The field list is explicit, 100 per page, following `nextPageToken`. It stops on `isLast`, after 10 pages, or on a repeated token. More than 60 issues is refused. Errors are `code: sentence`, never with a credential, the site URL or Jira's own error text.

### 4.2 HTTP transport

| Rule | How |
|---|---|
| Bind | `127.0.0.1` only. `listen()` has no host option. |
| Port | `DSC_JIRA_BOARD_PORT`, default `47821`, 1024–65535 (`0` = free port, tests). Must match the url in `app.json`. |
| Host | must be `127.0.0.1` or `localhost`, port absent or equal to the bound port; else 403 |
| Origin | absent, or `http(s)://127.0.0.1`/`localhost`; else 403 (`null` refused) |
| Auth | `Authorization: Bearer <local token>`, compared in constant time (SHA-256 then `timingSafeEqual`); else 401 with `WWW-Authenticate: Bearer`. It is checked before the body is read. |
| Method | `POST /mcp` only (405 otherwise, 404 for other paths) |
| Body | `application/json` (415 otherwise), at most 1 MiB (413), one JSON-RPC message (no batches) |
| Answer | one JSON body (`200`), or `202` with no body for a notification. No SSE stream, no session id. The spec allows a JSON answer. |
| Logging | none per request. One startup line on stderr: address and present/absent for each `JIRA_*`. |

Order of checks: Host, Origin, path, token, method, content type, body.

### 4.3 The local token

- Path: `%APPDATA%\deadline-seance-crew\local-token` on Windows, `$XDG_CONFIG_HOME` or `~/.config` + `/deadline-seance-crew/local-token` elsewhere. `DSC_JIRA_BOARD_TOKEN_FILE` overrides it (tests).
- Made on first start: 32 random bytes, base64url (43 characters). The folder is created with mode 0700 and the file with `wx` and 0600. On Windows, `icacls /inheritance:r /grant:r <DOMAIN>\<user>:F` leaves one ACE (seen: `HUGOVALER\hugo_:(F)` only). If that fails, the file is removed and the server does not start.
- Reused after that, and never overwritten. A broken file is an error that says to delete it.
- Crew gets it from `DSC_JIRA_BOARD_TOKEN` in `~/.kiro/crew/.env`, which the user sets once. README has the PowerShell lines.

## 5. Jira field to CSV column

| CSV column | Jira | Custom field |
|---|---|---|
| Issue key, Summary | `key`, `summary` | no |
| Story Points | "Story point estimate" | yes |
| Value, Urgency, Risk | number fields | yes |
| Cost of Delay | number field (HB-111) | yes, added by the user |
| Times Postponed | number field | yes |
| Must Have | label `must-have` | no |
| Depends On | "is blocked by" ends of Blocks links, to issues on the board | no |
| Fix Version/s | `fixVersions[].name` joined with `;` | no |
| Resolution | empty | no |

## 6. Tests

`npm test` (`node:test`): 49 tests, no network beyond 127.0.0.1, all pass.
- `tests/board.test.mjs` (16): CSV, requests, pagination, input, config, errors, fields, limits, escaping, links.
- `tests/server.test.mjs` (6): stdio, `check` modes, errors without secrets.
- `tests/http.test.mjs` (12): binds to 127.0.0.1 only. Lists the tool and answers a call from the recorded Jira. Refuses a foreign Host (including `localhost` on another port, `0.0.0.0`, `[::1]`, `127.0.0.1.nip.io`). Refuses a foreign Origin. Refuses a missing, wrong or malformed bearer token without calling Jira. Allows only POST with JSON, with body limits. No credential or token in any response. The token file is created once, private and reused. The real `serve-http.mjs` prints exactly one startup line with no secret.
- `tests/e2e.test.mjs` (2): the CSV goes into the vendored server. `what_if` with Ana away gives 59 -> 39, 12 -> 9, 167 -> 124, and HB-13, HB-15, HB-18 out.
- `tests/seed.test.mjs` (13): the seed script against a recorded empty project, and `--links-only` against a recorded project that already has the 19 issues. They pin the link direction (`linkBody`), the missing-only rule, the refusal on a link in the wrong direction and on a missing or duplicated summary, and that nothing is written on a dry run.

## 7. Seed script

`scripts/seed-jira.mjs`. Run it from the user's terminal, like `jira-board`. Without `--yes` it only reads.
- Seed: with `--yes` it creates 19 Stories and 5 Blocks links in an empty project. Run on 2026-11-15, it created HB-1 to HB-19. Its first link came out reversed and it stopped before the other four (section 10, last decision).
- `--links-only`: for a project that already has the issues. It maps the sample to the existing issues by summary (refused if one is missing or duplicated), reads the existing Blocks links, and creates only the missing ones. A Blocks link that runs the wrong way between two planned issues is named and nothing is created. It never deletes or edits. With `--yes` it creates the links, and after the first one it reads it back.

## 8. Vendored server

`vendor/deadline-seance-mcp.mjs`, commit `72ad1acde5eb8593a1a4dbafb44032a2d98e50ca`, SHA-256 `A5AD495DC8B185E717ABEABAD95B2B1A4491BE32745B68CC7A8D0366109DE652`.

## 9. Dashboard page

Not started.

## 10. Decisions

| Topic | Decision | How it was settled |
|---|---|---|
| Engine | Vendored, unchanged: `vendor/deadline-seance-mcp.mjs` at commit `72ad1ac`, SHA-256 pinned (section 8). | The app does not need the main repo on disk and never rebuilds anything there. |
| Field names | Jira fields are matched by name through `/rest/api/3/field`: Story point estimate, Value, Urgency, Risk, Times Postponed, and Cost of Delay (optional). Must-have is the label `must-have`. Dependencies are Blocks links. | `check: "setup"` on 2026-11-15 found each of the six names once on the site, including Story point estimate. |
| Who is away | Only from the question. The team (names, points per half-day) is Deadline Séance's sample team. | Jira has no team data here, and the tool asks for no people fields. |
| Won't Do | The CSV never carries a Resolution, so no ticket arrives already put down. Putting one down is a `what_if` change (`put_down`). | Open means status category not Done, because team-managed projects often leave Resolution empty on Done. |
| Cron time zone | The cron entry declares `"timezone": "Europe/Madrid"`. It ships paused. | `timezone` is not in the manifest docs, and the Schedule tab has not been checked for it. |
| `jira-board` location | Outside Crew, started by the user, over Streamable HTTP on `127.0.0.1` with a local bearer token. | Crew scrubs `JIRA_API_TOKEN` from every process it starts, on purpose (section 1.3). The variable is not renamed. The header is `Bearer ${env:DSC_JIRA_BOARD_TOKEN}`, with the value in Crew's `.env` (section 1.4). Worked live on 2026-11-15 after a Crew restart; whether the restart was strictly needed was not tested. |
| Relative paths | A stdio server is started only through the `.py` launcher (`bin/node-launch.py`). | A plain relative `node` entry failed to start; the launcher worked (section 1.2). |
| Jira link direction | In `POST /rest/api/3/issueLink`, `inwardIssue` is the blocker and `outwardIssue` the blocked issue. "A depends on B" is sent as `linkBody(B, A)`. | The first seed run sent them the other way and the first link came out reversed. A test pins the body, and the reader (`inwardIssue` on an issue means "is blocked by") is covered by its own test. |

Still open: whether the nightly job should warn more clearly when `jira-board` is not running. Today the agent quotes the connection error.
