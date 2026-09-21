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

0. **Install**: `swarm install`. Writes `~/.local/bin/swarm-resolver.mjs`, `~/.local/bin/swarm`,
   and `~/.local/bin/swarm.cmd`; `~/.local/bin` must be on PATH. Skip if the command is already
   available. Re-run after any plugin update to refresh the resolver copy; it is idempotent and
   overwrites the same three paths.
1. **Materialise**: `swarm config init`. Creates the file with every shipped key, or
   fills in keys a newer plugin version added; values already set are never touched. Say what
   it did in one line (created / added N / up to date).
   A file written before swarm had `providers` may hold the older `"provider"` and `"codex"`
   keys. `init` folds them into `providers.ollama` / `providers.codex` in the same pass,
   prints the mapping it applied, and leaves the previous file at `config.json.bak`. Values
   do not change. A folded value swarm would refuse makes it write nothing and say which key
   is wrong — fix that value, then re-run.
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

### Stage 0 — put `swarm` on PATH

The `swarm` command is the only supported way to invoke the engine. `swarm install` writes
`~/.local/bin/swarm-resolver.mjs`, `~/.local/bin/swarm`, and `~/.local/bin/swarm.cmd`, and expects
`~/.local/bin` to be on PATH. Re-running refreshes the resolver copy; it is idempotent and
overwrites the same three paths. Once installed, every later stage uses `swarm <subcommand>`.

**If `swarm` is not on PATH yet** — the first-run case, and the one thing that cannot go through
the command itself — invoke the engine directly, once. You already hold the authoritative
location: this skill's base directory is printed to you at invocation. Go two levels up from it
to the plugin root, then run the engine under `scripts/` with the single argument `install`.
Never glob the plugin cache and never sort sha directories by name — that is the exact bug this
whole command exists to remove, and it silently picks a stale build.

### Stage 1 — which providers (`providers.<name>.enabled`)

**Probe, show the result, then ask** — and it comes before roots, because asking which roots are
cleared for a provider the operator does not want is wasted.

The provider that is activating swarm is the **host**, and it is on by default: a swarm that can
dispatch nothing at all on a fresh install is a worse first run than one that over-enables the
host it is running inside. Everything else is opt-in. When detection cannot say what the host is
(no `SWARM_HOST`, no host marker in the environment), nothing is assumed — every provider is
asked about, host or not. Failing towards asking, never towards enabling.

Ask the engine which host it sees, rather than reading the environment yourself — the same
module the status-line resolver uses, so both agree:

```
node --input-type=module -e "const h=await import('./src/host.mjs');const host=h.detectHost();console.log(host, JSON.stringify(h.hostProviders(host)))"
```

Both one-liners below import by relative path, so run them with the plugin root as the working
directory — the one Stage 0 already located. An absolute path is not an option here: `import()`
refuses a bare `C:/…` (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, received protocol `c:`) and needs a
`file:///C:/…` URL instead. `cd` to the plugin root and the paths just work.

`claude` here means `providers.claude` needs no question — say that it is on and why (it is what
is running swarm). `unknown` means ask about every provider, Claude included.

For each non-host provider, the probe result IS the content of the question, not a preamble to
it. The probe is the engine's own — the same one the run-time preflight uses, not a second
setup-only implementation — so run it through the engine rather than by hand, from the plugin
root that Stage 0 already located:

```
node --input-type=module -e "const p=await import('./src/providers.mjs'),c=await import('./src/config.mjs');console.log(JSON.stringify(await p.probeProvider('<id>',{config:c.loadConfig()})))"
```

`<id>` is `ollama` or `codex`. Nothing else needs passing: `probeProvider` defaults `fetch` to
the global one, which is what makes this runnable as a one-liner. The probe is bounded at ~2s,
so a black-holed endpoint on a corporate network reports a timeout instead of hanging the
conversation on the OS TCP timeout — a setup question that hangs is worse than one that fails.

```
Ollama — endpoint http://localhost:11434 is unreachable (connect ECONNREFUSED).
  Leave disabled (Recommended)  /  Enable anyway (I will start it later)
```

```
Ollama — endpoint http://localhost:11434 answered.
  Enable (Recommended)  /  Leave disabled
```

**A successful probe never enables on its own.** A reachable endpoint is *available*, not
*wanted* — a work machine is exactly the case where the route exists and is off-limits. So the
probe result leads the question; the answer is still the operator's.

Write `providers.<id>.enabled` with the `Edit` tool. `providers.ollama.enabled: false` is the
shipped default, so declining an untouched file means writing nothing.

### Stage 1b — enable provider capabilities (`providers.<name>.*`)

`:cloud` leaves (ollama) have no availability signal unless swarm can read the account's own
usage meter — otherwise a dead weekly allowance looks identical to a healthy one until a
dispatch wastes it. The shipped cloud meter is Ollama; other providers may expose their own
usage capability, with any live read explicitly opted in. One `AskUserQuestion`,
`multiSelect: true`, options built from the known providers. **Leaving it unticked is a real,
common answer** — swarm still works, Claude-only, with no meter to maintain.

For Ollama's meter:
1. Explain how to get the token: browser devtools → Network tab → any request to
   `ollama.com` → copy the `Cookie` request header. The cookie is a live credential: it
   expires when the browser session does, and expiry is what the meter reports as
   `/!\ Cookie Expired` — a refresh means re-copying a fresh header, not a config change.
   Say also that the swarm store is separate from the operator-side `~/.ollama-usage`
   skill's own cookie: refreshing one does not refresh the other, and the banner names
   the exact file it is talking about.
2. Hand over `swarm ollama-usage --cookie '<value>'` for them to run themselves — it
   writes the cookie to `cookiePath` and immediately prints the current meter as confirmation
   it worked.
3. **Never ask the operator to paste the token into this conversation** for you to write into
   a file — `--cookie` is the only path, so the credential never enters the transcript.
4. Set `providers.ollama.cloud.ollama.enabled: true` in the config with the `Edit` tool. The meter is
   inert until this flag is on, even once a cookie is saved — an operator who ticks the
   provider but whose `--cookie` run fails should still see it correctly report "no reading
    yet" rather than silently doing nothing.

Codex is opt-in under `providers.codex.enabled` and uses its configured app-server command;
its usage reader is explicit rather than a background preflight.

### Stage 2 — where swarm may run at all (`allowedRoots`)

**Every provider is gated, Claude included, and an empty list permits nothing.** Code under a
listed root may be dispatched; anything else fails validation. For a non-Anthropic provider the
reason is the data agreement, which may cover Anthropic only. For Claude it is containment:
swarm runs nothing outside its configured roots.

Write ONE top-level `allowedRoots`. It is the default for every provider, so in the common case
that is the whole of stage 1. `providers.<name>.allowedRoots` still exists, but it only ever
NARROWS the top-level list — the two are intersected, so a provider entry can never add a root
or widen one. Reach for it only when a provider must be held to less than the default, and name
the trade-off when you do; for a non-Anthropic provider that is normally the data agreement
being tighter than the machine-wide default.

So this stage is not optional and has no Claude-only fallback — **with no list configured, every
provider dispatches nothing**. Absent is not the same as `[]`: an empty list is the operator
deliberately denying everything, and the two refusals read differently. Do not suggest a root;
the operator names it.

### Stage 3 — standing consent (`swarm.always`)

Every fan-out normally stops at an offer gate: a question showing the manifest, the model
mix and the cost before anything spends. `true` is standing consent to skip that question —
reading orchestrating-agents and executing-swarms, running `models` and `validate` all stay
mandatory, but nothing is printed or narrated before dispatch: the session runs it. Ask
whether they want to keep answering the question or trust the ceremony. Mention
`swarm.workflowNudge` only if they ask about Workflow: it is the one-time "consider swarm"
reminder on an armed machine.

### Stage 4 — the phone dashboard (`dashboard.*`)

A LAN web page over every run: live rosters, the run graph, leaf output, digests, and (when
grading is on) the model score tables. Three decisions, asked together as one question with
combined options if the operator is brisk, or one each if not:
- `enabled` — **this answer is an action, not an edit**: run `swarm serve enable` or
  `swarm serve disable`. One write path, shared with the tray, so the file is never touched by
  hand and the answer is observable on its own — neither verb starts or stops anything.
  - **Yes** → `serve enable`, then **offer** to start it now (`serve --daemon`) and read back
    the URL. Starting it unasked is worse than the question.
  - **No** → `serve disable`, then check `swarm serve status` and, if a daemon is still
    serving, **offer** to `serve stop` it. A running dashboard keeps serving until it is
    stopped, so "no" that stops nothing is the same complaint with the sign flipped.
  With it off, `swarm serve` starts no server — and the tray still appears, in its
  `(Disabled)` state, as the way back on.
- `bind` — `0.0.0.0` is reachable on the LAN and Tailscale; `127.0.0.1` is this machine only.
- `token` — when set, every request needs `?t=<token>`; bookmark the URL with it. Offer to
  generate one; never invent one silently.
`port` is advanced (Stage 8).

Running it: `swarm serve --daemon` (or `serve` to stay in the foreground), and
`serve stop` to end it. `serve status` prints the pid, port, running version and start
time; `serve restart` replaces a running daemon in one step. A running daemon also
upgrades itself — when a plugin update moves the installed version it hands the port to
a replacement started through the shim and exits once that replacement is listening,
unless `dashboard.autoRestartOnUpdate: false` turns the handover into a report.

For "back at login", **run the install and verify it — don't print the command and hope**:
1. `swarm serve install-autostart` — writes a Startup launcher pointing at
   `~/.swarm/serve.mjs`, the same self-resolving shim the status bar uses, so it follows
   plugin updates instead of freezing on the sha-versioned cache dir the install happened
   to run from. `serve uninstall-autostart` removes it.
2. Verify: read the launcher back and confirm its command names the shim, not a
   `plugins\cache` path. A launcher written before this shim existed is pinned to an old
   build and keeps starting it silently; re-running `install-autostart` repoints it.
3. Smoke test: `swarm serve doctor` — five ✓/✗/⚠ lines (port reachable, pid
   alive, autostart launcher, version current, firewall rule). Read them to the operator;
   a ✗ names its own fix, and ⚠ (the firewall rule is unreadable without elevation) is
   not a failure.

### Stage 5 — the status bar (settings.json `statusLine`)

The plugin ships a status bar for Claude Code's bottom line: every live run THIS session
launched — done/total, a live symbol, the models seated on running leaves, work tokens, and a
yellow flag on a leaf quiet for over five minutes. Zero model cost. It cannot live in the
swarm config: Claude Code reads `statusLine` from `~/.claude/settings.json` only. Ask
whether they want it. On yes:
1. `swarm statusline install` — writes `~/.swarm/statusline.mjs`, a shim that
   resolves the installed plugin on every paint (so plugin updates never break the bar), and
   prints the exact `statusLine` block.
2. Put that block into `~/.claude/settings.json` with the `Edit` tool, **in place** — never
   tmp+rename (the file may be a symlink) — replacing any existing `statusLine`. Say that
   `/model` and `/effort` reserialise settings.json from the copy taken at session start,
   so an edit made mid-session can be reverted by them: the safe moment is the start of a
   session, or right before ending this one.
If settings.json already has a `statusLine`, the harness runs ONE command per bar: offer to keep theirs, switch to this one, or point settings at a wrapper script of their own that prints both.

### Stage 6 — telling the operator a run finished (`notifyCmd`)

Runs take minutes and the operator walks away. `notifyCmd` is a shell command fired at the
end with `{status}`, `{digest}` and `{summary}` substituted — the slack-bridge plugin's
`claude-slack notify --message "{status} — {digest}"` is the usual shape. `null` = nothing.
Ask whether they want a ping and, if so, through what.

### Stage 7 — grading the models (`grading.enabled`)

After a run, the session can grade each leaf's model on adherence, handoff, truthfulness,
depth and any capability it stressed; grades accumulate in `~/.swarm/model-scores.jsonl`,
`swarm perf` ranks them, and the dashboard's Performance page draws them. It costs a grading
pass per run. Off (the shipped default): no run asks, the tier guide routes models, the
Performance page is disabled. Worth turning on once the operator runs alternative models
often enough for the numbers to mean something. Ask.

### Stage 7b — the leaf context window (`disable1mContext`)

Every Claude leaf can run at the standard 200k context window or the 1M window. Measured on
one plan, byte-identical prompts, sonnet, list prices: the 1M window bought no quality
difference and zero compactions but cost ~45% more ($83.39 vs $57.60) — it is a wall-clock
lever, not a quality one. `true` (the shipped default) keeps every leaf at 200k; `false` gives
every Claude leaf 1M by default. Either way, a task's own `settings` key always wins, so a
manifest can opt one leaf in (or out) regardless of this default. Ask whether they want to pay
more for fewer compactions and faster walls, or keep 200k as the default.

### Stage 7c — the leaf guard (`projects`)

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

### Stage 8 — advanced, only on request

Say once: "the remaining keys are tuning — timeouts, retries, concurrency, quota thresholds,
display cadence, provider plumbing. Want any of them?" If yes, explain only the ones named,
from the appendix. If no, close.

## Appendix — every key, for you

| Key | Default | What it does |
|---|---|---|
| `allowedRoots` | *(unset)* | Stage 2. The root list for EVERY provider, Claude included. Unset = unconfigured, which dispatches nothing; `[]` = denied on purpose, which is a different refusal. |
| `providers.<name>.allowedRoots` | *(unset)* | Narrowing only — intersected with `allowedRoots`, so it can never add or widen a root. Set it when one provider must be held to less than the default. |
| `providers.ollama.url` | `http://localhost:11434` | Ollama endpoint the `:cloud` leaves talk to; pinged before an Ollama run, unreachable = refuse. |
| `providers.ollama.mode` | `env` | `env` = plain `claude -p` with the Ollama endpoint and model injected; `launch` = shell out through `launchCmd`. |
| `providers.ollama.launchCmd` | `ollama launch claude --model {model} -- {args}` | Only in `launch` mode. |
| `providers.ollama.discoverCmd` | `ollama launch claude` | Scraped by the Ollama adapter as a last-resort discovery source. |
| `providers.ollama.catalogUrl` | `https://ollama.com` | Where the Ollama adapter reads the cloud catalogue and recommendations. |
| `providers.ollama.cloudSuffix` | `:cloud` | Which Ollama model names count as cloud tier. |
| `providers.ollama.authToken` | `ollama` | Sent as the API key in `env` mode. Placeholder, not a secret. |
| `providers.ollama.name` | `ollama` | Label only. |
| `providers.ollama.cloud.ollama.enabled` | `false` | Stage 1b. Gates the whole meter: off, `models`/`validate`/`modeFor` never read the cache and the feature is invisible. |
| `providers.ollama.cloud.ollama.cookiePath` | `null` | Stage 1b. Where `ollama-usage --cookie` writes the browser token; falls back to `~/.swarm/ollama-cookie.json` when unset. Never `config.json` itself. |
| `providers.ollama.cloud.ollama.settingsUrl` | `https://ollama.com/settings` | Where the usage fetch reads the meter; a test hook like `quotaUsageUrl`. |
| `providers.ollama.usageTimeoutMs` | `5000` | Bound on the usage fetch; a hung ollama.com times out into the cached reading (banner: `/!\ Fetch Timed Out`) instead of wedging `validate`. |
| `providers.codex.enabled` / `path` / `sandbox` | `false` / `codex` / `workspace-write` | Opt-in Codex app-server provider; model discovery uses `model/list`, and live usage is explicit. |
| `concurrency` | `4` | Ceiling on leaves alive at once (each is a full headless `claude` session). A manifest may run narrower, never wider — asking for more fails `validate`. A rate-limited leaf frees its slot while it backs off. |
| `timeoutMs` | `3600000` | Per-leaf wall clock; past it the leaf is `timeout`, slot freed. |
| `disable1mContext` | `true` | Stage 7b. `false` gives every Claude leaf the 1M context window by default (a wall-clock lever, ~+45% cost, same quality); a task's own `settings` always wins. |
| `retry.rateLimited` / `retry.backoffMs` | `2` / `30000` | Retries after a rate-limit failure, exponential from the backoff; the slot frees while waiting. |
| `retry.spawnError` | `1` | Retries when the leaf process fails to start. |
| `resultInlineCap` | `4000` | Between leaves, during a run: when leaf B's prompt says `{{result:A}}`, the engine pastes A's output text into B's prompt before launching B — up to this many characters, then cuts (flagged on the leaf, in `run.log` and the closing block). `{{resultPath:A}}` pastes the file path instead, uncapped; verifiers must use that. Not the digest — the digest reads every result file from disk after the run. |
| `worktreeBranchPrefix` | `swarm/` | Branch prefix for worktree-isolated leaves. |
| `modelDenylist` | `[]` | Case-insensitive substrings; matching models fail `validate` and vanish from `models`. |
| `notifyCmd` | `null` | Stage 6. |
| `quotaPreflight` | `true` | Before a run with Claude leaves, read Anthropic's usage with Claude Code's own sign-in; refuse when a window is exhausted. |
| `quotaWarnPct` | `80` | Warn once when the worst window is at or past this percent. |
| `quotaCacheSecs` | `300` | How long one usage read is reused. |
| `quotaPatterns` | four strings | Output substrings that classify a failed leaf as quota-hit. |
| `heartbeatSecs` | `15` | Two jobs on one number. The roster is the boxed table the engine prints while a run is live — one row per leaf: state glyph, id, model, elapsed, work tokens, last tool call. It repaints on every leaf event and, so timers and token counts keep moving between events, every this-many seconds — paint cadence for the operator's watch terminal. It is also the engine's liveness signal: it paints a heartbeat file on the same cadence, and `runLiveness`/`status`/`stop` treat a heartbeat older than 3x this value as a dead engine. Raising it slows the roster AND widens the window before a wedged engine is declared dead. |
| `quietWarnSecs` | `60` | A running leaf that has emitted no event (no tool call, no token update) for this long gets `⚠ quiet Ns` in the roster, the statusline and the dashboard. The stall signal — token counts are not. Raise it for models that think in long silent turns. |
| `dashboard.enabled` / `bind` / `token` | `true` / `0.0.0.0` / `null` | Stage 4. |
| `dashboard.port` | `7331` | Listen port; also the firewall rule's port. |
| `dashboard.livenessPollMs` | `10000` | How often the server re-checks which runs are live and tells connected browsers. Two things produce no filesystem event and are only ever caught by this clock: a run finishing (its `summary.json` lands in a path nothing watches) and an engine dying. It also rebuilds file watchers, so one that silently stops delivering recovers instead of leaving the page deaf until a manual refresh. Ticks only while a dashboard is actually open — nothing runs with no client connected. Lower it for a snappier list at the cost of more directory scans. |
| `dashboard.finishedPerProject` | `10` | How many finished runs each displayed project keeps on the runs list, newest first. A repo and its worktree keys are one group — the cap is per displayed project, not per run directory — and a truncated section header reads `N of M finished`. A `Show all N` row at the foot of an expanded stack fetches that project in full when you want the rest. |
| `dashboard.autoRestartOnUpdate` | `true` | A running daemon hands the port to a shim-started replacement when the installed version moves; `false` reports the mismatch instead — `status` and `doctor` show the running version as stale, `serve restart` applies it by hand. |
| `dashboard.tray` | `true` | Windows only: the tray icon, titled `swarm`, that polls the pid record so it follows the daemon across restarts and re-execs — Open dashboard / Restart / Stop, the running version, and a status line. With `dashboard.enabled: false` it still appears, in its disabled state: `Open dashboard (Disabled)` greyed, `Enable dashboard` in place of Stop. `false` spawns no tray at all. |
| `swarm.always` | `false` | Stage 3. |
| `swarm.workflowNudge` | `true` | One-time "consider swarm" on the first `Workflow` call of a session on an armed machine. |
| `grading.enabled` | `false` | Stage 7. |
| `projects` | `[]` | Stage 7c. Array of `{ name, hooks: { preToolUse } }`: the repo's own PreToolUse hook for leaves whose repo root basename matches `name`; payload on stdin, exit 0 allows, exit 2 denies with stderr, anything else denies (fail-closed); probed once at `validate`; `"leafGuard": false` opts a task out. |

## Common mistakes

- **Printing the appendix at the operator.** Observed 2026-09-05: a session dumped every key
  with its value in one message and then asked four questions at once — "you just bombed me
  with a list of settings without telling me what they do". Stages, one at a time.
- **Editing `config.default.json`** — lost on the next plugin update. Only `~/.swarm/config.json` persists.
- **Setting a key from a remark** ("I suppose C:/code is fine") — ask, then write what the operator said.
- **Skipping `config init` after a plugin update** — new keys stay invisible; the engine still uses their defaults, but the operator never sees them.
- **Adding a root to `allowedRoots` that is not cleared to leave** — for a non-Anthropic provider the gate exists for the data agreement; explain that before asking.
