# swarm — alternative-model fan-out engine

A Claude Code session authors a JSON manifest (the same authoring act as writing a Workflow script); the swarm engine dispatches each task via CLI — capable `:cloud` models (GLM, MiniMax, qwen, …) through your provider, Claude models via plain `claude -p` — runs the dependency graph in the background, and compresses results through a digest stage so the session never swallows raw output.

The product is **quality from group-think**: many independent perspectives, redundant attempts, diverse-lens judging — near-opus-swarm quality from capable alternative models on an alternative subscription, delivered at interactive speed. The smarts live in the plan and the leaves; the plumbing has none.

## Positioning

- **Workflow** — Claude Code's built-in orchestration tool: Claude-quality agents scripted in JS, inside the harness. Fast, Claude-priced.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **swarm** — interactive-speed group-think on capable alternative models.

Compose freely — a pipeline dev session or a Workflow plan may use swarm as its alternative-model leaf executor.

### Swarm vs Workflow, honestly

The structural split: a swarm manifest is a **static, previewable plan** — every model and leaf enumerable in one approval, simple enough for a weak model to author — while a Workflow script is **imperative orchestration** reviewed as code, with the full power and full cost that implies. Neither dominates; here is the real shape of the trade.

**Where they're equivalent** — either tool does these well:

- Parallel fan-out with a concurrency cap, dependency ordering, and per-item pipelining
- Per-agent model and effort selection
- Git-worktree isolation for write-capable agents
- Agents as full headless Claude Code sessions with the complete tool roster

**Where Workflow is stronger:**

- **Deterministic mid-run logic** — loops, dedupe-between-stages, vote thresholds, dynamic fan-out over a discovered list, in real JS. Swarm's DAG is static; its answer is the multi-wave pattern with the session as the judgment between waves. (A bounded declarative subset — `forEach`/`when`/`compute` — is planned, but full scripting stays Workflow's.)
- **Zero setup** — built into the harness; no provider, no config, works everywhere Claude Code runs. Swarm's alternative models need an ollama-style endpoint and explicit `allowedRoots` opt-in.
- **In-conversation results** — `agent()` returns a value (optionally schema-validated with retry) straight into the orchestrating logic; swarm communicates through result files and a digest.
- **Session-connected MCP tools** inside agents, and **budget-reactive control flow** (`budget.remaining()` loops) — both structurally out of reach for headless leaves.
- **Composition** — nested `workflow()` calls and custom agent types.

**Where swarm is stronger:**

- **Alternative-model execution** (GLM, MiniMax, Kimi, …) with a **data-governance gate** — open models are deny-by-default outside allow-listed directory roots.
- **Durability** — results live on disk; re-`run` resumes any time, from any session, skipping completed work. Workflow's resume is same-session.
- **Interrogation** — `ask` resumes a finished leaf with its context intact for one-turn follow-ups, even days later; Workflow agents end with their run.
- **Self-healing** — rate-limit backoff retries, manifest-declared model fallbacks, quota as a first-class state with predictive preflight and reset times.
- **Accounting and visibility** — per-leaf tokens/cost in every result, live roster with elapsed, climbing token counts, current tool call, and hang warnings.
- **Authorability** — a fill-in-the-blanks manifest that a small model can draft reliably; correct imperative orchestration code is a much higher bar.

Rule of thumb: bounded fan-out breadth — investigation sweeps, judge panels, generation, mechanical implementation sweeps — is swarm's shape, especially when alternative models are armed. Reach for Workflow when the orchestration itself needs mid-run logic, session MCP tools, or budget-driven loops — or when you simply want zero setup.

## Setup

Create `~/.swarm/config.json` to override any key in `config.default.json`. The one key you must set to arm alternative models:

```json
{
  "provider": {
    "allowedRoots": ["C:/personal-projects"]
  }
}
```

**Why `allowedRoots` exists (data governance).** Your organisation may have a data agreement with Anthropic but not with other model providers. Non-Claude dispatch is therefore **deny-by-default**: an open-model task whose effective `cwd` is not under a listed root fails validation with the governance reason. With the default `[]`, swarm still runs fine with Claude models — the alternative-model path simply never arms. List only roots whose code is cleared to leave for your provider.

Other useful keys (defaults shown in `config.default.json`): `provider.url` (Anthropic-format endpoint, default `http://localhost:11434` for a direct ollama setup), `provider.mode` (`"env"` merges `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` into a plain `claude -p` call — the default; `"launch"` shells out via `launchCmd`), `concurrency`, `timeoutMs`, `worktreeBranchPrefix`. Swarm never manages credentials — auth is your provider app's ambient sign-in.

Requirements: Node, `claude` on PATH, and (for `:cloud` models) an ollama install recent enough to serve `/api/experimental/model-recommendations` (~v0.23+).

## Usage

```bash
node plugins/swarm/scripts/swarm.mjs models              # discover launchable :cloud models + Claude aliases — run first
node plugins/swarm/scripts/swarm.mjs validate plan.json  # lint ids, deps, template refs, governance roots, effort pairs
node plugins/swarm/scripts/swarm.mjs run plan.json       # execute; designed for Bash run_in_background
node plugins/swarm/scripts/swarm.mjs ask <resultsDir> <leaf-id> "follow-up?"   # interrogate a finished leaf
node plugins/swarm/scripts/swarm.mjs quota                # Anthropic utilization per limit window
```

In a session, the **swarm** skill drives this end-to-end: it drafts the manifest, shows it in an AskUserQuestion box (the preview is the approval — every model and leaf visible before anything runs), runs in the background, and reads only `digest.md` when the run completes.

## Example manifest

```json
{
  "resultsDir": null,
  "tasks": [
    {
      "id": "auth",
      "model": "minimax-m3:cloud",
      "prompt": "Your single job: where is session token expiry enforced?\nFile scope: src/auth/**\nReturn your findings as ≤10 bullet points: name, file path, line number, one-line description. No prose. If you cannot find the answer, say so in one line — do not expand scope."
    },
    {
      "id": "session",
      "model": "minimax-m3:cloud",
      "prompt": "Your single job: how are sessions persisted and evicted?\nFile scope: src/session/**\n(same return contract)"
    },
    {
      "id": "verdict",
      "model": "sonnet",
      "effort": "high",
      "after": ["auth", "session"],
      "prompt": "Read {{resultPath:auth}} and {{resultPath:session}}. Do the expiry and eviction paths agree? Return a verdict with file:line evidence."
    }
  ],
  "digest": {
    "model": "glm-5.2:cloud",
    "instructions": "must_be_sure: the expiry enforcement point. PROVEN/OPEN ledger required."
  }
}
```

## Results layout

```
<resultsDir>/                # default ~/.swarm/runs/<encoded-cwd>/<stem>-<n>/ — outside the repo
  results/<id>.json          # { id, model, ok, exit, durationMs, tokens?, costUsd?, numTurns?, sessionId?, cwd, allowedTools, output, outputJson?, worktree? }
  results/<id>.log           # the leaf's raw stream-json events — tail one leaf's tool calls live
  digest.md                  # when a digest block is present — read this, not the raw results
  summary.json               # { started, finished, tasks: [...], blocked: [], worktreesKept: [], totalTokens }
  run.log                    # JSONL — state changes, live token ticks, run-start roster — tailable mid-run
```

Leaves are dispatched with `--output-format stream-json`, so the engine extracts each leaf's final text into `output` and its per-turn API usage into `tokens` (`{ input, output, cacheCreation, cacheRead }`). A provider that emits plain text instead degrades gracefully: raw stdout becomes `output` and the token columns stay empty.

Stdout repaints a full **roster snapshot** on every task state change and on a heartbeat (`heartbeatSecs`, default 15): one row per task — glyph, id, model, duration (elapsed ticks live for running leaves), work tokens (input + output + cache writes; live counts climb as turns complete) — plus a counts footer with the run total. Running rows also show the leaf's **latest tool call** (`◐  map-rest … 12.4k  Grep client/scripts/ui`); a leaf silent for more than `quietWarnSecs` (default 60) shows `⚠ quiet Ns` instead — hangs surface in a minute, not at the timeout. On a TTY the snapshot redraws in place; piped output appends plain-text snapshots so the tail of the buffer is always the current picture, and `NO_COLOR` is honoured. After the roster, a closing block: digest path, summary path, total tokens, kept worktrees — never raw task output. Failed tasks block their dependents; independent branches continue; re-`run` resumes (completed work is skipped, `rate-limited` tasks retry).

`status <resultsDir>` renders the same roster read-only from `run.log` (add `--watch` for live repaint in a second terminal).

## Interrogating a leaf

Every leaf's Claude Code session id is captured in its result JSON. `ask` resumes that session with a follow-up question — the leaf already holds its file reads and reasoning in context, so a drill-down costs one turn instead of a re-run:

```bash
node plugins/swarm/scripts/swarm.mjs ask <resultsDir> census-edges "show the exact preload line you cited"
```

The resume runs with the leaf's own model, cwd, and tool allowlist (a read-only leaf stays read-only). Q/A history appends to `results/<id>.ask.log`, and each follow-up continues the same conversation thread. `--model <m>` re-asks on a different model — subject to the same `allowedRoots` governance gate as dispatch. Leaves that ran in a since-removed worktree can't be resumed; `ask` says so rather than guessing.

## Self-healing runs

Transient failures recover in-run; temporal ones fail fast with the recovery named:

- **Rate limits** retry with exponential backoff (`retry.rateLimited`, default 2 attempts from `retry.backoffMs` 30s) — the leaf shows `↻ retry 2/3 in 45s` and its concurrency slot frees during the wait. Spawn errors get one quick retry. Timeouts never auto-retry (a too-big leaf costs double for the same outcome — rescope and resume instead).
- **`fallbackModel`** (per task) is the only substitution the engine will ever make — declared in the manifest you approved, validated against `allowedRoots` at load time like any dispatch target. Quota exhaustion switches to it immediately; rate limits switch after retries exhaust. The switch is logged (`↯ fallback → glm-5.2:cloud`) and recorded in run.log.
- **Quota is a first-class state** (`⏳`), distinct from rate limits: Anthropic usage exhaustion is temporal (hours), so instead of retrying, the run parses the reset time into the result and closing block, and the first Claude leaf to hit the wall pre-emptively marks every still-pending undefended Claude leaf `quota` — one failure, one lesson, no wasted dispatches. Re-running after reset skips all `ok` work.
- **Quota preflight**: when a plan contains Claude leaves, the engine first queries Anthropic's usage endpoint with Claude Code's own local OAuth credentials (free, predictive — utilization % and reset times per window, cached `quotaCacheSecs`). Exhausted quota with undefended Claude leaves aborts *before* dispatch with the leaf list and reset time; ≥`quotaWarnPct` (80) warns and proceeds. Strictly best-effort — any endpoint failure and the run proceeds; mid-run classification is the backstop. Disable with `"quotaPreflight": false`; `quotaPatterns` extends message matching without a plugin update.

`swarm quota` prints the same utilization table on demand — useful before choosing a model mix.

## Statusline segment

Live progress of the most recent run in the Claude Code status bar — `🐝 5✓ 2▶ 1⧖ 160k` (state counts plus the run's work-token total) — appended to your existing statusLine command:

```bash
node "<abs-path-to>/swarm/statusline/swarm-glyph.mjs"
```

Shows nothing when no run has been active in the last 30 minutes; never errors.

## Completion notification

Set `notifyCmd` in `~/.swarm/config.json` to fire a command when a run finishes (tokens: `{status}`, `{digest}`, `{summary}`) — e.g. ping yourself via the slack-bridge plugin:

```json
{ "notifyCmd": "claude-slack notify --message \"{status} — digest: {digest}\"" }
```

Fire-and-forget: spawned detached, errors swallowed, never affects the run's exit code.

## The CLAUDE.md nudge

Make offering swarm a standing habit by adding one line to your CLAUDE.md:

```markdown
**When a request decomposes into ≥3 independent bounded leaves**: offer to fan it out via the swarm skill — AskUserQuestion with the draft manifest as the preview — before working inline.
```

## Ultraswarm standing mode

The plugin ships a `UserPromptSubmit` hook that is silent by default. It activates when:

- a prompt contains the keyword **`ultraswarm`**, or
- `~/.swarm/config.json` sets `"swarm": { "always": true }`.

When active it injects standing instructions to propose a swarm manifest via the question box for every substantive task, including the cached model list from the last `models` discovery so offers name real, launchable models.

## Workflow nudge

A `PreToolUse` hook on the **Workflow** tool: when alternative models are armed (`provider.allowedRoots` non-empty), the first Workflow call of a session is intercepted with a "consider swarm instead" reason — retrying Workflow passes straight through, and the reminder never repeats within the session. A speed bump, not a wall. Silent on unarmed machines and in pipeline child sessions; disable with `"swarm": { "workflowNudge": false }`.
