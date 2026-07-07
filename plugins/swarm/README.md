# swarm — alternative-model fan-out engine

A Claude Code session authors a JSON manifest (the same authoring act as writing a Workflow script); the swarm engine dispatches each task via CLI — capable `:cloud` models (GLM, MiniMax, qwen, …) through your provider, Claude models via plain `claude -p` — runs the dependency graph in the background, and compresses results through a digest stage so the session never swallows raw output.

The product is **quality from group-think**: many independent perspectives, redundant attempts, diverse-lens judging — near-opus-swarm quality from capable alternative models on an alternative subscription, delivered at interactive speed. The smarts live in the plan and the leaves; the plumbing has none.

## Positioning

- **Workflow** — Claude-quality orchestration inside the harness. Fast, Claude-priced.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **swarm** — interactive-speed group-think on capable alternative models.

Compose freely — a pipeline dev session or a Workflow plan may use swarm as its alternative-model leaf executor.

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
```

In a session, the **swarm** skill drives this end-to-end: it drafts the manifest, shows it in an AskUserQuestion box (the preview is the approval — every model and leaf visible before anything runs), runs in the background, and reads only `digest.md` when the run completes.

## Example manifest

```json
{
  "resultsDir": "swarm-results/auth-sweep",
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
<resultsDir>/                # default .swarm/<manifest-stem>-<n>/ — auto-.gitignored
  results/<id>.json          # { id, model, ok, exit, durationMs, output, outputJson?, worktree? }
  digest.md                  # when a digest block is present — read this, not the raw results
  summary.json               # { started, finished, tasks: [...], blocked: [], worktreesKept: [] }
  run.log                    # JSONL, one line per task state change — tailable mid-run
```

Stdout shows one status line per completed task and a closing block (digest path, summary path, kept worktrees) — never raw task output. Failed tasks block their dependents; independent branches continue; re-`run` resumes (completed work is skipped, `rate-limited` tasks retry).

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
