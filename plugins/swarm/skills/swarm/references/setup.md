# swarm setup — the config, explained and edited with the operator

Loaded by `/swarm:swarm setup`. The engine path is the one the swarm skill already resolved.

Swarm has one config file: `~/.swarm/config.json`. The shipped `config.default.json` is
**overwritten on every plugin update**, so the operator's own file is the only durable
place for the full picture — this skill materialises every key there, explains what each
one does, and edits the ones the operator wants changed. Nothing is written without the
operator naming the value.

## Procedure

1. **Materialise**: `node <engine> config init`. Creates the file with every shipped key, or
   fills in keys a newer plugin version added; values already set are never touched. The
   output names the path and what changed.
2. **Read** the file (`Read` on the printed path).
3. **Explain** — walk the reference below group by group, giving the operator's current value
   for each key and what changing it does. Lead with the four that matter most:
   `provider.allowedRoots`, `swarm.always`, `dashboard.enabled`, `notifyCmd`.
4. **Ask** what to change — one `AskUserQuestion` per decision, options carrying the
   concrete values. Never infer a value from a remark.
5. **Edit** the file with the `Edit` tool, one key at a time, keeping JSON types (arrays stay
   arrays, numbers stay numbers, `null` is a real value for `token` / `notifyCmd`).
6. **Say what takes effect when**: every CLI call re-reads the file; `swarm.always` and
   `swarm.workflowNudge` are read by hooks at the next session start; `dashboard.*` needs
   `serve stop` then `serve --daemon`.

## Key reference

Values shown are the shipped defaults. The file the operator has may differ — always read it.

### Provider — the non-Claude side

| Key | Default | What it does |
|---|---|---|
| `provider.allowedRoots` | `[]` | **The governance gate.** Directory roots whose code may leave for the alternative provider. A non-Claude leaf whose cwd is not under one fails `validate`. Empty = Claude-only forever; the `:cloud` path never arms. List only roots cleared to leave. |
| `provider.url` | `http://localhost:11434` | Anthropic-format endpoint the leaves talk to. Pinged before any run with a `:cloud` leaf; unreachable = the run refuses. |
| `provider.mode` | `env` | `env` = plain `claude -p` with `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` injected. `launch` = shell out through `launchCmd`. |
| `provider.launchCmd` | `ollama launch claude --model {model} -- {args}` | Only used in `launch` mode. |
| `provider.discoverCmd` | `ollama launch claude` | Scraped by `models` to find what is launchable. |
| `provider.catalogUrl` | `https://ollama.com` | Where `models` reads the cloud catalogue and recommendations. |
| `provider.cloudSuffix` | `:cloud` | Which model names count as cloud tier. |
| `provider.authToken` | `ollama` | Sent as the API key in `env` mode. A placeholder for local ollama, not a secret. |
| `provider.name` | `ollama` | Label only. |

### Run behaviour

| Key | Default | What it does |
|---|---|---|
| `concurrency` | `4` | Parallel leaves cap. A manifest may set its own. |
| `timeoutMs` | `3600000` (60 min) | Per-leaf wall clock. A leaf past it is `timeout`, its slot freed. |
| `retry.rateLimited` | `2` | Retries after a rate-limit failure, exponential backoff from `retry.backoffMs`; the slot frees while waiting. |
| `retry.backoffMs` | `30000` | First backoff for the above. |
| `retry.spawnError` | `1` | Retries when the leaf process fails to start. |
| `resultInlineCap` | `4000` | `{{result:id}}` inlines at most this many chars, tail dropped. Why verifiers take `{{resultPath:id}}`. |
| `worktreeBranchPrefix` | `swarm/` | Branch prefix for worktree-isolated leaves. |
| `modelDenylist` | `[]` | Case-insensitive substrings. Matching models fail `validate` and vanish from `models`. For retiring a model on quality grounds. |
| `notifyCmd` | `null` | Shell command run when a run finishes; tokens `{status}` `{digest}` `{summary}`. E.g. the slack-bridge `claude-slack notify --message "{status} — {digest}"`. |

### Quota — Claude leaves

| Key | Default | What it does |
|---|---|---|
| `quotaPreflight` | `true` | Before a run with Claude leaves, read Anthropic's usage endpoint with Claude Code's own sign-in; refuse when a window is exhausted. |
| `quotaWarnPct` | `80` | Warn once when the worst window is at or past this percent. |
| `quotaCacheSecs` | `300` | How long one usage read is reused. |
| `quotaPatterns` | four strings | Output substrings that classify a failed leaf as quota-hit rather than a real failure. |

### Display

| Key | Default | What it does |
|---|---|---|
| `heartbeatSecs` | `15` | Roster repaint cadence while anything runs. |
| `quietWarnSecs` | `60` | A running leaf silent this long gets the quiet marker in the roster, statusline and dashboard. |

### Dashboard — the phone page

| Key | Default | What it does |
|---|---|---|
| `dashboard.enabled` | `true` | Off switch. `false` makes `serve` / `serve --daemon` print `disabled` and exit, so an installed Startup launcher is a no-op. |
| `dashboard.port` | `7331` | Listen port; also the firewall rule's port. |
| `dashboard.bind` | `0.0.0.0` | Interface. `127.0.0.1` keeps it off the LAN. |
| `dashboard.token` | `null` | When set, every request needs `?t=<token>` — bookmark the URL with it. |
| `dashboard.recentMs` | `1800000` (30 min) | A run with no live engine and no event in this window lists as stale. The statusline glyph uses the same window. |

### Swarm — session behaviour

| Key | Default | What it does |
|---|---|---|
| `swarm.always` | `false` | **Standing consent.** `true` = the offer gate prints its statement instead of asking; the full ceremony (orchestrating-agents, executing-swarms, `models`, `validate`) still runs. Announced by a SessionStart hook with a mode bracket. |
| `swarm.workflowNudge` | `true` | On an armed machine, the first `Workflow` call of a session gets a one-time "consider swarm" reminder. `false` silences it. |

## Common mistakes

- **Editing `config.default.json`** — lost on the next plugin update. Only `~/.swarm/config.json` persists.
- **Setting a key to a value from a remark** ("I suppose C:/code is fine") — ask, then write what the operator said.
- **Skipping `config init` after a plugin update** — new keys stay invisible; the engine still uses their defaults, but the operator never sees them.
- **Adding a root to `allowedRoots` that is not cleared to leave** — the gate exists for the data agreement; explain that before asking.
