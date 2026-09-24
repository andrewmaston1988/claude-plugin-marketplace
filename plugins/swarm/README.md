# swarm — alternative-model fan-out engine

A Claude Code session authors a JSON manifest; swarm dispatches each task via the enabled
provider registry — capable Ollama `:cloud` models, opt-in Codex app-server models, or Claude
models via plain `claude -p` — runs the dependency graph in the background, and compresses
results through a digest so the session never swallows raw output.

Widest shape: **quality from group-think** — many independent perspectives, redundant
attempts, diverse-lens judging, near-opus quality on alternative models at interactive
speed. But a manifest also works for one delegated leaf, or a phased chain of several
leaves in sequence on one shared branch — the plumbing is the same either way.

## Setup

```bash
/swarm:swarm setup   # writes ~/.swarm/config.json, explains every key, edits what you name
```

The shipped `config.default.json` is overwritten on every plugin update — your own config
is the only durable copy; re-run `swarm config init` after an update to pick up new keys.

The key you must set to arm dispatch at all:

```json
{ "allowedRoots": ["C:/personal-projects"] }
```

One list, every provider — Claude included. `providers.<name>.allowedRoots` still exists, but it
only NARROWS the top-level list (the two are intersected), so a provider entry can never add a
root or widen one.

Provider identity is canonical under `providers`; legacy provider-shaped config is read for
compatibility and does not change the public manifest identity.

**Why (data governance):** your org may have a data agreement with Anthropic but not with
other model providers, so non-Claude dispatch is **deny-by-default** — a task whose
effective `cwd` isn't under a listed root fails validation. With no list configured, nothing
dispatches until `swarm setup` writes one; list only roots cleared to leave for your provider.

Every other key (`providers.<name>.*`, `concurrency`, `timeoutMs`,
`worktreeBranchPrefix`, `modelDenylist`, `providers.ollama.cloud.ollama.*`, `notifyCmd`,
`grading.enabled`, `dashboard.*`, `swarm.always`) is documented inline in
`config.default.json` with its default — `setup` walks the ones worth touching. Swarm
never manages credentials; auth is your provider app's ambient sign-in.

**Provenance:** every fetched figure (`validate`, `run`, `models`, `ollama-usage`) says
where it came from. A failed live fetch (expired cookie, network, timeout) still shows the
last cached reading, but never bare — every render prefixes a `/!\ Cookie Expired` /
`Network Error` / `Fetch Timed Out` / `No Cookie` banner with an absolute UTC
`last seen` timestamp. `validate` only fails on a *live* exhausted reading; a cached 100%
warns instead, since the window may have since reset.

### Per-repo leaf guard (`projects`)

A leaf is a full headless Claude Code session, and `allowedTools` scopes tool *names*, not
what a tool is asked to do. `projects` wires a **repo-owned PreToolUse hook** into every
leaf that runs under that repo:

```json
{ "projects": [{ "name": "myrepo", "hooks": { "preToolUse": "python scripts/leaf_guard.py" } }] }
```

Before every tool call the engine runs that command from the leaf's cwd with the ordinary
PreToolUse payload on stdin. **Exit 0 allows, exit 2 denies** (stderr is the reason shown
to the leaf); anything else — another code, a timeout, a spawn failure — also denies,
naming why: the guard fails closed. Use it to fence build/test commands to a serial tail,
block network or `git push`, require an edit marker, or keep a leaf off a secrets path —
anything expressible from the payload is one `if` away.

Matched by the task's repo basename (the repo's MAIN worktree, falling back to cwd;
case-insensitive on Windows); an unmatched repo runs unguarded, interactive sessions never
see it. Each guard is probed once at `validate` with a harmless payload, so a broken script
fails the manifest before any leaf spends. A task opts out with `"leafGuard": false`
only — nothing in `env`/`settings.env` can forge or clear the guard.

**Requirements:** Node and `claude` on PATH for Claude leaves. Ollama `:cloud` rows need a
recent Ollama with `/api/experimental/model-recommendations` (~v0.23+); Codex rows are opt-in
and need the configured `codex` app-server command.

## Install

`/swarm:swarm setup` (Stage 0) installs the `swarm` command for you — do this. Manually:
`swarm install` writes `~/.local/bin/swarm-resolver.mjs`, `swarm`, and `swarm.cmd`
(`~/.local/bin` must be on PATH); idempotent, re-run after a plugin update.

<!-- swarm-bootstrap-exception: the only sanctioned engine-path instruction in the tree -->
Working in a clone of this marketplace, run instead: `node plugins/swarm/scripts/swarm.mjs install`.

## Usage

```bash
swarm models              # discover launchable rows from enabled providers — run first
swarm list                # saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
swarm validate <plan.json | name> [--args '<json>'] [--resolved]  # lint ids, deps, template refs, governance roots, effort pairs, forEach/when/compute shapes + expressions
swarm run <plan.json | name> [--args '<json>']    # execute; designed for Bash run_in_background
swarm ask <resultsDir> <leaf-id> "follow-up?"   # interrogate a finished leaf
swarm quota                # Anthropic utilization per limit window
swarm usage [--provider X] # live usage from enabled provider capabilities
swarm ollama-usage [--cookie '<value>']  # ollama.com session/weekly usage — see below
swarm grade --init <resultsDir>   # write grades.json — one skeleton row per provider leaf
swarm grade --file <grades.json>  # validate the filled batch and append it to the score store
swarm perf [--aspect X] [--model Y] [--domain D]   # aspect x model table with sample counts
```

A bare name resolves through the manifest registry (`<cwd>/.swarm/manifests/<name>.json`,
then `~/.swarm/manifests/`; the resolution is always announced). `--args` fills
`{{args.*}}` placeholders — `validate --resolved` prints the substituted document as the
approval preview; each distinct args value gets its own fingerprinted results dir.

In a session, the **swarm** skill drives this end-to-end: drafts the manifest, shows it in
an `AskUserQuestion` box (the preview is the approval — every model and leaf visible
before anything runs; with `swarm.always`, states it and runs), runs in the background,
and reads only `digest.md` when the run completes.

## Positioning

- **Workflow** — Claude Code's built-in orchestration: Claude-quality agents scripted in JS, inside the harness. Fast, Claude-priced.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **swarm** — interactive-speed group-think on capable alternative models.

Compose freely — a pipeline dev session or a Workflow plan may use swarm as its
alternative-model leaf executor.

### Swarm vs Workflow, honestly

A swarm manifest is a **static, previewable plan** — every model and leaf enumerable in
one approval, simple enough for a weak model to author. A Workflow script is **imperative
orchestration** reviewed as code, with the full power and full cost that implies. Neither
dominates:

| | swarm | Workflow |
|---|---|---|
| ***Parity — either tool does these well*** | | |
| Parallel fan-out — concurrency caps, dependency ordering, pipelining | ✅ | ✅ |
| Per-agent model + effort selection | ✅ | ✅ |
| A private worktree for every write-capable agent | ✅ | ✅ |
| Leaves run foreground-only — a headless session that yields its turn is over, so `run_in_background` is denied inside a leaf | ✅ `hooks/foreground-guard.mjs` | — |
| Per-repo PreToolUse hook — a repo-owned script sees every tool call inside its leaves and can deny it | ✅ `hooks/leaf-guard.mjs` | — |
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
| Web dashboard — live runs, graph and digests on your phone | ✅ `swarm serve` | ❌ |
| Predictive cost consent — estimate at approval, one projection warn, actual-vs-estimate close | ✅ | ❌ reactive only |
| Weak-model authorability — fill-in-the-blanks JSON; validation errors teach | ✅ | ⚠️ JS bar |
| Mechanical citation verification — `{file, line, quote}` returns string-matched against real files before any verifier spawns | ✅ zero tokens | ❌ |
| Transcript-proven read coverage — a leaf proves from its own transcript it `Read` the files/ranges it declared, one corrective re-ask then recorded | ✅ `mustRead`, zero tokens | ❌ |

Rule of thumb: bounded fan-out — sweeps, judge panels, generation, mechanical
implementation, discover-then-map — is swarm's shape, especially with alternative models
armed. Reach for Workflow when the orchestration itself needs unbounded loops, session MCP
tools, budget-driven control flow, or you simply want zero setup.

## Model discovery

`models` asks the enabled provider registry for launchable rows and keeps the provider identity
on every row. The Ollama adapter unions the curated recommendations endpoint with `/api/tags`,
enriches candidates through `/api/show`, and prints the roster largest-first —
`ollama/glm-5.2:cloud — Frontier open model (756B, 1.0M ctx)`. Claude models are not listed (their aliases are refused; name the full id with `"provider": "claude"`); an enabled Codex adapter discovers its account-visible models
through app-server `model/list`. When the same model id exists under multiple providers, the
provider-qualified label is required.

An entry superseded by a strictly-newer same-lineage sibling is hidden behind it
(`swarm models --all` shows the hidden rows). Entitlement is handled by removal, not
annotation: each refresh probes the top cloud entries with one token each, and a 402
rejection removes that row from `~/.swarm/models-cache.json` until the account can run it
again.

## Example manifest

```json
{
  "resultsDir": null,
  "tasks": [
    {
      "id": "auth",
      "provider": "ollama", "model": "minimax-m3:cloud",
      "prompt": "Your single job: where is session token expiry enforced?\nFile scope: src/auth/**\nReturn your findings as ≤10 bullet points: name, file path, line number, one-line description. No prose. If you cannot find the answer, say so in one line — do not expand scope."
    },
    {
      "id": "session",
      "provider": "ollama", "model": "minimax-m3:cloud",
      "prompt": "Your single job: how are sessions persisted and evicted?\nFile scope: src/session/**\n(same return contract)"
    },
    {
      "id": "verdict",
      "provider": "claude", "model": "claude-sonnet-5",
      "effort": "high",
      "after": ["auth", "session"],
      "prompt": "Read {{resultPath:auth}} and {{resultPath:session}}. Do the expiry and eviction paths agree? Return a verdict with file:line evidence."
    }
  ],
  "digest": {
    "provider": "ollama", "model": "glm-5.2:cloud",
    "instructions": "must_be_sure: the expiry enforcement point. PROVEN/OPEN ledger required."
  }
}
```

## Deterministic steps — forEach / when / compute

Glue logic between agent calls that never needed an LLM, without making the manifest a
programming language. Every leaf stays enumerable at approval time — `validate` prints the
worst-case leaf count.

```json
{ "tasks": [
    { "id": "find-sites", "provider": "ollama", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: {\"sites\":[…]}" },
    { "id": "dedupe", "after": ["find-sites"], "compute": "unique_by(deps['find-sites'].sites, 'file')" },
    { "id": "fix", "after": ["dedupe"], "forEach": { "from": "dedupe", "path": "", "maxItems": 30 },
      "provider": "ollama", "model": "glm-5.2:cloud", "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "Fix {{item.file}}:{{item.line}}" },
    { "id": "escalate", "after": ["fix", "dedupe"], "when": { "from": "dedupe", "expr": "length(value) > 20" },
      "provider": "claude", "model": "claude-sonnet-5", "prompt": "…{{result:fix}}…" }
  ] }
```

- **`forEach`** clones a template leaf at runtime over a dependency's JSON array. `maxItems`
  is required — the cap is the approval. Clones (`fix[0]`, `fix[1]`, …) are full tasks —
  own result, tokens, retry budget, `fallbackModel`, `ask` session; dependents wait for all
  of them (`{{result:fix}}` = array of clone outputs). A capped run reports `truncated`
  loudly rather than reading as full coverage.
- **`when`** gates a leaf on a dependency's output — false completes the task `skipped`
  (dependents still run); the expression must yield true/false.
- **`compute`** is an agentless expression step (dedupe/filter/count/threshold/flatten) —
  zero tokens, a hand-rolled bounded evaluator (`length`, `count`, `filter`, `unique_by`,
  `flatten`, `min/max/sum`, `contains`, comparisons, 500-char cap) rather than `eval`,
  since manifests may themselves be model-authored.

## Widening after a narrow step — `workspace` and `integrate`

Private trees branch from repo HEAD and never see each other's commits, so a fan-out that
follows a shared step needs a way to start from that step's work and a way to fold results
back:

```json
{ "tasks": [
    { "id": "helper", "provider": "ollama", "model": "glm-5.2:cloud", "workspace": "feat",
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…write the helper. Commit before you finish." },

    { "id": "migrate-x", "provider": "ollama", "model": "glm-5.2:cloud", "after": ["helper"],
      "workspace": "migrate-x",
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…Commit before you finish." },
    { "id": "migrate-y", "provider": "ollama", "model": "glm-5.2:cloud", "after": ["helper"],
      "workspace": "migrate-y",
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "…Commit before you finish." },

    { "id": "join", "after": ["migrate-x", "migrate-y"],
      "integrate": { "into": "feat", "from": ["migrate-x", "migrate-y"] } },

    { "id": "cleanup", "provider": "ollama", "model": "glm-5.2:cloud", "after": ["join"],
      "workspace": "feat", "prompt": "…resolve {{result:join}}, run the suite. Commit." }
  ] }
```

Width goes `1 → 2 → 1`: `migrate-x`/`migrate-y` run concurrently in private trees already
holding `helper`'s commit, then `join` merges both into `feat`, and `cleanup` carries on.

- **`integrate`** is an agentless node like `compute` — spends nothing. Merges each named
  task's branch into the `into` worktree, creating that tree if not yet reached.
- **A conflict is not a failure.** The merge stops with markers left in the tree, the node
  stays `ok`, and conflicting paths land in its result — pass `{{result:join}}` to the next
  leaf to resolve them.

### Folding a `forEach` fan-out back — `integrate.from` naming the parent

"Discover N sites, fix each in its own tree, fold together" is `forEach` writing in
worktrees, then `integrate` naming the `forEach` task — every clone that actually expanded
merges, in index order:

```json
{ "tasks": [
    { "id": "find-sites", "provider": "ollama", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: {\"sites\":[…]}" },
    { "id": "fix", "after": ["find-sites"], "forEach": { "from": "find-sites", "path": "sites", "maxItems": 30 },
      "provider": "ollama", "model": "glm-5.2:cloud", "allowedTools": "Read,Grep,Glob,Edit,Write,Bash", "prompt": "Fix {{item.file}}:{{item.line}}. Commit before you finish." },

    { "id": "join", "after": ["fix"], "integrate": { "into": "feat", "from": ["fix"] } }
  ] }
```

`fix[0]`…`fix[n-1]` own the branches, not `fix` itself — `from: ["fix"]` resolves to those
clone branches, the same way `{{result:fix}}` resolves to their outputs. A capped or empty
source array, or a failed clone, behave exactly as they do for a hand-listed `from`.
`validate`'s preview reuses the `forEach`'s own cap: `join ≤ 30 branches (fix forEach)`.

## Results layout

```
<resultsDir>/                # default ~/.swarm/runs/<encoded-repo-toplevel>/<stem>-<n>/ — outside the repo
  manifest.json              # the effective plan at dispatch (args substituted) — runs record their own intent
  results/<id>.json          # { id, model, ok, exit, durationMs, tokens?, costUsd?, numTurns?, sessionId?, prompt?, cwd, allowedTools, output, outputJson?, citations?, worktree? }
  results/<id>.log           # the leaf's raw stream-json events — tail one leaf's tool calls live
  digest.md                  # when a digest block is present — read this, not the raw results
  summary.json               # { started, finished, tasks: [...], blocked: [], worktreesKept: [], totalTokens }
  run.log                    # JSONL — state changes, live token ticks, run-start roster — tailable mid-run
                              # also carries a `session` event ({ id, sessionId }) the moment each
                              # leaf's stream names it, before the leaf settles — a crashed engine
                              # still has every session id on disk for resume to fall back to
```

**A leaf's tree follows from its tools.** `Edit`/`Write`/`Bash` ⇒ a private worktree on repo
HEAD, on the run-scoped branch `swarm/<run>/<id>`; read-only ⇒ the live repo at the leaf's own
`cwd`. Two optional keys refine it, both writer-only:

| Key | Effect |
|---|---|
| `workspace` | Every leaf naming it meets in **one** tree on one branch, so an ordered chain accumulates. Members must be totally ordered by `after`; `forEach` cannot name one. |
| `branch` | A stable branch name instead of the derived one — which opts out of run scoping, so a second run of the manifest meets the first's kept tree. |

To start a tree from another task's commits, put an `integrate` node before it: the node creates
the target tree and merges the named branches in. There is no key for it.

`worktreesKept` in `summary.json` carries one entry per shared group. A branch with
commits not yet landed (by patch, so squash-merges count) is never deleted or force-reset —
the engine refuses rather than lose it. `swarm prune <resultsDir>` destroys one run's kept
worktrees and branches, never its results — refuses a live run, prints every tree first,
`--dry-run` for a no-op preview. Nothing prunes on its own.

Leaves dispatch with `--output-format stream-json`; a provider that emits plain text
instead degrades gracefully (raw stdout becomes `output`, token columns stay empty).

Stdout repaints a roster snapshot on every state change and heartbeat (`heartbeatSecs`,
default 15): glyph, id, model, duration, work tokens, plus a counts footer. Running rows
show the leaf's latest tool call; a leaf silent past `quietWarnSecs` (default 60) shows
`⚠ quiet Ns` instead. Failed tasks block their dependents; independent branches continue;
re-`run` resumes (`ok` work skipped, `rate-limited` retries). A live engine (heartbeat
younger than `heartbeatSecs * 3`) makes `run` — even `--force` — refuse rather than
double-drive the same leaf; `swarm stop <resultsDir>` ends it first.

`status <resultsDir>` renders the same roster read-only (`--watch` for live repaint). Past
that same staleness window it relabels every `running`/`retrying` row `interrupted` and
adds `⚠ engine dead — no heartbeat since <iso>` — a crashed engine reads as dead, not quiet.

## Interrogating a leaf

Every leaf's Claude Code session id is captured in its result JSON. `ask` resumes that
session with a follow-up — the leaf already holds its context, so a drill-down costs one
turn instead of a re-run:

```bash
swarm ask <resultsDir> census-edges "show the exact preload line you cited"
```

Runs through the same engine as `run` — same `run.log`, heartbeat, live-engine guard — so
it shows on `status`/dashboard as that leaf running again. Uses the leaf's own model, cwd,
and tool allowlist; `--model <m>` re-asks on a different model (same governance gate).
Leaves in a since-removed worktree can't be resumed. A failed ask is recorded in `asks[]`,
never demotes the leaf's accepted result.

## Self-healing runs

Transient failures recover in-run; temporal ones fail fast with the recovery named:

- **Rate limits** retry with exponential backoff (`retry.rateLimited`, default 2 attempts,
  `retry.backoffMs` 30s) — the slot frees during the wait. Spawn errors get one quick
  retry. Timeouts never auto-retry (rescope and resume instead).
- **`fallbackModel`** (per task) is the only substitution the engine ever makes — validated
  against `allowedRoots` like any dispatch target. Quota switches to it immediately; rate
  limits switch after retries exhaust. Logged (`↯ fallback → glm-5.2:cloud`).
- **Quota (`⏳`) is distinct from rate limits** — temporal (hours), so instead of retrying
  the run parses the reset time and the first Claude leaf to hit the wall pre-emptively
  marks every still-pending undefended Claude leaf `quota`. Re-running after reset skips
  `ok` work.
- **Quota preflight**: with Claude leaves present, the engine queries Anthropic's usage
  endpoint first (free, local OAuth creds, cached `quotaCacheSecs`). Exhausted quota with
  undefended Claude leaves aborts before dispatch; ≥`quotaWarnPct` (80) warns and proceeds.
  Best-effort — any endpoint failure and the run proceeds. Disable with
  `"quotaPreflight": false`.
- **Memory pressure parks, it doesn't fail.** Below `minFreeMemMb` (2048) a pending leaf
  waits (`retrying`, unlimited); below `valveFreeMemMb` (1024) with >1 leaf running, the
  engine stops its own newest leaf (classified `memory`, not a failure). Both redrive once
  memory clears — not on a timer, so a fully parked run still exits cleanly if memory never
  recovers. An engine with nothing else running still starts one leaf — degrades to serial
  rather than stalling.

`swarm quota` reports Anthropic utilization and the legacy Ollama cloud cache. Use
`swarm usage` for live readings from every enabled provider capability:

```
anthropic session: 42% — resets Sun 6 Sep, 19:00
anthropic weekly_all: 71% — resets Sat 12 Sep, 01:00
ollama session: 12% — resets Sun 6 Sep, 13:00
ollama weekly: 87% — resets Tue 8 Sep, 01:00
```

`quota` fetches Anthropic live and reads the legacy Ollama cloud cache (its cookie needs a
human, so it must not stall on one). `usage` asks enabled provider adapters for live
readings. Exit code 1 means **Anthropic** exhausted specifically.

**`swarm ollama-usage`** owns the `:cloud` side's fetch and cookie — zero-dependency,
independent of your provider app's own tooling. First run: `swarm ollama-usage --cookie
'<value>'` saves it and fetches immediately; later calls reuse it. Exits 1 at 100% weekly,
falls back to cache when the cookie is expired or missing.

Both commands share `src/usage.mjs`, also consulted by the ultraswarm hook, so a reading
reads identically everywhere. Nothing arms itself — a provider is read only when
`providers.<name>.enabled` is `true`. A provider that can't take work now gets one
line beside the standing-mode block; a healthy provider says nothing.

## Model capability scores

Which model to use for what is otherwise decided by remembered incidents. `grade` records
what a run's `:cloud` leaves actually did; `perf` reads it back. Opt-in:
`"grading": { "enabled": true }` — off by default, `grade`/`perf` still answer by hand.

When enabled, the nudge appears on the engine's closing block, `digest.md`'s footer, and
the session Stop hook (every turn end, not once). `swarm grade --waive <resultsDir>
--reason "<why>"` excuses a run without a store row. The manifest's author grades it — the
only party that knows what each leaf was *asked* for.

```bash
swarm grade --init <resultsDir>   # → <resultsDir>/grades.json, one row per :cloud leaf
# fill in session, and per row: domain, outcome, note, grades
swarm grade --file <resultsDir>/grades.json
swarm grade --waive <resultsDir> --reason "<why>"   # excuse a run instead — no store row
swarm perf --aspect search --domain godot
```

**Ten aspects, graded 1-10.** Four graded on every leaf; six only where the leaf stressed
them (`null` otherwise) — they co-occur freely.

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

`domain` is one lowercase token naming the leaf's language/ecosystem (`godot`, `rust`,
`node`, `python`, `docs`) — never the repo or task. `outcome` (`completed | wrong | failed
| timeout | session-died | not-capable`) is separate from the grades: the first two
require grades, the rest forbid them — `not-capable` records the model couldn't do the
thing *on this harness*.

Each row also snapshots mechanical columns (`ok`, `durationMs`, `tokens`, `numTurns`,
citation counts) and the model's declared capabilities from `models-cache.json` — auditable
context, never a substitute for the grade.

**Store:** `~/.swarm/model-scores.jsonl`, append-only, line-atomic. Re-grading a run
replaces its rows rather than double-weighting the model.

**Reading `perf`.** Per aspect × model, each cell shows sample count `n`, raw `mean`, and a
`wtd` score weighted by evidence — `n < 5` is provisional; an aspect with no rows prints
`n=0` rather than being omitted.

**`swarm validate`** prints the record the seating is decided on when grading is on: a
`seats:` block per seated model (leaf ids, scores, cost band, frontier verdict) plus one
line for launchable models it didn't seat. `never graded` / `cost unmeasured` are written
in words, never a number — absence is not zero.

## Cost — the meter weight beside the score

`swarm cost` reads `~/.swarm/usage-history.jsonl` — one line per **live** usage fetch that
carried measurable weekly segments (cached readings bank nothing).

- **Weeks split on a falling count, never a falling percentage** — a model's cumulative
  `requests` only rises within a week, so a fall (or a model's absence) proves a reset.
- **One reading per model per week: that week's last snapshot** — averaging repeated views
  of one running total would weight by fetch frequency.
- **A rate is weighted by the requests that produced it** — a share below the page's 0.1%
  resolution contributes requests to the total but no rate: unknown, not zero.
- **The multiplier's floor is a measured model with ≥ 200 measured requests.** A model with
  no history is **unmeasured** — excluded from comparison entirely, neither free nor dear.

The multiplier is the per-request meter weight against that floor, printed beside the
grades, never collapsed into one number. A model is **dominated** when another is strictly
higher-scoring *and* strictly cheaper — the only comparison made, since a ratio would let
one cheap fluke leaf outrank a well-evidenced model.

**Best value is a threshold, never a ratio.** The card names the *cheapest* model still
worth seating: on the frontier, within `valueMargin` (default `0.5`) of the best frontier
quality, and not thin — the margin used is printed, so the pick is judgeable. Cost bands
(`providers.ollama.cloud.ollama.costBands`, default `[2, 5]`) render `$`/`$$`/`$$$` in the terminal. The
dashboard and model detail views draw one to five coins instead, tinted per provider and scaled
within that provider's own measured range (cheapest 1, dearest 5, log-spaced); unmeasured renders `—`, never a blank that would read as
dominated. Badges never appear on leaf/run rows (the terminal keeps its plain `$` bands).

### Rate cards — pulled, not typed

Ollama's list is *measured* from its weekly meter. Codex's and Claude's are *published*, and
swarm reads them off the vendors' own pricing pages rather than anyone transcribing a
number: both serve markdown at `<page URL>.md`, so a refresh is a table parse.

```bash
swarm refresh-prices             # re-read both tables, bank them at ~/.swarm/rate-cards.json
swarm refresh-prices --dry-run   # parse and report what moved, write nothing
```

- **The shipped cards are seeds, not the source of truth** — the last hand-read of each
  table, so a fresh or offline install still ranks honestly. The first refresh supersedes
  them, and a fixture test pins each seed against the page it was read off, so a seed
  cannot drift from the table unnoticed.
- **A stale card refreshes itself.** Cards carry a `staleAfter` (the vendor's published
  expiry, else 90 days from the read); past it, `swarm cost` re-reads before ranking. No
  flag gates it — ranking on prices the vendor has already changed is never what anyone
  wants. Offline, the cached card stands and its banner says so.
- **A parse that comes back empty or implausible is refused, never banked** — that failure
  has no symptom except every model silently reading `unpriced`.
- **A family does not share one price.** Every row is its own published line: `sonnet-4-6`
  bills $3/$15 against `sonnet-5`'s $2/$10, and `opus-5-5` undercuts `opus-5`. A dated id
  (`claude-haiku-4-5-20251001`) prices as the undated row the table publishes.

## Dashboard

A read-only web dashboard over `~/.swarm/runs`, built for a phone on your LAN: every
project's runs, a run's live graph and roster, a leaf's tokens/activity/output, a finished
run's digest, and a Performance page ranking the model score store. Refreshes itself while
a run is live.

```bash
swarm serve --daemon            # start in the background; prints the URL to open
swarm serve status | stop | restart
swarm serve doctor              # checks port, pid, autostart, version, firewall
swarm serve install-autostart   # start it with Windows
```

Settings live under `dashboard` in `~/.swarm/config.json` (port, bind address, access
token, refresh timings) — `/swarm:swarm setup` walks them; `dashboard.enabled: false`
turns it off.

## Status bar — the fleet bar

```bash
swarm statusline install   # writes ~/.swarm/statusline.mjs, prints the settings.json block
```

Shows every live run this session launched: `swarm ▮1 · sweep 3/8 ◐ glm-5.2,minimax-m3
1.2M · ⚠ sweep verify-b quiet 6m` — running/ok/failed/quiet counts and per-model tokens,
read from `run.log` the same way the dashboard and `swarm status` do (never from scanning
`results/` for file presence). Only runs launched by *this* session show (the engine
stamps the launching session id); a manual run with no stdin shows every live run.
`/swarm:swarm setup` offers this install as one of its stages.

`settings.json` points at a self-resolving shim (`~/.swarm/statusline.mjs`), never at the
plugin's cache path — the shim looks up the installed plugin on every paint, so plugin
updates never break the bar. The printed block carries `"refreshInterval": 5`, since Claude
Code otherwise repaints a status command only on conversation updates and an idle bar would
freeze on its dispatch-time counts.

## Completion notification

Set `notifyCmd` in `~/.swarm/config.json` to fire a command when a run finishes (tokens:
`{status}`, `{digest}`, `{summary}`) — e.g. ping yourself via the slack-bridge plugin:

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

`"swarm": { "always": true }` in `~/.swarm/config.json` is standing consent: the swarm
skill runs its full ceremony (orchestrating-agents, executing-swarms, `models`, `validate`)
then dispatches on a printed gate statement instead of an `AskUserQuestion`. A
`SessionStart` hook announces it each session, mode-bracketed
(`[:cloud tier preferred]` under an `allowedRoots` cwd, `[Anthropic orchestration only]`
otherwise). The keyword **`ultraswarm`** in a prompt injects the same block for that
session without the config flag.

## Dispatch nudges

Two `PreToolUse` hooks intercept the tools that fan work out without going through swarm.
Both are speed bumps by default — they fire at most **twice per session** and a retry passes
straight through — and both become **hard blocks with no budget** under standing mode
(`swarm.always`), where swarm is already pre-authorised and the other tool is the wrong reach.
Both stay silent in pipeline child sessions (`CORRELATION_ID`).

| Hook | Tool | Fires when | Disable |
|---|---|---|---|
| `workflow-nudge.mjs` | `Workflow` | alternative models are armed (an enabled provider resolves to `allowedRoots`) | `"swarm": { "workflowNudge": false }` |
| `agent-nudge.mjs` | `Agent` | the call leaves **`model`** unpinned | `"swarm": { "agentNudge": false }` |

The agent nudge deliberately does *not* check arming. An `Agent` call with no `model` inherits
the session model, so an Explore sweeping filenames runs at opus rate for work fable or haiku
does identically — a live burn on a machine with no alternative provider configured at all.
Pinning `model` always passes, standing mode included: a deliberate single leaf on Anthropic is
a legitimate shape, and the budget is spent only on genuinely unpinned calls.
