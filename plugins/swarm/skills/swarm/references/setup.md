# swarm setup — a guided walk through the config

Loaded by `/swarm:swarm setup`. The engine path is the one the swarm skill already resolved.

Swarm has one config file: `~/.swarm/config.json`. The shipped `config.default.json` is
**overwritten on every plugin update**, so the operator's own file is the only durable place
for the full picture. This walk materialises every key there, then takes the operator through
the decisions **in stages** — each stage explains one thing, shows the current value, and asks
one question. Nothing is written without the operator naming the value.

**This is a conversation, not a listing.** Do not print the key table at the operator; it is
an appendix for you. Say what a stage controls and what the trade-off is, in two or three
sentences, then ask. Skip a stage's question when the operator has already said what they want
for it.

## Procedure

1. **Materialise**: `node <engine> config init`. Creates the file with every shipped key, or
   fills in keys a newer plugin version added; values already set are never touched. Say what
   it did in one line (created / added N / up to date).
2. **Read** the file (`Read` on the printed path). You need the current values for every stage.
3. **Walk the stages below, one at a time.** For each: explain, state the current value, one
   `AskUserQuestion` with concrete options. Then the next stage. Never batch the stages into one
   question call, and never ask about a key you have not just explained.
4. **Edit** the file with the `Edit` tool as each answer lands, keeping JSON types (arrays stay
   arrays, numbers stay numbers, `null` is a real value for `token` / `notifyCmd`).
5. **Close** with what takes effect when: CLI keys on the next call; `swarm.*` at the next
   session start; `dashboard.*` after `serve stop` then `serve --daemon`. If the dashboard
   daemon is running and a `dashboard.*` or `grading.*` key changed, offer to restart it.

## The stages

### Stage 1 — where alternative models may run (`provider.allowedRoots`)

Swarm can dispatch leaves to non-Anthropic models (`:cloud` tier via ollama). Code under a
listed root may be sent to that provider; anything else fails validation, because the
operator's data agreement may cover Anthropic only. Empty means Claude-only — swarm still
works, the cheap tier never arms. Ask which roots, if any, are cleared to leave. Do not
suggest a root; the operator names it.

### Stage 1b — enable a cloud provider (`provider.cloud.*`)

`:cloud` leaves (ollama) have no availability signal unless swarm can read the account's own
usage meter — otherwise a dead weekly allowance looks identical to a healthy one until a
dispatch wastes it. Today there is exactly one cloud provider, ollama; say so, don't imply
others exist. One `AskUserQuestion`, `multiSelect: true`, options built from the known
providers (`ollama`). **Leaving it unticked is a real, common answer** — swarm still works,
Claude-only, with no meter to maintain.

For each ticked provider (ollama today):
1. Explain how to get the token: browser devtools → Network tab → any request to
   `ollama.com` → copy the `Cookie` request header.
2. Hand over `node <engine> ollama-usage --cookie '<value>'` for them to run themselves — it
   writes the cookie to `cookiePath` and immediately prints the current meter as confirmation
   it worked.
3. **Never ask the operator to paste the token into this conversation** for you to write into
   a file — `--cookie` is the only path, so the credential never enters the transcript.
4. Set `provider.cloud.ollama.enabled: true` in the config with the `Edit` tool. The meter is
   inert until this flag is on, even once a cookie is saved — an operator who ticks the
   provider but whose `--cookie` run fails should still see it correctly report "no reading
   yet" rather than silently doing nothing.

### Stage 2 — standing consent (`swarm.always`)

Every fan-out normally stops at an offer gate: a question showing the manifest, the model
mix and the cost before anything spends. `true` is standing consent to skip that question —
reading orchestrating-agents and executing-swarms, running `models` and `validate` all stay
mandatory, but nothing is printed or narrated before dispatch: the session runs it. Ask
whether they want to keep answering the question or trust the ceremony. Mention
`swarm.workflowNudge` only if they ask about Workflow: it is the one-time "consider swarm"
reminder on an armed machine.

### Stage 3 — the phone dashboard (`dashboard.*`)

A LAN web page over every run: live rosters, the run graph, leaf output, digests, and (when
grading is on) the model score tables. Three decisions, asked together as one question with
combined options if the operator is brisk, or one each if not:
- `enabled` — off makes `serve` a no-op so a Startup launcher stops it coming back.
- `bind` — `0.0.0.0` is reachable on the LAN and Tailscale; `127.0.0.1` is this machine only.
- `token` — when set, every request needs `?t=<token>`; bookmark the URL with it. Offer to
  generate one; never invent one silently.
`port` is advanced (Stage 7).

Starting it: `node <engine> serve --daemon` (or `serve` to stay in the foreground), and
`serve stop` to end it. To bring it back at login, `node <engine> serve install-autostart`
writes a Startup launcher pointing at `~/.swarm/serve.mjs` — the same self-resolving shim
the status bar uses, so it follows plugin updates instead of freezing on the sha-versioned
cache dir the install happened to run from. `serve uninstall-autostart` removes it. A
launcher written before this shim existed is pinned to an old build and keeps starting it
silently; re-run `install-autostart` once to repoint it.

### Stage 4 — the status bar (settings.json `statusLine`)

The plugin ships a status bar for Claude Code's bottom line: every live run THIS session
launched — done/total, a live symbol, the models seated on running leaves, work tokens, and a
yellow flag on a leaf quiet for over five minutes. Zero model cost. It cannot live in the
swarm config: Claude Code reads `statusLine` from `~/.claude/settings.json` only. Ask
whether they want it. On yes:
1. `node <engine> statusline install` — writes `~/.swarm/statusline.mjs`, a shim that
   resolves the installed plugin on every paint (so plugin updates never break the bar), and
   prints the exact `statusLine` block.
2. Put that block into `~/.claude/settings.json` with the `Edit` tool, **in place** — never
   tmp+rename (the file may be a symlink) — replacing any existing `statusLine`. Say that
   `/model` and `/effort` reserialise settings.json from the copy taken at session start,
   so an edit made mid-session can be reverted by them: the safe moment is the start of a
   session, or right before ending this one.
If settings.json already has a `statusLine`, the harness runs ONE command per bar: offer to keep theirs, switch to this one, or point settings at a wrapper script of their own that prints both.

### Stage 5 — telling the operator a run finished (`notifyCmd`)

Runs take minutes and the operator walks away. `notifyCmd` is a shell command fired at the
end with `{status}`, `{digest}` and `{summary}` substituted — the slack-bridge plugin's
`claude-slack notify --message "{status} — {digest}"` is the usual shape. `null` = nothing.
Ask whether they want a ping and, if so, through what.

### Stage 6 — grading the models (`grading.enabled`)

After a run, the session can grade each leaf's model on adherence, handoff, truthfulness,
depth and any capability it stressed; grades accumulate in `~/.swarm/model-scores.jsonl`,
`swarm perf` ranks them, and the dashboard's Performance page draws them. It costs a grading
pass per run. Off (the shipped default): no run asks, the tier guide routes models, the
Performance page is disabled. Worth turning on once the operator runs alternative models
often enough for the numbers to mean something. Ask.

### Stage 6b — the leaf context window (`disable1mContext`)

Every Claude leaf can run at the standard 200k context window or the 1M window. Measured on
one plan, byte-identical prompts, sonnet, list prices: the 1M window bought no quality
difference and zero compactions but cost ~45% more ($83.39 vs $57.60) — it is a wall-clock
lever, not a quality one. `true` (the shipped default) keeps every leaf at 200k; `false` gives
every Claude leaf 1M by default. Either way, a task's own `settings` key always wins, so a
manifest can opt one leaf in (or out) regardless of this default. Ask whether they want to pay
more for fewer compactions and faster walls, or keep 200k as the default.

### Stage 6c — the leaf guard (`projects`)

`projects` lets a repo ship its own PreToolUse hook for the leaves that run under it: a
command the repo owns, run before every tool call in such a leaf with the PreToolUse payload on
stdin. Exit 0 allows, exit 2 denies with the script's stderr as the reason; any other outcome
also denies, naming the failure (fail-closed — a guard that silently stops applying is worse
than one that blocks). Each distinct guard is probed once at `validate`, so a broken script
fails the manifest before anything spends.

One entry per repo, named and matched by that repo's directory name:

```json
{ "projects": [{ "name": "myrepo", "hooks": { "preToolUse": "python scripts/leaf_guard.py" } }] }
```

Uses are whatever a PreToolUse hook can express over the payload — keep builds out of lanes,
fence writes to a directory, block installs or pushes, require a marker on edits to certain
files. `name` is matched against the basename of the task's repo root (case-insensitive on
Windows); a task opts out with `"leafGuard": false`, the only accepted value. Ask whether the
operator has, or wants, a guard script for any repo they run leaves in; if not, leave `projects`
empty — nothing fires and every leaf runs as before.

### Stage 7 — advanced, only on request

Say once: "the remaining keys are tuning — timeouts, retries, concurrency, quota thresholds,
display cadence, provider plumbing. Want any of them?" If yes, explain only the ones named,
from the appendix. If no, close.

## Appendix — every key, for you

| Key | Default | What it does |
|---|---|---|
| `provider.allowedRoots` | `[]` | Stage 1. |
| `provider.url` | `http://localhost:11434` | Anthropic-format endpoint the leaves talk to; pinged before any run with a `:cloud` leaf, unreachable = refuse. |
| `provider.mode` | `env` | `env` = plain `claude -p` with `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` injected; `launch` = shell out through `launchCmd`. |
| `provider.launchCmd` | `ollama launch claude --model {model} -- {args}` | Only in `launch` mode. |
| `provider.discoverCmd` | `ollama launch claude` | Scraped by `models` to find what is launchable. |
| `provider.catalogUrl` | `https://ollama.com` | Where `models` reads the cloud catalogue and recommendations. |
| `provider.cloudSuffix` | `:cloud` | Which model names count as cloud tier. |
| `provider.authToken` | `ollama` | Sent as the API key in `env` mode. Placeholder, not a secret. |
| `provider.name` | `ollama` | Label only. |
| `provider.cloud.ollama.enabled` | `false` | Stage 1b. Gates the whole meter: off, `models`/`validate`/`modeFor` never read the cache and the feature is invisible. |
| `provider.cloud.ollama.cookiePath` | `null` | Stage 1b. Where `ollama-usage --cookie` writes the browser token; falls back to `~/.swarm/ollama-cookie.json` when unset. Never `config.json` itself. |
| `provider.usageStaleMs` | `86400000` | How old a cached meter reading may be before `models`/`validate` treat it as unverified rather than current. |
| `concurrency` | `4` | Ceiling on leaves alive at once (each is a full headless `claude` session). A manifest may run narrower, never wider — asking for more fails `validate`. A rate-limited leaf frees its slot while it backs off. |
| `timeoutMs` | `3600000` | Per-leaf wall clock; past it the leaf is `timeout`, slot freed. |
| `disable1mContext` | `true` | Stage 6b. `false` gives every Claude leaf the 1M context window by default (a wall-clock lever, ~+45% cost, same quality); a task's own `settings` always wins. |
| `retry.rateLimited` / `retry.backoffMs` | `2` / `30000` | Retries after a rate-limit failure, exponential from the backoff; the slot frees while waiting. |
| `retry.spawnError` | `1` | Retries when the leaf process fails to start. |
| `resultInlineCap` | `4000` | Between leaves, during a run: when leaf B's prompt says `{{result:A}}`, the engine pastes A's output text into B's prompt before launching B — up to this many characters, then cuts (flagged on the leaf, in `run.log` and the closing block). `{{resultPath:A}}` pastes the file path instead, uncapped; verifiers must use that. Not the digest — the digest reads every result file from disk after the run. |
| `worktreeBranchPrefix` | `swarm/` | Branch prefix for worktree-isolated leaves. |
| `modelDenylist` | `[]` | Case-insensitive substrings; matching models fail `validate` and vanish from `models`. |
| `notifyCmd` | `null` | Stage 5. |
| `quotaPreflight` | `true` | Before a run with Claude leaves, read Anthropic's usage with Claude Code's own sign-in; refuse when a window is exhausted. |
| `quotaWarnPct` | `80` | Warn once when the worst window is at or past this percent. |
| `quotaCacheSecs` | `300` | How long one usage read is reused. |
| `quotaPatterns` | four strings | Output substrings that classify a failed leaf as quota-hit. |
| `heartbeatSecs` | `15` | Two jobs on one number. The roster is the boxed table the engine prints while a run is live — one row per leaf: state glyph, id, model, elapsed, work tokens, last tool call. It repaints on every leaf event and, so timers and token counts keep moving between events, every this-many seconds — paint cadence for the operator's watch terminal. It is also the engine's liveness signal: it paints a heartbeat file on the same cadence, and `runLiveness`/`status`/`stop` treat a heartbeat older than 3x this value as a dead engine. Raising it slows the roster AND widens the window before a wedged engine is declared dead. |
| `quietWarnSecs` | `60` | A running leaf that has emitted no event (no tool call, no token update) for this long gets `⚠ quiet Ns` in the roster, the statusline and the dashboard. The stall signal — token counts are not. Raise it for models that think in long silent turns. |
| `dashboard.enabled` / `bind` / `token` | `true` / `0.0.0.0` / `null` | Stage 3. |
| `dashboard.port` | `7331` | Listen port; also the firewall rule's port. |
| `dashboard.livenessPollMs` | `10000` | How often the server re-checks which runs are live and tells connected browsers. Two things produce no filesystem event and are only ever caught by this clock: a run finishing (its `summary.json` lands in a path nothing watches) and an engine dying. It also rebuilds file watchers, so one that silently stops delivering recovers instead of leaving the page deaf until a manual refresh. Ticks only while a dashboard is actually open — nothing runs with no client connected. Lower it for a snappier list at the cost of more directory scans. |
| `dashboard.finishedPerProject` | `8` | How many finished runs each displayed project keeps on the runs list, newest first. A repo and its worktree keys are one group — the cap is per displayed project, not per run directory — and a truncated section header reads `N of M finished`. Raise it to keep more of a busy estate's history on screen. |
| `swarm.always` | `false` | Stage 2. |
| `swarm.workflowNudge` | `true` | One-time "consider swarm" on the first `Workflow` call of a session on an armed machine. |
| `grading.enabled` | `false` | Stage 6. |
| `projects` | `[]` | Stage 6c. Array of `{ name, hooks: { preToolUse } }`: the repo's own PreToolUse hook for leaves whose repo root basename matches `name`; payload on stdin, exit 0 allows, exit 2 denies with stderr, anything else denies (fail-closed); probed once at `validate`; `"leafGuard": false` opts a task out. |

## Common mistakes

- **Printing the appendix at the operator.** Observed 2026-09-05: a session dumped every key
  with its value in one message and then asked four questions at once — "you just bombed me
  with a list of settings without telling me what they do". Stages, one at a time.
- **Editing `config.default.json`** — lost on the next plugin update. Only `~/.swarm/config.json` persists.
- **Setting a key from a remark** ("I suppose C:/code is fine") — ask, then write what the operator said.
- **Skipping `config init` after a plugin update** — new keys stay invisible; the engine still uses their defaults, but the operator never sees them.
- **Adding a root to `allowedRoots` that is not cleared to leave** — the gate exists for the data agreement; explain that before asking.
