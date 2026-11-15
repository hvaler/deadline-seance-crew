---
name: deadline-seance
description: Answer "what happens to the freeze if ..." questions from live Jira issues with the jira-board and Deadline Séance tools, stating only numbers the tools return.
triggers: [freeze, cut, seance, séance, certificate, what if, away, exhume, put down]
always: false
---

# Deadline Séance from Jira

## Steps

1. Call `jira_board_csv` with `{ "project": "HB" }` (or the key the user names; add `fixVersion` if they name a release).
2. Pass the CSV unchanged as the board: `{ "source": "csv", "text": "<csv>" }`.
3. Pick one tool:
   - `what_if`: one change. Shapes:
     - `{ "kind": "away", "person": "Ana" }` (whole week), or with `"date": "YYYY-MM-DD"` and `"part": "morning" | "afternoon" | "full"`
     - `{ "kind": "back", "person": "Ana" }`
     - `{ "kind": "exhume", "key": "HB-5" }`, `{ "kind": "put_down", "key": "HB-5" }`
     - `{ "kind": "move_freeze", "freezeAt": "<ISO time>" }`, `{ "kind": "margin", "marginPct": 10 }`
   - `solve_freeze`: the plain cut.
   - `death_certificate`: tonight's certificate.
4. Always send `now` and `freezeAt` (ISO 8601 with a zone, Europe/Madrid unless told). "Friday's cut" means the next Friday 18:00. If the freeze time is unclear, ask.

## Reading `what_if`

- `before.capacity` -> `after.capacity`, `before.tickets` -> `after.tickets`, `before.cod` -> `after.cod`, and `cod_delta`.
- `goes_out` and `comes_in`: the keys and titles that change.
- `rejected: true`: the change makes the freeze impossible; say so, with `after.needed`.

## The rule on numbers

Only state numbers that a tool returned in this conversation. No arithmetic, no estimates, no numbers from memory or from this file. If a tool returns errors (CSV error codes, a Jira error), quote them and stop.

## Limits

- The team (names and capacity) is Deadline Séance's sample team; Jira has no team data here.
- Who is away comes only from the question.
- At most 60 open issues.
