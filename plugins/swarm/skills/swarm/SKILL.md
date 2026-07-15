---
name: swarm
description: >-
  Use when a request fans out into 3+ independent bounded leaves, or alternative models are wanted for breadth or second opinions. Triggers — "swarm this", "fan out", "sweep", "judge panel", "run these in parallel", "use glm/minimax". SKIP for: a single bounded question — answer it inline.
---

# swarm — alternative-model fan-out engine

Swarm turns one session into a group: many independent perspectives, redundant attempts, diverse-lens judging — powered by capable `:cloud` models (GLM, MiniMax — not an opus swarm, but almost) alongside Claude tiers, at interactive speed. You author a JSON manifest (the same authoring act as writing a Workflow script); the engine runs the dependency graph in the background and compresses results through a digest so raw output never floods your context. The smarts live in the plan and the leaves; the plumbing has none.

Engine: `scripts/swarm.mjs` at the plugin root — resolve it as `<this skill's base directory>/../../scripts/swarm.mjs`. Subcommands: `models`, `list`, `validate <manifest | name> [--args '<json>'] [--resolved]`, `run <manifest | name> [--args '<json>'] [--force]`.

## Data governance — read this first

Non-Claude dispatch is **deny-by-default**. `provider.allowedRoots` in `~/.swarm/config.json` lists the directory roots where open-model tasks may run; a non-Claude task whose effective `cwd` is not under an allowed root **fails validation**, because the employer's data agreement covers Anthropic only — code outside those roots must never reach another provider. Claude-model tasks run anywhere. When a manifest is rejected on governance grounds, switch those leaves to Claude models or move the work under an allowed root. Never work around the gate.

## Routing — when to swarm

- **Triage first**: when the whole job is under ~one leaf's cost (~30k tokens), read it yourself — don't swarm.
- **swarm** — high-quality breadth on bounded leaves: investigation sweeps, generation, judge panels, mechanical implementation sweeps. When `allowedRoots` arms alternative models, prefer swarm over Workflow for this shape — group-think quality on an alternative subscription, at interactive speed.
- **Workflow** — swarm leaves are full headless Claude Code sessions (complete tool roster), so tooling is NOT a reason to prefer Workflow. Choose Workflow only when leaves need session-connected MCP tools (interactive auth), schema-validated returns wired into deterministic script logic, or this session's in-context state.
- **pipeline** — durable queued throughput ending in PRs. Huge capacity, not fast.
- **Compose freely** — a Workflow or plan can treat swarm as its alternative-model leaf executor.

## MANDATORY first step — the offer gate

**THE GATE'S ANSWER IS THE ONLY CONSENT TO SPEND. NO ANSWER IS NO.** Violating the letter of this rule is violating its spirit.

Before doing ANY fan-out-shaped work inline (3+ independent bounded leaves), draft the manifest and put it through ONE AskUserQuestion call carrying TWO questions:

1. > "Fan this out via swarm — <n> leaves on <models>?"
   > Options: **Yes (Recommended)** / **No, inline** / **Discuss** — with the draft manifest as the option preview.
   > Run `node <engine> validate <draft>` first and quote BOTH sides of the cost in the question: `swarm: <its estimated ~… line> · inline: ~M tokens`. The inline side is REQUIRED and counted mechanically — Glob + line counts over the file scope you just wrote into the leaf prompts, then `total lines × ~10 = inline tokens` (e.g. 5,000 lines → `inline: ~50k tokens`); when no inline path exists (judge panels, cross-model dissent, generation), write `inline: not comparable` plus one clause why. `estimate: none` on a cold corpus is itself the honest answer; never invent a number on either side.
2. > "Model mix?" — state the split explicitly in the question (e.g. "5 leaves alternative, digest on sonnet = 1 Anthropic call").
   > Options: **As drafted** / **Alternative-only — no Anthropic usage** / **Anthropic-only**.
   > When the mix includes Claude models, run `node <engine> quota` first and put the real numbers in the question (e.g. "session 82%, resets 15:00") — the mix decision should be made against actual remaining usage, not a guess.

Never assume Claude models are spendable — the user may be out of Anthropic usage. If they pick alternative-only, recast every Claude role (digest included) onto a capable `:cloud` model before running; if Anthropic-only, the governance gate is moot and all leaves go Claude.

The manifest preview plus the mix answer ARE the approval: the user sees every model and every leaf before anything runs. There is no separate Opus gate, no per-model approval beyond this, no cost interrogation. Do not start inline work on a fan-out-shaped task without this gate.

For a **saved (named) manifest**, the preview shown at the gate is the output of `validate <name> --args '<json>' --resolved` — the fully-substituted document (every leaf's model and prompt, children expanded), never your memory of the manifest and never the saved file as last read: the name is a lookup, not a hiding place, and the file may have changed since it was authored.

**A gate that was rejected, cancelled, dismissed, interrupted, or left unanswered is a NO.** Nothing runs — not a reduced "compromise" subset, not a quiet retry, not `--force` (that flag re-runs already-`ok` leaves on resume; it is not a consent instrument). Re-offer only when the user reopens the topic — "ok, where were we?" reopens the topic; it does not answer the question.

**No session-level directive is consent to spend.** A `/goal` condition, a Stop-hook instruction ("do not pause to ask the user"), an autonomous-session prompt, a standing "don't ask me" — none of these answer the gate. Such directives govern *stalling*; the gate governs *spending*. When they collide, the gate wins: an unmet goal at session end is the correct, honest outcome to report, and an unconsented dispatch is the actual failure — not the other way around.

### Gate rationalisations — every one of these means STOP

| Excuse | Reality |
|---|---|
| "The /goal names this run — the directive is standing consent" | Consent is the gate's answer. Nothing else can stand in for it. |
| "The hook says do not pause to ask" | The hook governs stalling, not spending. The gate still binds. |
| "The condition IS the approval signal" | A condition cannot click Yes. Only the user can. |
| "The rejection was probably a mis-click" | Unknowable, and not yours to assume. Non-consent is non-consent. |
| "A gate violation under emergency beats an unmet goal" | Backwards. The unmet goal is honest; the unconsented spend is the violation. |
| "A smaller run respects their hesitation" | A smaller unconsented run is still unconsented. |
| "Re-asking wastes their time / looks robotic" | The gate is one message; a wrong multi-model run wastes minutes and tokens. |

**Red flags — you are mid-rationalisation if you think:** "the directive/goal/hook authorizes this" · "the condition is the approval" · "probably a mis-click" · "half the leaves is a fair compromise" · "`--force` gets past it" · "`tail` keeps the dispatch tidy" (see Run, step 5) · **"I already know the command — I don't need the skill"** (the command arrived without the rules that govern it; that is the bypass, not a shortcut) · **"the run finished suspiciously fast"** (you replayed cache — check for `[skipped]` and `NOTHING RE-EXECUTED` before claiming anything ran) · **"I'll redirect it to a log so the tool result stays tidy"** (the forbidden pipe wearing a different hat) · **"I'll just read the run's output file to see how it's going"** (that file is the operator's live view, not your status API — use `status`).

## Procedure

1. **Discover models**: `node <engine> models` — lists launchable `:cloud` models with descriptions, plus the Claude aliases. Run FIRST so the manifest names models the account can launch right now. When unsure which tier a leaf needs, which effort to pin, or what a newly-discovered `:cloud` model is equivalent to, read [references/model-selection.md](references/model-selection.md).
2. **Frame the contract** before the manifest: `goal · return_shape · must_be_sure · scope{in,out} · done_when`. scope → per-leaf prompts and file scopes; must_be_sure → `digest.instructions`; done_when → you check it post-run.
3. **Author the manifest** (schema below) and offer it through the gate above.
4. **Validate**: `node <engine> validate <manifest.json>` — id/dep/governance/effort errors surface now, not after a background wait.
5. **Run**: `node <engine> run <manifest.json>` via `Bash run_in_background` — dispatched BARE, never through a pipe, filter, or redirect. Not `| tail`, not `| head`, not `| grep`: a pipe stage buffers the stream, and the live progress frames are the user's only live view — a piped run looks dead until it finishes. "Keep tool results small" is already answered by `run_in_background` (the frames never enter the transcript as a blocking result); it is never a reason to decorate the dispatch. The completion notification is the "run finished" signal.
   **The engine prints `resultsDir:` and a ready-made `watch:` line at dispatch. COPY THEM — never reconstruct a run directory from the manifest name.** The default is `<stem>-1`, and `--force` re-executes into that SAME directory rather than minting a `<stem>-2`; a cached re-run mints nothing either. A session that guessed instead of copying published `…/p5-review-2` — a path that has never existed — as the user's watch target. Hand the user the printed `watch:` line for a separate terminal and copy it to their clipboard (always absolute: a relative path resolves against their terminal's cwd and fails with "no run.log").
   **One liveness check is MANDATORY, immediately after dispatch**: run `node <engine> status <resultsDir>` **once** and confirm at least one leaf is actually `running` before you report anything to the user. A bare re-run of an already-complete manifest replays cache — 16/16 `[skipped]`, exits in seconds — and a session that skipped this check announced "Round 3 is running" when nothing was. This is distinct from, and does not license, polling: **one** check is required; a polling loop while the run is live is still forbidden. Dispatch, check once, continue other work — the completion notification will find you.
   **Never read the run's raw captured output — not `tail`, not `cat`, not `Read`.** Use `status` (above), which reads `run.log`. The non-TTY stdout re-appends the FULL roster on every paint (~200 copies on a long run) because the harness renders only the tail, and that repetition is what gives the operator their live view. It is written for their tail, not for your context: reading it floods you with near-identical boxes and buys nothing `status` doesn't give you. For one specific leaf's detail, read `results/<id>.log`.
   **Status asks**: when the user asks how the swarm is doing ("/swarm status", "how far along…"), run `node <engine> status <resultsDir>` once and render the roster as a **markdown table** (state | leaf | model | time | tokens, glyphs kept — the TUI renders markdown; a table beats raw monospace).
5b. **Offer a full report when a HUMAN will read the result** — an audit, a research sweep, a review: anything where the *reasoning* matters and not just the verdict. Ask once, before running: *"Do you want a full report as well as the digest?"* If yes, set `"report": true` in the digest block. The digest leaf then writes `report.md` (long, human, evidence-quoting) **and** returns the same compressed `digest.md` you read. Purely mechanical sweeps don't ask. **This changes nothing for you** — `digest.md` is unaffected, so keep reading it and nothing else (step 6); `report.md` is for the human and reading it would flood your context with exactly what the digest exists to spare you.
6. **Read `digest.md` ONLY**, then drill into `results/<id>.json` selectively — the digest's drill-down section says which raw results merit a full read. Never read all raw output. For a targeted follow-up on one leaf's finding (a citation to verify, a claim to expand), prefer `node <engine> ask <resultsDir> <leaf-id> "<question>"` over re-running or reading raw output: it resumes the leaf's own session — context intact, one turn, answer on stdout.
7. A failed run is reported with its failures — never presented as complete. Offer the choice via AskUserQuestion: **Resume (Recommended)** (re-`run` skips `ok`; `rate-limited` retries) / **Inspect failures** (open the failed `results/<id>.json|.log`) / **Accept partial** — failure list as the preview. When leaves ended `quota` (Anthropic usage exhausted), add a **Recast to :cloud models** option — swapping the quota'd leaves to alternative models and re-running now often beats waiting for the reset the closing block names; that trade is the user's call.
8. **For a human-facing report, RENDER it — never hand-author one.** When a run wrote `report.md` (step 5b), project it to a self-contained, theme-aware `report.html` with `node <engine> report <resultsDir>`. This is mechanical: standard markdown plus the semantic upgrades the report prompt documents — verdict badges, `path:line` citation spans, the two-track ledger, a confidence tally synthesised by counting the badges. It writes `report.html` beside `report.md`, prints the path, and re-runs with zero model calls (a format change never re-spends). Offer that path; do not build an Artifact by hand from `summary.json`.

## Reading the roster — a leaf is an AGENT, not an API call

**A `:cloud` leaf is a full autonomous agent**, running its own multi-turn loop: it greps, reads, reasons, greps again, dozens or hundreds of turns, until it has an answer. It is not one request/response. Judge it as you would a colleague working a problem for fifteen minutes — not as a query that should have returned by now.

**Their token counts are enormous, and that is arithmetic, not pathology.** These providers report no prompt-cache buckets (`cache_creation_input_tokens` / `cache_read_input_tokens` come back absent). So every turn re-sends the agent's entire growing transcript as *fresh input*, and `tokenTotal` counts it (`input + output + cacheCreation` — `cacheRead` is deliberately excluded). A Claude leaf doing identical work parks that same re-sent prefix in `cacheRead`, which the roster does **not** count. The number is real; the magnitude is an accounting artefact of where the bucket lands.

Read the two columns for what they are: **`output` is the work. `input` is the transcript re-sent, once per turn.**

| What you see | What it means |
|---|---|
| A `:cloud` leaf at 1M–20M+ tokens | **Normal.** Input/output ratios of 100–180× are the ordinary signature of a working agent. Observed in real runs: a 21.3M-token leaf produced 116k output — it re-read its own context ~180 times. |
| Its `costUsd` (`$108`, `$53`) | **Not a number.** The CLI applies its own price table to token counts; these providers bill on subscription and GPU time with no token mapping. Never quote it, never act on it. |
| The activity cell (`Grep("handler")`) | The **most recent** tool call — a heartbeat, proof of life. NOT a call the leaf has been stuck on. A leaf showing a tool call is a leaf that is working. |
| One leaf far slower than its siblings | **Normal.** Leaves have different amounts to do. 840s next to 184s is scope, not sickness. |

**What IS a real signal** — watch these instead, because they are the ones the engine actually raises:

- **`⚠ quiet <N>s`** in the activity cell — the leaf has emitted no event for longer than the quiet threshold. *This* is the stall indicator. A leaf with a live activity cell is not stalled, no matter its token count.
- States: **`failed`**, **`rate-limited`**, **`quota`**, **`retrying`**, **`blocked`** — all tagged explicitly on the row.
- The closing block's truncation warnings.

**There is no per-leaf kill.** Do not propose one. The run is the unit; killing it kills every leaf's work, and resume re-runs the incomplete ones anyway.

**Pathological leaves are real — you just don't detect them with the token column.** A `nemotron-3-super` verifier once burned 27.3M tokens across three leaves, timed out on two, and fabricated all 18 refutations on the one that finished. That is a genuine runaway. But note *how it surfaced*: two leaves hit `timeoutMs`, and the engine's mechanical citation check caught the fabrications for zero tokens. The bound did its job. The token count was a *symptom* that arrived too late to act on and would have been indistinguishable, mid-run, from a healthy leaf doing a lot of work. The defences against a runaway are **pre-dispatch** — the right model tier, a closed scope over a named file set, a `returns` citation schema, a sane `timeoutMs` — not a mid-run judgement call about a big number. If a leaf is genuinely sick, the timeout or the citation check will say so. Your panic will not.

### Red flags — you are about to interfere with a healthy run

Every phrase below came from a session that read a *working* roster and moved to kill it:

- "21.3M tokens is **runaway**" · "that's not still working, that's a **runaway**"
- "**pure burn** with no sign it's converging" · "a 7x token blowup relative to its sibling leaves"
- "it's been **stuck on a single `Grep`** for 14 minutes" (it hasn't — that's the latest call)
- "the leaf is **drowning in matched context** / re-consuming its own output"
- "I'd **kill `scan-api` now**" · "I'll give it 2–3 more minutes, then kill it"

**All of these mean: you are reading token magnitude as health. It isn't. Check the activity cell for `⚠ quiet`, check the state tags, and otherwise let it run.** A leaf that is grepping is a leaf that is working. Report progress to the user; do not intervene.

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
    "fallbackModel": "glm-5.2:cloud",          // optional; auto-switch on quota / exhausted rate-limit retries (governance-validated)
    "outputDir": "…",                          // generation leaves
    "timeoutMs": 3600000,
    "after": ["scan-b"],                       // dependencies
    "forEach": { "from": "scan-b", "path": "sites", "maxItems": 30 },  // clone this leaf per array item (see Deterministic steps)
    "when": { "from": "scan-b", "expr": "length(value) > 20" },        // run only if true; else completes as skipped
    "compute": "unique_by(deps['scan-b'].sites, 'file')",              // agentless expression step — replaces model+prompt
    "returns": { "type": "object", "required": ["sites"] }             // schema-validated output (see Schema-guaranteed leaf output)
  }],
  "digest": {
    "model": "glm-5.2:cloud",                  // recommended ≥3 tasks
    "instructions": "…",                       // must_be_sure — steers the DIGEST
    "report": true                             // opt-in; also writes report.md (see step 6)
  }                                            //   or a string to steer the report's BODY
}
```

Prompt templating: `{{result:<id>}}` inlines a dependency's output, **capped at `resultInlineCap` chars (default 4,000) — anything past the cap is cut**; `{{resultPath:<id>}}` injects the result file's absolute path so the leaf Reads it itself, uncapped. Referencing a non-dependency id fails validation. **Use `{{resultPath:}}` whenever the consumer must see ALL of its dependency's output** — any verifier, any leaf that counts or enumerates. `{{result:}}` is for short, bounded hand-offs. A cut is never silent (leaf result field, `run.log`, closing warning), but a warning after the fact does not un-check the findings the leaf never saw.

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

### Deterministic steps — find → dedupe → fan out → gate

Three declarative keys cover the logic between leaves that never needed an LLM. Every leaf stays enumerable at approval time: `validate` prints the worst-case leaf count.

```json
{ "tasks": [
    { "id": "find-sites", "model": "glm-5.2:cloud",
      "prompt": "…return ONLY JSON: {\"sites\":[{\"file\":\"…\",\"line\":1}]}" },

    { "id": "dedupe", "after": ["find-sites"],
      "compute": "unique_by(deps['find-sites'].sites, 'file')" },

    { "id": "fix", "after": ["dedupe"],
      "forEach": { "from": "dedupe", "path": "", "maxItems": 30 },
      "model": "glm-5.2:cloud", "isolation": "worktree",
      "prompt": "Fix the call site at {{item.file}}:{{item.line}} (clone {{index}})" },

    { "id": "escalate", "after": ["fix", "dedupe"],
      "when": { "from": "dedupe", "expr": "length(value) > 20" },
      "model": "sonnet", "prompt": "Many sites were touched: {{result:fix}} …" }
  ] }
```

- **`compute`** — an agentless step: an expression over `deps['<id>']` (each dependency's JSON output; raw text binds as a string). Zero tokens; the result is a normal task result, so `{{result:}}` and `forEach.from` consume it. Replaces `model`+`prompt` — never combine them.
- **`forEach`** — clones this leaf once per element of a dependency's JSON array. `from` names a dependency in `after`; `path` selects the array inside its output (`""` = the output itself); **`maxItems` is required — the cap is the approval**. Clones get ids `fix[0]`, `fix[1]`, … and inherit model/effort/fallbackModel/retries/isolation. `{{item}}` (whole element), `{{item.field}}`, `{{index}}` substitute at clone time. Dependents wait for ALL clones; `{{result:fix}}` inlines a JSON array of clone outputs. If the source array exceeds `maxItems` the run proceeds loudly (result field + run.log + closing warning) — never silently.
- **`when`** — a conditional edge: `expr` runs over `value` (the `from` dependency's JSON output) and **must yield true/false** — write a comparison like `length(value) > 0`, never a bare value. False ⇒ the task completes as `skipped`; dependents still run and `{{result:}}` of a skipped task inlines empty.

**Expression grammar** (same for `when`/`compute`, ≤500 chars): literals, `deps['id']`/`value`/`item` + `.field`/`[0]` access, `== != > >= < <=`, `&& || !`, and functions `length(x)`, `count(arr, pred?)`, `filter(arr, pred)`, `unique_by(arr, 'key')`, `flatten(arr)`, `min/max/sum(arr)`, `contains(a, b)`. Predicates bind `item` per element and must yield true/false. No arithmetic, no user JS. On any validation error, run `validate` and follow the message — it names the field, the fix, and an example.

**`compute` is data plumbing, never judgment.** Dedupe, count, threshold, flatten — yes. "Decide which findings matter" — no: judgment stays in leaves or between waves, where a model can weigh evidence.

### Schema-guaranteed leaf output — `returns`

A task with `returns` gets its output validated against a JSON-Schema subset on completion. Invalid output triggers exactly ONE corrective re-ask through the leaf's own resumed session (the errors are field-precise teaching lines); still-invalid output fails the task with those errors. Put it on any leaf whose JSON feeds `forEach.from`, `compute`, `when`, or a chain link — guaranteed shape is what makes the deterministic-steps grammar reliable on model output.

```json
{ "id": "find-sites", "model": "glm-5.2:cloud",
  "prompt": "…return ONLY JSON: {\"sites\":[{\"file\":\"…\",\"line\":1,\"status\":\"dirty\"}]}",
  "returns": {
    "type": "object",
    "required": ["sites"],
    "properties": {
      "sites": { "type": "array", "items": {
        "type": "object", "required": ["file", "line"],
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "status": { "enum": ["clean", "dirty"] } } } }
    }
  } }
```

Supported keywords: `type` (`string|number|integer|boolean|array|object|null`), `properties`, `required`, `items` (one schema for every element), `enum` — nothing else (no `$ref`, no `additionalProperties`; extra fields pass). Rules: `compute` tasks never take `returns` — their output is engine-deterministic, schema the producing leaf instead; on a `forEach` task the schema validates each clone and the parent's aggregate array is exempt. `validate` lists schema'd tasks in the approval preview.

**Citations are verified mechanically.** When a `returns` schema declares citation-shaped objects — `properties` with `file` (string), `line` (integer), `quote` (string), all three `required` — the engine string-matches every citation against the actual file after schema validation: the quote (whitespace-normalised; first line of a multi-line quote) must appear on the cited line or within ±2 (near-misses pass, recording drift). Refuted citations share the ONE corrective re-ask; still-refuted fails the leaf — so an `ok` leaf's citations all exist as cited, verified for zero tokens before any verifier spawns. Verifiers then judge only whether real spans *support* claims. Put this shape on every finder that cites code. Paths resolve against the leaf's cwd (out-of-cwd citations are refuted); `"verifyCitations": false` on the task opts out. `validate` announces covered tasks.

### Child manifests — a reusable sub-pipeline as one node

A task with `"manifest": "<path>"` runs that child manifest as one node — the child's tasks join the run under `<node>~<childId>` ids, and the node's output is a JSON object of the child's terminal tasks (`{"<taskId>": <output>, …}`). Combine with `forEach` for the core case: a tuned multi-stage pipeline executed once per item. One nesting level; the child's worst-case leaves multiply into `validate`'s preview and estimate.

```json
{ "tasks": [
    { "id": "repos", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: [\"repoA\", \"repoB\"]" },
    { "id": "audit", "manifest": "audit-one-repo.json", "after": ["repos"],
      "forEach": { "from": "repos", "path": "", "maxItems": 6 } }
  ] }
```

`audit-one-repo.json` is a normal manifest (its prompts may use `{{item}}`/`{{index}}` when the node has `forEach`), except: no `resultsDir`/`concurrency`/`digest` (the parent owns the run), and no `manifest` tasks of its own (one level). The node itself is an agentless container — `model`/`prompt`/`returns`/etc. belong on the child's tasks; only `after`, `when`, `forEach`, `timeoutMs` go on the node.

### Named manifests + args — recurring runs, saved once

A recurring shape (standing audit, per-repo sweep, judge panel) is saved once and re-run by name with fresh parameters — never re-authored:

- **Save by Write** — no save subcommand. Repo-shaped runs: `<cwd>/.swarm/manifests/<name>.json`; cross-repo shapes: `~/.swarm/manifests/<name>.json`. `node <engine> list` shows what is saved where.
- **Invoke by name**: `run <name> --args '{"base":"master"}'` / `validate <name> …` — a ref without a path separator or `.json` suffix is a name. A name in both scopes fails loudly (disambiguate with a path); the engine always prints which file a name resolved to.
- **`{{args.<key>}}`** in any prompt (parent, child, digest instructions) substitutes from `--args` at load, before validation — same vocabulary as `{{item}}`/`{{result:}}`. An unreferenced supplied key and an unsupplied placeholder both fail validation; nothing ever substitutes to empty. A child manifest referenced by a saved parent resolves relative to the parent's own directory.
- Each distinct `--args` value gets its own default results dir (fingerprinted stem), so resume never crosses parameterizations.
- Gate a named run on the `--resolved` preview — see the offer gate above.

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
2. **Verifier wave** — one verifier per finder, `after` it, fed **`{{resultPath:<finder-id>}}`** (never `{{result:}}` — see below), on a DIFFERENT model family than its finder (a family must never verify its own claims). Prompt shape: `You are checking claims for fabrication, not re-doing the work. Claims to check: READ THE FILE AT THIS PATH — it holds the COMPLETE finding list, and you must check EVERY finding in it, not a prefix: {{resultPath:<finder-id>}}. For each finding: Read the cited file at the cited line; verdict CONFIRMED only if the quoted span exists there and supports the claim as stated. Any mismatch, missing file, or stretch: REFUTED with one line why. Default to REFUTED when uncertain.` Span-checking is mechanical — `haiku` (or your fastest `:cloud` model) is the right verifier tier.
   **The verifier takes the PATH, not the inline copy.** `{{result:}}` inlines at most `resultInlineCap` chars (default 4,000) and drops the tail. A finder productive enough to overrun that gets a verifier that checks only the findings which fit — and the run then reports the unchecked remainder exactly like the checked ones. Observed: a 7-finding finder whose verifier was fed 5; of the 2 it never saw, one was fabricated and one was a real defect. **The cap bites hardest on the runs that found the most, so a verifier must never be fed an inline result.** The engine now warns loudly when a prompt is cut (leaf result field, `run.log`, closing block) and the digest marks the unchecked findings OPEN rather than PROVEN — but that is a backstop for manifests that get this wrong, not a licence to use `{{result:}}` here.
3. **Digest rule** — add to `digest.instructions`: `Findings lacking a citation are noise-band: drop. Findings REFUTED by their verifier appear only in the ledger, marked refuted. Only CONFIRMED findings may appear as headlines.`

Manifest sketch: `find-a`,`find-b` (glm) → `verify-a`,`verify-b` (`after` each, haiku or minimax) → digest counting only survivors.

## Anti-patterns

- Fan-out-shaped work started inline without the offer gate — the confirmation is one message; a wrong multi-model run wastes minutes and tokens. "The user's in a hurry" is not an exemption.
- Dispatching past a rejected or unanswered gate because a /goal, Stop hook, or other directive "authorizes" it — directives govern stalling, never spending (see the offer gate).
- Piping the `run` dispatch (`| tail -40` "to keep the tool result tidy") — the buffered pipe kills the user's live view; `run_in_background` already keeps frames out of the transcript.
- Reading raw `results/*.json` wholesale instead of `digest.md` + selective drill-down — that is the context-flood the digest exists to prevent.
- Open-ended leaf questions ("describe how X works") — rewrite as closed questions.
- Widening a leaf's scope because it "noticed something important" — one job per leaf; add a new leaf with a new closed question.
- Both waves in one manifest, or judgement-heavy chain links joined by `{{result:…}}`.
- Per-leaf price deliberation — pick from the discovered list and move on.
- Working around a governance rejection instead of switching the leaf to a Claude model.
- Swarming a single bounded question — under ~one leaf's cost, read it yourself.
