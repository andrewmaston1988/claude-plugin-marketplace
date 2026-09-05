# swarm — alternative-model fan-out engine

A Claude Code session authors a JSON manifest (the same authoring act as writing a Workflow script); the swarm engine dispatches each task via CLI — capable `:cloud` models (GLM, MiniMax, qwen, …) through your provider, Claude models via plain `claude -p` — runs the dependency graph in the background, and compresses results through a digest stage so the session never swallows raw output.

The widest shape is **quality from group-think**: many independent perspectives, redundant attempts, diverse-lens judging — near-opus-swarm quality from capable alternative models on an alternative subscription, delivered at interactive speed. But the manifest is a dispatch surface, not a fan-out surface: one delegated leaf is a first-class use, and phased chains run several leaves in sequence on one shared branch. The smarts live in the plan and the leaves; the plumbing has none.

## Positioning

- **Workflow** — Claude Code's built-in orchestration tool: Claude-quality agents scripted in JS, inside the harness. Fast, Claude-priced.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **swarm** — interactive-speed group-think on capable alternative models.

Compose freely — a pipeline dev session or a Workflow plan may use swarm as its alternative-model leaf executor.

### Swarm vs Workflow, honestly

The structural split: a swarm manifest is a **static, previewable plan** — every model and leaf enumerable in one approval, simple enough for a weak model to author — while a Workflow script is **imperative orchestration** reviewed as code, with the full power and full cost that implies. Neither dominates; here is the real shape of the trade.

| | swarm | Workflow |
|---|---|---|
| ***Parity — either tool does these well*** | | |
| Parallel fan-out — concurrency caps, dependency ordering, pipelining | ✅ | ✅ |
| Per-agent model + effort selection | ✅ | ✅ |
| Worktree isolation for write-capable agents | ✅ | ✅ |
| Full headless Claude Code agents — complete tool roster | ✅ | ✅ |
| Deterministic mid-run steps — fan out over a discovered list, gate, dedupe/count | ✅ `forEach`/`when`/`compute` | ✅ full JS |
| Schema-validated output — corrective retry on mismatch | ✅ `returns` | ✅ `agent({schema})` |
| One-level composition — a reusable sub-pipeline as one node | ✅ `manifest` tasks | ✅ `workflow()` |
| ***Workflow's ground*** | | |
| Zero setup — runs anywhere Claude Code does | ❌ needs a provider endpoint | ✅ |
| Results return in-conversation | ⚠️ files + digest | ✅ |
| Session-connected MCP tools inside agents | ❌ | ✅ |
| Unbounded control flow — loops, budget-reactive spawning, arbitrary JS | ❌ by design | ✅ |
| Custom agent types | ❌ | ✅ |
| ***Swarm's ground*** | | |
| Alternative models — GLM, MiniMax, Kimi, … | ✅ core purpose | ❌ Claude only |
| Data-governance gate — open models deny-by-default outside allow-listed roots | ✅ | — |
| Durable runs — on-disk results, resume from any session | ✅ | ⚠️ same session |
| Interrogation — ask a finished agent a follow-up, its context intact | ✅ `ask` | ❌ |
| Self-healing — backoff retries, declared fallbacks, quota preflight | ✅ | ❌ |
| Live observability — per-agent roster, tokens/cost, hang warnings | ✅ | ⚠️ coarser |
| Predictive cost consent — estimate at approval, one projection warn, actual-vs-estimate close | ✅ | ❌ reactive only |
| Weak-model authorability — fill-in-the-blanks JSON; validation errors teach | ✅ | ⚠️ JS bar |
| Mechanical citation verification — `{file, line, quote}` returns string-matched against real files before any verifier spawns | ✅ zero tokens | ❌ |

Rule of thumb: bounded fan-out breadth — investigation sweeps, judge panels, generation, mechanical implementation sweeps, and now discover-then-map pipelines — is swarm's shape, especially when alternative models are armed. Reach for Workflow when the orchestration itself needs unbounded loops, session MCP tools, or budget-driven control flow — or when you simply want zero setup.

## Setup

Run `/swarm:swarm setup` in a session — it materialises every key into `~/.swarm/config.json` (`node plugins/swarm/scripts/swarm.mjs config init`), explains each one, and edits the ones you name. The shipped `config.default.json` is overwritten on every plugin update, so your own file is the only durable copy; re-run `config init` after an update to pick up new keys. The one key you must set to arm alternative models:

```json
{
  "provider": {
    "allowedRoots": ["C:/personal-projects"]
  }
}
```

**Why `allowedRoots` exists (data governance).** Your organisation may have a data agreement with Anthropic but not with other model providers. Non-Claude dispatch is therefore **deny-by-default**: an open-model task whose effective `cwd` is not under a listed root fails validation with the governance reason. With the default `[]`, swarm still runs fine with Claude models — the alternative-model path simply never arms. List only roots whose code is cleared to leave for your provider.

Other useful keys (defaults shown in `config.default.json`): `provider.url` (Anthropic-format endpoint, default `http://localhost:11434` for a direct ollama setup), `provider.mode` (`"env"` merges `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` into a plain `claude -p` call — the default; `"launch"` shells out via `launchCmd`), `concurrency`, `timeoutMs`, `worktreeBranchPrefix`, `modelDenylist` (case-insensitive substrings — matching models fail validation and never appear in the `models` roster; for taking a model out of circulation on quality grounds). Swarm never manages credentials — auth is your provider app's ambient sign-in.

Requirements: Node, `claude` on PATH, and (for `:cloud` models) an ollama install recent enough to serve `/api/experimental/model-recommendations` (~v0.23+).

## Usage

```bash
node plugins/swarm/scripts/swarm.mjs models              # discover launchable :cloud models + Claude aliases — run first
node plugins/swarm/scripts/swarm.mjs list                # saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
node plugins/swarm/scripts/swarm.mjs validate <plan.json | name> [--args '<json>'] [--resolved]  # lint ids, deps, template refs, governance roots, effort pairs, forEach/when/compute shapes + expressions
node plugins/swarm/scripts/swarm.mjs run <plan.json | name> [--args '<json>']    # execute; designed for Bash run_in_background
node plugins/swarm/scripts/swarm.mjs ask <resultsDir> <leaf-id> "follow-up?"   # interrogate a finished leaf
node plugins/swarm/scripts/swarm.mjs quota                # Anthropic utilization per limit window
node plugins/swarm/scripts/swarm.mjs grade --init <resultsDir>   # write grades.json — one skeleton row per :cloud leaf
node plugins/swarm/scripts/swarm.mjs grade --file <grades.json>  # validate the filled batch and append it to the score store
node plugins/swarm/scripts/swarm.mjs perf [--aspect X] [--model Y] [--domain D]   # aspect x model table with sample counts
```

A bare name resolves through the manifest registry (`<cwd>/.swarm/manifests/<name>.json`, then `~/.swarm/manifests/`; the resolution is always announced). `--args` fills `{{args.*}}` placeholders — `validate --resolved` prints the fully substituted document as the approval preview, and each distinct args value gets its own fingerprinted results dir so resume never crosses parameterizations.

In a session, the **swarm** skill drives this end-to-end: it drafts the manifest, shows it in an AskUserQuestion box (the preview is the approval — every model and leaf visible before anything runs) — or, with `swarm.always`, states it and runs — runs in the background, and reads only `digest.md` when the run completes.

## Model discovery

Discovery covers the **ollama cloud catalog only**. `models` unions the curated recommendations endpoint with the full `/api/tags` catalog (either source failing is non-fatal), derives `:cloud` names from bare tags, validates and enriches each candidate free via the daemon's `/api/show` (capabilities, context length, parameter count), and prints the roster largest-first — `glm-5.2:cloud — Frontier open model (756B, 1.0M ctx)`. The Claude tiers (`haiku`/`sonnet`/`opus`) are a static always-available alias list appended after the discovered set — they are not discovered, and no non-ollama provider ever is.

Model families collapse: an entry superseded by a strictly-newer same-lineage sibling (`glm-5.1` next to `glm-5.2`) is hidden behind it, with a dim footer counting the hidden rows; `swarm models --all` shows them marked `[superseded by …]`. When a superseder drops out of the roster — denylisted, or removed by the entitlement probe — its elder resurfaces automatically.

Entitlement is handled by removal, not annotation: each `models` refresh fires a one-token probe at the top 3 visible cloud entries (a removal cascades to whichever entry resurfaces into the slice, capped at six probes total), and a 402 "extra usage" rejection removes that row from `~/.swarm/models-cache.json` (the same removal happens lazily when a live dispatch fails with that body). The roster then simply doesn't offer the model, and the next refresh restores it once the account can run it again. The cache keeps the full roster — the denylist and supersession hiding are display filters, applied identically by the CLI and by the ultraswarm hook's model list.

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

## Deterministic steps — forEach / when / compute

The glue logic between agent calls that never needed an LLM, without making the manifest a programming language. Every leaf stays enumerable at approval time — `validate` prints the worst-case leaf count the caps permit.

```json
{ "tasks": [
    { "id": "find-sites", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: {\"sites\":[…]}" },
    { "id": "dedupe", "after": ["find-sites"], "compute": "unique_by(deps['find-sites'].sites, 'file')" },
    { "id": "fix", "after": ["dedupe"], "forEach": { "from": "dedupe", "path": "", "maxItems": 30 },
      "model": "glm-5.2:cloud", "isolation": "worktree", "prompt": "Fix {{item.file}}:{{item.line}}" },
    { "id": "escalate", "after": ["fix", "dedupe"], "when": { "from": "dedupe", "expr": "length(value) > 20" },
      "model": "sonnet", "prompt": "…{{result:fix}}…" }
  ] }
```

- **`forEach`** clones a template leaf at runtime over a dependency's JSON array — the "discover a work-list, then map over it" shape that previously forced a manual second wave. `maxItems` is **required**: the cap is the approval. Clones (`fix[0]`, `fix[1]`, …) are full tasks — own result, tokens row, retry budget, `fallbackModel`, `ask` session — and dependents of the parent wait for all of them (`{{result:fix}}` = JSON array of clone outputs). Overflow is loud: a `truncated` field in the parent result, a run.log event, and a closing-block warning — a capped run never reads as full coverage.
- **`when`** gates a leaf on a dependency's output — false means the task completes as `skipped` (dependents still run). The expression must yield true/false; a bare value is a validation-time teaching error.
- **`compute`** is an agentless expression step (dedupe / filter / count / threshold / flatten) over dependency JSON — zero tokens, result consumable like any leaf's. No `eval`, no external `jq`: a hand-rolled, bounded evaluator (`length`, `count`, `filter`, `unique_by`, `flatten`, `min/max/sum`, `contains`; comparisons and boolean logic; 500-char cap), because manifests may themselves be model-authored and the trust boundary stays tight.

## Widening after a narrow step — `isolation.from` and `integrate`

Private trees branch from repo HEAD and never see each other's commits, so a fan-out that follows a shared step needs two things the engine now supplies: a way to start from that step's work, and a way to fold the results back.

```json
{ "tasks": [
    { "id": "helper", "model": "glm-5.2:cloud", "isolation": { "worktree": "feat" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…write the helper. Commit before you finish." },

    { "id": "migrate-x", "model": "glm-5.2:cloud", "after": ["helper"],
      "isolation": { "worktree": "migrate-x", "from": "helper" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…Commit before you finish." },
    { "id": "migrate-y", "model": "glm-5.2:cloud", "after": ["helper"],
      "isolation": { "worktree": "migrate-y", "from": "helper" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…Commit before you finish." },

    { "id": "join", "after": ["migrate-x", "migrate-y"],
      "integrate": { "into": "feat", "from": ["migrate-x", "migrate-y"] } },

    { "id": "cleanup", "model": "glm-5.2:cloud", "after": ["join"],
      "isolation": { "worktree": "feat" }, "prompt": "…resolve {{result:join}}, run the suite. Commit." }
  ] }
```

Width goes `1 → 2 → 1`: `migrate-x` and `migrate-y` run concurrently in private trees that already contain `helper`'s commit, then `join` merges both branches into the `feat` tree and `cleanup` carries on from the combined state.

- **`integrate`** is an agentless node like `compute` — it spends nothing. It merges each named task's branch into the `into` worktree, creating that tree if the chain has not reached it yet.
- **A conflict is not a failure.** The merge stops with markers left in the tree, the node stays `ok`, and the conflicting paths land in its result — pass `{{result:join}}` to the next leaf and tell it to resolve them. Failing the node instead would turn an ordinary merge conflict into a dead run needing rescue; the next link is a model that can read markers.

## Results layout

```
<resultsDir>/                # default ~/.swarm/runs/<encoded-cwd>/<stem>-<n>/ — outside the repo
  manifest.json              # the effective plan at dispatch (args substituted) — runs record their own intent
  results/<id>.json          # { id, model, ok, exit, durationMs, tokens?, costUsd?, numTurns?, sessionId?, prompt?, cwd, allowedTools, output, outputJson?, citations?, worktree? }
  results/<id>.log           # the leaf's raw stream-json events — tail one leaf's tool calls live
  digest.md                  # when a digest block is present — read this, not the raw results
  summary.json               # { started, finished, tasks: [...], blocked: [], worktreesKept: [], totalTokens }
  run.log                    # JSONL — state changes, live token ticks, run-start roster — tailable mid-run
```

`isolation` is either the string `"worktree"` — a private tree keyed by the leaf's own id, the fan-out shape where clones must not collide — or an object carrying up to three keys:

| Key | Effect |
|---|---|
| `worktree` | Every leaf naming this name meets in **one** tree on one branch, so an ordered chain accumulates: phase 1 commits, a read-only reviewer sees those commits, phase 2 builds on them. Links sharing a name must be totally ordered by `after`, and `forEach` cannot share a tree. |
| `branch` | Names the branch explicitly instead of deriving it from the worktree name (default `swarm/<worktree>`) — for continuing work onto a branch that already exists. |
| `from` | Bases this tree on **that task's branch tip** instead of repo HEAD, so the leaf starts holding the code it builds on. The named task must be a declared dependency, worktree-isolated, and able to WRITE (a read-only task commits nothing, so it owns no branch); a `forEach` parent is rejected, since its clones own the branches. |

`worktreesKept` in `summary.json` carries one entry per shared group — `{ id, name, branch, path, diffstat, taskIds }`, its diffstat spanning every phase — not one per task. A branch carrying commits not yet landed (compared by patch, so squash-merges count as landed) is never deleted or force-reset; the engine refuses rather than lose it.

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

## Model capability scores

Which model to use for what is otherwise decided by remembered incidents. `grade` records what a run's `:cloud` leaves actually did; `perf` reads it back. Opt-in: `"grading": { "enabled": true }` in `~/.swarm/config.json` makes every run's closing block ask for grades; off (the default) nothing asks, `grade`/`perf` still answer by hand, and the dashboard greys its Performance page.

The agent that authored the manifest grades it — it is the only party that knows what each leaf was *asked* for, which the digest does not hold. Claude tiers produce no rows: their capability is not what is in question.

```bash
node plugins/swarm/scripts/swarm.mjs grade --init <resultsDir>   # → <resultsDir>/grades.json, one row per :cloud leaf
# fill in session, and per row: domain, outcome, note, grades
node plugins/swarm/scripts/swarm.mjs grade --file <resultsDir>/grades.json
node plugins/swarm/scripts/swarm.mjs perf --aspect search --domain godot
```

**Ten aspects, graded 1-10.** Four are graded on every leaf; six only where the leaf stressed them, and stay `null` otherwise. They co-occur freely — a leaf that reads reference images and then designs geometry from them has no single primary act.

| | aspect | the question |
|---|---|---|
| **universal** | `adherence` | did the asked job without wandering, inventing work, or ignoring a stated constraint |
| | `handoff` | could the next agent act on the output without coming back for more |
| | `truthfulness` | were its assertions actually so, or fabricated |
| | `depth` | did the real work, or produce a plausible-looking shell |
| **capability** | `discrimination` | right call at the right severity — real separated from noise |
| | `code` | understood the code it had to work in |
| | `search` | went after the right thing, and kept at it until it surfaced |
| | `web` | operated the web-search tools competently |
| | `vision` | interpreted an image correctly |
| | `geometry` | proportion, structure and layout came out right |

**`domain`** is one lowercase token on every row naming the language or ecosystem the leaf worked in — `godot`, `rust`, `node`, `python`, `docs`. A field, not a category, so adding an ecosystem costs nothing and never closes the list — but it is not the repo and not the task: `this-repo`, `rust+plans` and the like are refused, because nothing decomposes them back into a domain a query can ask for.

**`outcome`** is separate from the grades, because a 1-10 cannot say "the session died": `completed | wrong | failed | timeout | session-died | not-capable`. The first two require grades; the rest **forbid** them — you cannot grade a report that was never submitted, and averaging a number that describes nothing buries the outcome. `not-capable` is the useful one: it records that the model could not do the thing *on this harness*, which is often not what its catalogue entry claims.

Each row also snapshots the mechanical columns from the leaf's result (`ok`, `durationMs`, `tokens`, `numTurns`, citation counts) and the model's declared `capabilities`/`contextLength`/`parameterCount` from `models-cache.json`. Those make a grade auditable; they never replace one — `numTurns` cannot separate three turns doing the wrong thing from thirty being thorough.

**Store:** `~/.swarm/model-scores.jsonl`, append-only, one line per graded leaf. Line-atomic, so concurrent runs cannot corrupt it, and no run dirties the repo. Re-grading a run replaces its rows rather than double-weighting the model: the newest row per `(resultsDir, leaf)` wins.

**Reading `perf`.** Retrievable aggregated scores, per aspect × model. Every cell shows its sample count `n`, the raw `mean`, and a `wtd` score that cells rank on — the mean weighted for how much evidence stands behind it, so a single lucky leaf cannot head the table. `n < 5` is marked provisional, and an aspect with no rows prints at `n=0` rather than being omitted: absence is evidence.

## Dashboard — the swarm estate on your phone

A read-only LAN web page over `~/.swarm/runs`: every project's runs, the live roster of a run drawn as its own topology (a git-graph rail from the manifest's `after` edges and the `expand` / `expand-manifest` events — one lane per parallel leaf, fan-in into dependents, digest at the foot), a leaf's place in the graph plus its timing, tokens, activity and output, and a finished run's digest or report rendered through the same converter as `report`. Waves collapse to one row with a dot strip; `forEach` parents and nested manifests open into their members. Live over server-sent events; the running ring spins on the rail.

The menu also opens **Performance**: the model score store (`~/.swarm/model-scores.jsonl`) ranked exactly as `swarm perf` ranks it — the maths is `scores.mjs`, the page only draws. One ranking list serves every table: overall (mean of the four universal weighted scores) with a chip per aspect, a domain filter, and a tap on a model for its per-aspect breakdown. A provisional cell (n<5) draws its bar dashed and says so; a model with no grades shows its outcomes only. Re-read when the store's mtime moves, so a grade landing between requests shows on the next tap.

```bash
node plugins/swarm/scripts/swarm.mjs serve --daemon        # detached; pid ~/.swarm/dashboard.pid, log ~/.swarm/dashboard.log
node plugins/swarm/scripts/swarm.mjs serve                 # foreground
node plugins/swarm/scripts/swarm.mjs serve status | stop
node plugins/swarm/scripts/swarm.mjs serve install-autostart   # Startup-folder launcher (Windows); uninstall-autostart removes it
```

On start it prints `http://<hostname>.local:<port>/` (phones resolve `.local` on the LAN without a static IP), every LAN IPv4, and the one-time elevated firewall rule for the port — printed, never run. Add to home screen from the phone browser: the page ships a web manifest and an `apple-touch-icon`; the icon PNGs it references are rendered by the server itself (`/icon-180.png`, `/icon-192.png`, `/icon-512.png`). On plain LAN HTTP there is no service worker (browsers require a secure context), so Android gets a bookmark-style icon and no install prompt; iOS "Add to Home Screen" opens it standalone.

Config keys under `dashboard` in `~/.swarm/config.json` (defaults in `config.default.json`): `enabled` (true; `false` makes `serve` and `serve --daemon` print "disabled" and exit 0, so an installed Startup launcher becomes a no-op — `stop`, `status` and the autostart verbs still work), `port` (7331), `bind` (`0.0.0.0`), `token` (when set, every request needs `?t=<token>` — bookmark the URL with it), `recentMs` (a run whose `run.log` is older than this and has no `summary.json` is listed as stale, not live; the statusline glyph uses the same window).

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

`"swarm": { "always": true }` in `~/.swarm/config.json` is standing consent: the swarm skill runs its full ceremony (orchestrating-agents, executing-swarms, `models`, `validate`) and then dispatches on a printed gate statement instead of an AskUserQuestion. A `SessionStart` hook (re-injected after `/clear` and compaction) announces it in a short `<EXTREMELY_IMPORTANT>` block carrying one mode bracket — `[:cloud tier preferred]` when the session's cwd is under a `provider.allowedRoots` entry, `[Anthropic orchestration only]` otherwise, decided the same way the governance gate decides it. The keyword **`ultraswarm`** in a prompt injects the same block for that session without the config flag. Silent otherwise; no model list — the skill's own `models` step discovers what is launchable.

## Workflow nudge

A `PreToolUse` hook on the **Workflow** tool: when alternative models are armed (`provider.allowedRoots` non-empty), the first Workflow call of a session is intercepted with a "consider swarm instead" reason — retrying Workflow passes straight through, and the reminder never repeats within the session. A speed bump, not a wall. Silent on unarmed machines and in pipeline child sessions; disable with `"swarm": { "workflowNudge": false }`.
