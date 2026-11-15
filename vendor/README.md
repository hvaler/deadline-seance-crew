# vendor/

`deadline-seance-mcp.mjs` is the built MCP server of Deadline Séance (tools `solve_freeze`, `what_if`, `death_certificate`), copied unchanged so this app does not need the main repo on disk and never rebuilds anything there. It is one self-contained ES module; its only imports are `node:` built-ins.

| | |
|---|---|
| Source | `dist-mcp/server.mjs` of the Deadline Séance repo, built by `npm run mcp:build` |
| Source commit | `72ad1acde5eb8593a1a4dbafb44032a2d98e50ca` (2026-11-15; `mcp/`, `src/engine/` and `package.json` clean at that commit) |
| SHA-256 | `A5AD495DC8B185E717ABEABAD95B2B1A4491BE32745B68CC7A8D0366109DE652` |
| Size | 1,040,867 bytes |
| Licence | MIT, same holder as this repo |

To update: rebuild it in the main repo, copy the file here, and update the commit and hash above. Check the hash with:

```powershell
(Get-FileHash vendor/deadline-seance-mcp.mjs -Algorithm SHA256).Hash
```

Do not edit the file by hand. The rule lives in the main repo.
