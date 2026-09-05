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

### Stage 2 — standing consent (`swarm.always`)

Every fan-out normally stops at an offer gate: a question showing the manifest, the model
mix and the cost before anything spends. `true` waives that question — the gate prints the
same facts and dispatches — while the rest of the ceremony (orchestrating-agents,
executing-swarms, `models`, `validate`) still runs. Ask whether they want to keep answering
the question or trust the ceremony. Mention `swarm.workflowNudge` only if they ask about
Workflow: it is the one-time "consider swarm" reminder on an armed machine.

### Stage 3 — the phone dashboard (`dashboard.*`)

A LAN web page over every run: live rosters, the run graph, leaf output, digests, and (when
grading is on) the model score tables. Three decisions, asked together as one question with
combined options if the operator is brisk, or one each if not:
- `enabled` — off makes `serve` a no-op so a Startup launcher stops it coming back.
- `bind` — `0.0.0.0` is reachable on the LAN and Tailscale; `127.0.0.1` is this machine only.
- `token` — when set, every request needs `?t=<token>`; bookmark the URL with it. Offer to
  generate one; never invent one silently.
`port` and `recentMs` are advanced (Stage 7).

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
| `concurrency` | `4` | Ceiling on leaves alive at once (each is a full headless `claude` session). A manifest may run narrower, never wider — asking for more fails `validate`. A rate-limited leaf frees its slot while it backs off. |
| `timeoutMs` | `3600000` | Per-leaf wall clock; past it the leaf is `timeout`, slot freed. |
| `retry.rateLimited` / `retry.backoffMs` | `2` / `30000` | Retries after a rate-limit failure, exponential from the backoff; the slot frees while waiting. |
| `retry.spawnError` | `1` | Retries when the leaf process fails to start. |
| `resultInlineCap` | `4000` | `{{result:id}}` inlines at most this many chars, tail dropped — why verifiers take `{{resultPath:id}}`. |
| `worktreeBranchPrefix` | `swarm/` | Branch prefix for worktree-isolated leaves. |
| `modelDenylist` | `[]` | Case-insensitive substrings; matching models fail `validate` and vanish from `models`. |
| `notifyCmd` | `null` | Stage 5. |
| `quotaPreflight` | `true` | Before a run with Claude leaves, read Anthropic's usage with Claude Code's own sign-in; refuse when a window is exhausted. |
| `quotaWarnPct` | `80` | Warn once when the worst window is at or past this percent. |
| `quotaCacheSecs` | `300` | How long one usage read is reused. |
| `quotaPatterns` | four strings | Output substrings that classify a failed leaf as quota-hit. |
| `heartbeatSecs` | `15` | Roster repaint cadence while anything runs. |
| `quietWarnSecs` | `60` | A running leaf silent this long gets the quiet marker (roster, statusline, dashboard). |
| `dashboard.enabled` / `bind` / `token` | `true` / `0.0.0.0` / `null` | Stage 3. |
| `dashboard.port` | `7331` | Listen port; also the firewall rule's port. |
| `dashboard.recentMs` | `1800000` | A run with no live engine and no event in this window lists as stale; the statusline glyph uses the same window. |
| `swarm.always` | `false` | Stage 2. |
| `swarm.workflowNudge` | `true` | One-time "consider swarm" on the first `Workflow` call of a session on an armed machine. |
| `grading.enabled` | `false` | Stage 6. |

## Common mistakes

- **Printing the appendix at the operator.** Observed 2026-09-05: a session dumped every key
  with its value in one message and then asked four questions at once — "you just bombed me
  with a list of settings without telling me what they do". Stages, one at a time.
- **Editing `config.default.json`** — lost on the next plugin update. Only `~/.swarm/config.json` persists.
- **Setting a key from a remark** ("I suppose C:/code is fine") — ask, then write what the operator said.
- **Skipping `config init` after a plugin update** — new keys stay invisible; the engine still uses their defaults, but the operator never sees them.
- **Adding a root to `allowedRoots` that is not cleared to leave** — the gate exists for the data agreement; explain that before asking.
