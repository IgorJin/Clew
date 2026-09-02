# Adapter compatibility

Clew v0.1 is tested against:

| Boundary             | Supported version | Transport                |
| -------------------- | ----------------- | ------------------------ |
| Codex CLI/app-server | `0.148.0`         | JSON-RPC over stdio      |
| OpenCode CLI/server  | `1.18.23`         | HTTP + SSE event API     |
| Node.js              | `22.5+`           | local runtime            |
| Git                  | `2.30+`           | native command arguments |

Run the required diagnostics before a native flow:

```sh
node bin/clew.js doctor --harness codex
node bin/clew.js doctor --harness opencode
```

Without `--harness`, native checks are informational so the deterministic fake flow remains usable. With the flag, missing binaries, incompatible versions, missing Codex authentication, or an unreachable OpenCode endpoint make the result `ok: false`.

Environment overrides:

- `CLEW_CODEX_BIN` — Codex executable;
- `CLEW_OPENCODE_BIN` — OpenCode executable;
- `CLEW_OPENCODE_URL` — running OpenCode HTTP endpoint;
- `CLEW_REVIEW_MODEL` — optional Codex reviewer model;
- `CLEW_ARCHITECT_MODEL` — optional Codex architect model.
- `CLEW_CODEX_OPEN_DESKTOP` — when `true`, additionally launch Codex Desktop on a new worker's worktree. The daemon-managed PTY/xterm terminal is created for every Codex worker independently of this flag.

When role model variables are absent, Clew lets the installed Codex CLI select its authenticated-account default. Clew does not hardcode UI tier aliases as app-server model identifiers.

Equivalent one-command overrides are `--codex-bin`, `--opencode-bin`, `--opencode-url`, and `--worktree-root`. Project `.clew.json` may contain only non-secret values; user-level config lives at `~/.config/clew/config.json` or `CLEW_USER_CONFIG`.

OpenCode server compatibility does not imply that its selected model provider is reachable. `doctor` proves CLI/server health and version; `npm run smoke:opencode` proves a complete model turn and verification command.

No credential value is printed by `doctor` or persisted in normalized events.
