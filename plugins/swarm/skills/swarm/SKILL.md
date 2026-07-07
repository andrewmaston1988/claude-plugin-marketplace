---
name: swarm
description: >-
  Use when a request fans out into 3+ independent bounded leaves, or alternative models are wanted for breadth or second opinions. Triggers — "swarm this", "fan out", "sweep", "judge panel", "run these in parallel", "use glm/minimax". SKIP for: a single bounded question — answer it inline.
---

# swarm — alternative-model fan-out engine

Swarm turns one session into a group: many independent perspectives, redundant attempts, diverse-lens judging — powered by capable `:cloud` models (GLM, MiniMax — not an opus swarm, but almost) alongside Claude tiers, at interactive speed. You author a JSON manifest (the same authoring act as writing a Workflow script); the engine runs the dependency graph in the background and compresses results through a digest so raw output never floods your context. The smarts live in the plan and the leaves; the plumbing has none.

Engine: `scripts/swarm.mjs` at the plugin root — resolve it as `<this skill's base directory>/../../scripts/swarm.mjs`. Subcommands: `models`, `validate <manifest>`, `run <manifest> [--force]`.

## Data governance — read this first

Non-Claude dispatch is **deny-by-default**. `provider.allowedRoots` in `~/.swarm/config.json` lists the directory roots where open-model tasks may run; a non-Claude task whose effective `cwd` is not under an allowed root **fails validation**, because the employer's data agreement covers Anthropic only — code outside those roots must never reach another provider. Claude-model tasks run anywhere. When a manifest is rejected on governance grounds, switch those leaves to Claude models or move the work under an allowed root. Never work around the gate.

## Routing — when to swarm

- **Triage first**: when the whole job is under ~one leaf's cost (~30k tokens), read it yourself — don't swarm.
- **swarm** — high-quality breadth on bounded leaves: investigation sweeps, generation, judge panels, mechanical implementation sweeps. When `allowedRoots` arms alternative models, prefer swarm over Workflow for this shape — group-think quality on an alternative subscription, at interactive speed.
- **Workflow** — Claude-quality reasoning with harness integration: leaves that need harness tools, live session context, or subtle mid-flight judgement.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **Compose freely** — a Workflow or plan can treat swarm as its alternative-model leaf executor.

## MANDATORY first step — the offer gate

Before doing ANY fan-out-shaped work inline (3+ independent bounded leaves), draft the manifest and put it through AskUserQuestion:

> "Fan this out via swarm — <n> leaves on <models>?"
> Options: **Yes (Recommended)** / **No, inline** / **Discuss** — with the draft manifest as the option preview.

The manifest preview IS the approval: the user sees every model and every leaf before anything runs. There is no separate Opus gate, no per-model approval, no cost interrogation. Do not start inline work on a fan-out-shaped task without this gate.

## Procedure

1. **Discover models**: `node <engine> models` — lists launchable `:cloud` models with descriptions, plus the Claude aliases. Run FIRST so the manifest names models the account can launch right now. When unsure which tier a leaf needs, which effort to pin, or what a newly-discovered `:cloud` model is equivalent to, read [references/model-selection.md](references/model-selection.md).
2. **Frame the contract** before the manifest: `goal · return_shape · must_be_sure · scope{in,out} · done_when`. scope → per-leaf prompts and file scopes; must_be_sure → `digest.instructions`; done_when → you check it post-run.
3. **Author the manifest** (schema below) and offer it through the gate above.
4. **Validate**: `node <engine> validate <manifest.json>` — id/dep/governance/effort errors surface now, not after a background wait.
5. **Run**: `node <engine> run <manifest.json>` via `Bash run_in_background`. The completion notification is the "run finished" signal.
   **Immediately after dispatching**, give the user the live watch command for a separate terminal — `node <engine> status <ABSOLUTE resultsDir> --watch` — and copy it to their clipboard. Always the absolute path: a relative one resolves against whatever cwd their terminal is in and fails with "no run.log". NEVER poll status yourself while the run is live: dispatch in the background, continue other work, the completion notification will find you.
   **Status asks**: you know the `resultsDir` (you authored the manifest — remember it). When the user asks how the swarm is doing ("/swarm status", "how far along…"), run `node <engine> status <resultsDir>` once and relay its table verbatim; for one specific leaf, tail `results/<id>.log`.
6. **Read `digest.md` ONLY**, then drill into `results/<id>.json` selectively — the digest's drill-down section says which raw results merit a full read. Never read all raw output.
7. A failed run is reported with its failures and a resume offer (re-`run` skips `ok` results; `rate-limited` leaves are retryable) — never presented as complete.

## Manifest quick reference

```json
{
  "resultsDir": null,                           // OMIT - default ~/.swarm/runs/<encoded-cwd>/<stem>-<n>/ keeps runs out of the repo entirely
  "concurrency": 4,
  "tasks": [{
    "id": "scan-a",                            // unique, filename-safe
    "prompt": "…",
    "model": "glm-5.2:cloud",                  // :cloud name or claude alias/id
    "effort": "medium",                        // optional; validated for Claude tiers
    "allowedTools": "Read,Grep,Glob",          // default: read-only set
    "cwd": "C:/code/somerepo",                 // default: manifest's cwd
    "isolation": "worktree",                   // implementation leaves only
    "outputDir": "…",                          // generation leaves
    "timeoutMs": 600000,
    "after": ["scan-b"]                        // dependencies
  }],
  "digest": { "model": "glm-5.2:cloud", "instructions": "…" }   // recommended ≥3 tasks
}
```

Prompt templating: `{{result:<id>}}` inlines a dependency's output (capped ~4k chars); `{{resultPath:<id>}}` injects the result file's absolute path so the leaf Reads it itself — the right choice for large outputs. Referencing a non-dependency id fails validation.

## Plan patterns

### Fan-out (the native shape)

N tasks, no `after`; digest synthesizes. Every investigation leaf prompt uses this fixed shape — one closed question per leaf, each answerable from a bounded file set:

```
Your single job: [SINGLE CLOSED QUESTION]

File scope: [the leaf's file scope]

Return your findings as ≤10 bullet points:
  • name/method/event, file path, line number, one-line description
No prose. No code blocks unless the exact token text is essential.
If you cannot find the answer, say so in one line — do not expand scope.
```

**One job per leaf.** If a leaf's scope turns out to hide a second question, add a *new* leaf with a new closed question — never widen an existing one.

```json
{ "tasks": [
    { "id": "auth",    "model": "minimax-m3:cloud", "prompt": "Your single job: where is session token expiry enforced?\nFile scope: src/auth/**\nReturn your findings as ≤10 bullet points: name, file path, line number, one-line description. No prose. If you cannot find the answer, say so in one line — do not expand scope." },
    { "id": "session", "model": "minimax-m3:cloud", "prompt": "…same shape, session-store cluster…" },
    { "id": "api",     "model": "glm-5.2:cloud",    "prompt": "…same shape, API-layer cluster…" }
  ],
  "digest": { "model": "glm-5.2:cloud", "instructions": "must_be_sure: the expiry enforcement point, with file:line. PROVEN/OPEN ledger required." } }
```

### Chain — mechanical links only

`{{result:<id>}}` passes raw (capped) output between links, so each link's *output* contract must be hard: **"return ONLY the N facts the next step needs."** Judgement-heavy chains split across runs — run a link, compress in-session, run the next.

```json
{ "tasks": [
    { "id": "extract", "model": "minimax-m3:cloud", "prompt": "List every route in src/routes/. Return ONLY a JSON array of {method, path, handler} — nothing else." },
    { "id": "matrix",  "model": "glm-5.2:cloud", "after": ["extract"], "prompt": "Routes: {{result:extract}}\nProduce a markdown table: route × auth requirement." }
  ] }
```

### Judge panel

Same subject, diverse lenses, JSON verdicts; the digest presents agreement and dissent.

```json
{ "tasks": [
    { "id": "security",    "model": "glm-5.2:cloud",    "prompt": "Review the diff at {{resultPath:…}} as a security reviewer. Return JSON {verdict, findings:[{severity, path, line, note}]}." },
    { "id": "performance", "model": "minimax-m3:cloud", "effort": "high", "prompt": "…performance lens, same JSON shape…" },
    { "id": "api-design",  "model": "sonnet",           "prompt": "…API-design lens, same JSON shape…" }
  ],
  "digest": { "model": "glm-5.2:cloud", "instructions": "Where judges disagree, present both sides — do not average verdicts." } }
```

### Sweep-then-synthesize

Fan-out plus an explicit synthesis leaf (use when synthesis needs richer instructions than the digest, or a Claude tier): sweep leaves with no `after`, then one task `after: [all sweeps]` reading `{{resultPath:…}}` for each.

```json
{ "tasks": [
    { "id": "s1", "model": "minimax-m3:cloud", "prompt": "…closed question, cluster 1…" },
    { "id": "s2", "model": "minimax-m3:cloud", "prompt": "…cluster 2…" },
    { "id": "s3", "model": "minimax-m3:cloud", "prompt": "…cluster 3…" },
    { "id": "synth", "model": "sonnet", "effort": "high", "after": ["s1", "s2", "s3"],
      "prompt": "Read {{resultPath:s1}}, {{resultPath:s2}}, {{resultPath:s3}}. Reconcile conflicts and produce the migration checklist." }
  ] }
```

### Multi-wave — two runs, NEVER one manifest

**Invariant: wave 2 never starts until wave 1 results are compressed into `[SHARED_CONTEXT]` (≤400 words).** Wave 1 explores (fan-out manifest + digest); then **you** (the session) synthesize `[SHARED_CONTEXT]` covering: **data model** (exact names, key schema facts), **API contract** (exact interfaces, response structures), **existing conventions** (patterns, helpers, file locations wave-2 leaves must follow). Wave 2 is a second manifest embedding it verbatim in each leaf prompt — `isolation: "worktree"` for implementation leaves, `outputDir` for plan/generation leaves — plus per-leaf: "Do not claim files outside your scope boundary" and "List dependencies under `## Prerequisites` (use `- none`)". Encoding both waves in one manifest is FORBIDDEN: the between-wave synthesis is the judgement step and must not be delegated to the plan.

## Leaf shapes

| Shape | Recipe |
|---|---|
| Investigation | Read-only tools (the default), closed question, ≤10-bullet return contract |
| Review | Prompt demands a JSON verdict; engine stores raw + parsed |
| Generation | `outputDir`; no isolation field needed |
| Implementation | `isolation: "worktree"` — results are branches to review; unchanged worktrees are removed, changed ones kept and listed in the summary |

Write-capable tools (Edit/Write/Bash) without `isolation: "worktree"` get the leaf's cwd auto-redirected to a scratch dir — a leaf never writes in the real tree unless explicitly worktree-isolated.

## Verification loop — multi-run composition

Put in `digest.instructions`: the **PROVEN/OPEN ledger** (one row per `must_be_sure` item: `PROVEN — file:line` or `OPEN — <precise next step>`) and three-band compression, sized to the signal — not a fixed count:

- **full fidelity + `file:line`** on anything load-bearing the answer must be sure of (`must_be_sure`);
- **one concise entry** per other goal-relevant finding;
- **one line, or drop,** for incidental noise;

plus headline-before-body ordering: read all headlines first, read bodies only for leaves whose headline indicates a relevant finding.

Post-run, you read the ledger. **Confidence is evidence-shaped**: a cited `file:line` span plus a falsifier ("what would falsify this") — never a leaf's scalar self-report. OPEN rows become an appended verification run with **expanded** scope — absence under `must_be_sure` demands an exhaustive wider search (a bounded-scope null ≠ genuine absence); never a re-run of the same file scope, which just confirms a wrong answer twice. Resume semantics make this cheap: same `resultsDir`, `ok` results skipped, only new/failed work executes.

## Terminology

- **leaf** — one bounded task in the manifest, holding one closed question.
- **closed question** — answerable from a bounded file set with a definite result; "describe how X works" is open-ended — rewrite it.
- **digest** — the ≤5-bullets-per-leaf compression stage; the only thing you read by default.
- **headlines / bodies** — the digest's ordering: one-line finding per leaf first, detail after; read bodies only where a headline warrants it.
- **must_be_sure** — the load-bearing facts the run exists to establish; full fidelity + `file:line` in the ledger.
- **wave** — one manifest run in a multi-run composition.
- **match ≠ relevant** — a textual match is not a finding; prune the candidate set to the genuinely relevant one at decomposition, and again in the digest.

## Group-think quality patterns

The favourable economics of alternative models are a consequence, not the point — spend them on quality, never deliberate cost per leaf:

- **N independent attempts** — same closed question to 3 leaves (same or different models), then a judge leaf or the digest reconciles. Disagreement is signal.
- **Diverse-lens judging** — a panel where each judge holds one concern (security, perf, API shape) beats one generalist review.
- **Adversarial verification** — a leaf whose single job is to break another leaf's claim ("find a counter-example to X; if none, say so").
- **Redundant sweeps** — overlap sweep scopes slightly; the digest catches contradictions at cluster boundaries.

### Adversarial review — the fabrication counter (codified)

Leaves fabricate: invented functions, plausible-but-fake `file:line`, confident summaries of code that doesn't exist. Reviews and audits MUST use this three-layer shape — a finder pack without verifiers is not a review:

1. **Finder prompt discipline** — every finding carries `path:line` AND a short verbatim quote of the cited span. End the prompt with: `A claim without a citation will be discarded unverified. "Not found" is a correct and complete answer — do not invent findings to seem useful.`
2. **Verifier wave** — one verifier per finder, `after` it, fed `{{result:<finder-id>}}`, on a DIFFERENT model family than its finder (a family must never verify its own claims). Prompt shape: `You are checking claims for fabrication, not re-doing the work. For each finding: Read the cited file at the cited line; verdict CONFIRMED only if the quoted span exists there and supports the claim as stated. Any mismatch, missing file, or stretch: REFUTED with one line why. Default to REFUTED when uncertain.` Span-checking is mechanical — `haiku` (or your fastest `:cloud` model) is the right verifier tier.
3. **Digest rule** — add to `digest.instructions`: `Findings lacking a citation are noise-band: drop. Findings REFUTED by their verifier appear only in the ledger, marked refuted. Only CONFIRMED findings may appear as headlines.`

Manifest sketch: `find-a`,`find-b` (glm) → `verify-a`,`verify-b` (`after` each, haiku or minimax) → digest counting only survivors.

## Anti-patterns

- Fan-out-shaped work started inline without the offer gate — the confirmation is one message; a wrong multi-model run wastes minutes and tokens. "The user's in a hurry" is not an exemption.
- Reading raw `results/*.json` wholesale instead of `digest.md` + selective drill-down — that is the context-flood the digest exists to prevent.
- Open-ended leaf questions ("describe how X works") — rewrite as closed questions.
- Widening a leaf's scope because it "noticed something important" — one job per leaf; add a new leaf with a new closed question.
- Both waves in one manifest, or judgement-heavy chain links joined by `{{result:…}}`.
- Per-leaf price deliberation — pick from the discovered list and move on.
- Working around a governance rejection instead of switching the leaf to a Claude model.
- Swarming a single bounded question — under ~one leaf's cost, read it yourself.
