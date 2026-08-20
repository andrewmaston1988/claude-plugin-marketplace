# Manifest authoring — schema, plan patterns, leaf shapes

Read this to understand a field in the manifest the driver built from your shape
file, or to write a `digest` block into that shape file. The driver owns the tasks
array; the plan patterns below describe the graphs it emits and the leaf shapes
that work inside them.

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
    "isolation": "worktree",                   // private tree (implementation leaves); OR
                                               //   { "worktree": "feat" } — SHARED tree, phased chains, see Plan patterns
                                               //   optional "branch": names the branch explicitly (default swarm/<worktree>)
                                               //   optional "from": base this tree on that task's branch, not repo HEAD
                                               //     (that task must WRITE — a read-only task owns no branch)
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

**Asked as dispatch** ("run a glm-5.2 session on swarm")? One delegated leaf — see below.

**How to place tasks and what shape that yields — including the placement digraph —
lives in [execution-strategy.md](execution-strategy.md) §3.** It is mandatory reading
before the offer gate, and the driver delivers it by path. Not repeated here: two copies
of a decision procedure diverge, and the one you did not edit is the one that gets read.

What follows are the field-level recipes for the shapes that procedure produces.

### Single delegated leaf

One leaf, no `after`, no digest — reading `results/<id>.json` *is* the digest. The shape for
work that is perfectly doable inline but shouldn't be: when this session's context is scarce,
when a finished swarm missed something, or when the result should be auditable on disk.

```json
{ "tasks": [
    { "id": "check", "model": "glm-5.2:cloud",
      "prompt": "Your single job: <closed question>.
File scope: <paths>.
Return ≤10 bullets: claim, file:line. No prose. If you cannot answer, say so in one line." }
  ] }
```

**The offer gate is a judgement call here, not a mandate** — it covers fan-out-shaped work
(3+ leaves). Say what you are about to dispatch and on which model so the operator can
redirect it, but a request already phrased as dispatch has made that call. The Iron Law's
hands-off rule applies in full once the leaf is running.

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

`{{result:<id>}}` passes raw (capped) output between links, so each link's *output* contract must be hard: **"return ONLY the N facts the next step needs."** It passes text, never edits — a link that must build on the previous link's *changes* needs a phased chain instead.


### Phased chain — one branch, implement → review → implement

Phases of one feature that must accumulate on a single branch. Every link names the
same worktree; `after` orders them; the reviewer holds no write tools and warns the
next implementer through `{{result:}}`.

```json
{ "tasks": [
    { "id": "p1", "model": "glm-5.2:cloud", "isolation": { "worktree": "feat" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "Phase 1: <scope>.\nCommit your work before you finish — the next link builds on your commits." },

    { "id": "p1-review", "model": "kimi-k2.7-code:cloud", "after": ["p1"],
      "isolation": { "worktree": "feat" }, "allowedTools": "Read,Grep,Glob",
      "prompt": "Review phase 1 in this worktree (git log/diff to see it).\nReturn ONLY: (a) defects with file:line, (b) risks phase 2 must avoid. No prose." },

    { "id": "p2", "model": "glm-5.2:cloud", "after": ["p1-review"],
      "isolation": { "worktree": "feat" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "Phase 2: <scope>.\nThe phase-1 reviewer warned:\n{{result:p1-review}}\nFix what it flagged, then do phase 2. Commit before you finish." }
  ] }
```

**Rules that make it work:**

- **Every link names the same worktree.** All links sharing a name must be totally ordered by `after` — validation rejects an unordered pair, because they would race in one directory.
- **Reviewers get no write tools.** `allowedTools: "Read,Grep,Glob"`. A reviewer that edits is not reviewing, and a leaf holding `Write` can write anywhere — withholding the tool is the only real confinement.
- **Every implementing prompt must say "commit before you finish."** The engine never commits for a leaf. Uncommitted work still reaches the next link (same tree), but the history is what makes a failed link recoverable.
- **The tree is collected once**, after the last link — so one entry in `worktreesKept`, with a diffstat spanning every phase.
- **Re-running a link redoes its successors.** Transitive cache invalidation already handles this: fix p2, re-run, and p3/p4 redo their work on the corrected base.
- **`forEach` cannot share a worktree** — clones are concurrent by construction.
- **A leaf that branches off the chain needs its OWN worktree.** If it is not ordered against the chain's later links (a docs leaf that needs only phase 1's design, say), it cannot share their tree — sharing demands total ordering, which would force a false dependency. Give it `isolation: "worktree"` with `"from"` naming the link it builds on — the last link that WRITES, never the reviewer between them — so it starts from that commit without joining the chain.
- **A worktree name does not carry across manifests.** The tree lives under the
  run's `resultsDir`, so a later manifest naming the same worktree gets a *new*
  tree — and its branch `swarm/<name>` already exists, which fails. To put a tree
  on a specific branch, name it: `"isolation": { "worktree": "p3", "branch":
  "swarm/eco-p3" }`. The engine refuses to reset a branch that carries commits
  HEAD does not have, so a previous run's phases cannot be silently discarded.

**How a verifier link works.** A reviewer with no write tools still does its whole job,
because its findings do not travel through files:

- **Its output is its return value.** The engine writes every leaf's result to
  `results/<id>.json`; the next link reads it via `{{result:<reviewer-id>}}`. A reviewer
  never needs `Write` to report — it needs `Write` only to *change* things, which is the
  one thing it must not do.
- **It sees more than a fresh checkout.** Same working directory as the link before it, so
  it reads that link's commits *and* anything left uncommitted. `git log`, `git diff`, and
  the files themselves all work.
- **It never ends the chain's tree.** Collection is deferred to the group's last link, so a
  reviewer changing nothing cannot trigger the empty-tree cleanup that would delete the
  work its successor needs.
- **Giving a reviewer write tools breaks the contract silently.** It will fix things
  instead of reporting them, and `{{result:}}` then describes work the next link cannot
  see the reasoning for. Nothing in the engine prevents this — `--allowedTools` is
  tool-name-only and a leaf holding `Write` can write anywhere — so the tool list is the
  whole mechanism.

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

### Mixed topology — one manifest whose width changes more than once

A run may narrow to one task and widen again:

```json
{ "tasks": [
    { "id": "survey-a", "model": "minimax-m3:cloud", "prompt": "…closed question A…" },
    { "id": "survey-b", "model": "minimax-m3:cloud", "prompt": "…closed question B…" },

    { "id": "helper", "model": "glm-5.2:cloud", "after": ["survey-a", "survey-b"],
      "isolation": { "worktree": "feat" }, "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "Read {{resultPath:survey-a}} and {{resultPath:survey-b}}. Write the helper. Commit before you finish." },

    { "id": "migrate-x", "model": "glm-5.2:cloud", "after": ["helper", "survey-a"],
      "isolation": { "worktree": "migrate-x", "from": "helper" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "…migrate every site in {{resultPath:survey-a}}. Commit before you finish." },
    { "id": "migrate-y", "model": "glm-5.2:cloud", "after": ["helper", "survey-b"],
      "isolation": { "worktree": "migrate-y", "from": "helper" },
      "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "…migrate every site in {{resultPath:survey-b}}. Commit before you finish." },

    { "id": "join", "after": ["migrate-x", "migrate-y"],
      "integrate": { "into": "feat", "from": ["migrate-x", "migrate-y"] } },

    { "id": "cleanup", "model": "glm-5.2:cloud", "after": ["join"],
      "isolation": { "worktree": "feat" }, "allowedTools": "Read,Grep,Glob,Edit,Write,Bash",
      "prompt": "…delete the dead code, run the suite. Commit before you finish." }
  ] }
```

Width goes `2 → 1 → 2 → 1`. This validates today: `migrate-x` and `migrate-y` are
**separate private trees**, so the shared-worktree ordering rule never applies to
them, while the `feat` group (`helper`, `cleanup`) stays totally ordered through
them.

- **`{{result:}}` / `{{resultPath:}}` reach only a DIRECT dependency.** In a wide graph the
  task you want is often a grandparent — `migrate-x` needs the survey, but its `after` names
  only `helper`. Referencing it anyway fails validation; add the upstream id to `after` too
  (`["helper", "survey-a"]`). The extra edge changes no ordering, it declares what the
  prompt reads.
- **A private tree branches from repo HEAD unless you say otherwise.** `"from": "<task id>"`
  bases it on that task's branch instead, so the leaf starts with the code it depends on. The
  named task must be a declared dependency, worktree-isolated, and able to WRITE — `validate`
  says so if not.
- **`from` names a TASK that commits, not the STAGE this leaf follows.** Ordering is what
  `after` expresses; `from` answers a narrower question — whose branch carries the code. In a
  fan-out → review → fan-out shape those are different tasks by construction: the last task in
  a stage is usually a reviewer, and a reviewer owns no branch, so `from` must reach *past* it
  to the last writer. Pass the reviewer's findings as information instead:
  `{ "after": ["review", "extract"], "isolation": { "worktree": "impl", "from": "extract" }, "prompt": "The reviewer reported: {{result:review}} …" }`.
  `from` is where the CODE comes from; `{{result:X}}` is where the INFORMATION comes from.
- **A task only owns a branch if it COMMITS.** A leaf that changes no files has its worktree
  reaped, and `from` naming it fails at runtime with `cannot resolve base`. `validate` rejects
  the provable case — a source with no write tools at all. It cannot catch a reviewer holding
  `Bash` to run a test suite: that reads as write-capable but still commits nothing. Judge by
  what the task DOES, not by its tool list. If a task exists to report rather than to change
  code, it is never a `from` target — and a consolidator that only reads result files needs no
  worktree at all.
- **Sibling trees do not see each other.** `migrate-x` and `migrate-y` each carry `helper`'s
  work but not each other's. Fold them back with an **`integrate`** node — agentless like
  `compute`, so it spends nothing — which merges each named task's branch into `into`:
  `{ "id": "join", "after": ["migrate-x", "migrate-y"], "integrate": { "into": "feat", "from": ["migrate-x", "migrate-y"] } }`.
  Every id in `from` must be a task that WRITES, for the same reason `isolation.from` must be:
  a read-only task has no branch to merge.
  **A conflict is not a failure**: the merge stops with markers in the tree, the node stays
  `ok`, and the conflicting paths land in its result — pass `{{result:join}}` to the next leaf
  and tell it to resolve them. Without an integrate node that merge is the next leaf's job.

### Sweep-then-synthesize

Fan-out plus an explicit synthesis leaf — sweeps with no `after`, then one task `after: [all sweeps]` reading `{{resultPath:…}}` for each. Use when synthesis needs richer instructions than the digest, or a Claude tier. (The *Mixed topology* example above shows the shape.)

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

### Deeper manifest fields — read on demand

Three features have field-by-field semantics too long to carry here. Read
[manifest-fields.md](manifest-fields.md) when you are writing one of them:

- **`returns`** — JSON-Schema validation of a leaf's output, the one corrective re-ask, and
  the mechanical citation check. Read it before schema'ing any finder that cites code.
- **`manifest`** — running a saved child manifest as one node, `forEach` over it, and what
  the node may and may not carry.
- **Named manifests + `{{args.<key>}}`** — saving a recurring shape and re-running it by
  name with fresh parameters.

### Two waves — the between-wave synthesis is yours

**Invariant: wave 2 never starts until wave 1 results are compressed into `[SHARED_CONTEXT]` (≤400 words).** Wave 1 explores (fan-out manifest + digest); then **you** (the session) synthesize `[SHARED_CONTEXT]` covering: **data model** (exact names, key schema facts), **API contract** (exact interfaces, response structures), **existing conventions** (patterns, helpers, file locations wave-2 leaves must follow). Wave 2 is a second manifest embedding it verbatim in each leaf prompt — `isolation: "worktree"` for implementation leaves, `outputDir` for plan/generation leaves — plus per-leaf: "Do not claim files outside your scope boundary" and "List dependencies under `## Prerequisites` (use `- none`)". Encoding both waves in one manifest is FORBIDDEN: the between-wave synthesis is the judgement step and must not be delegated to the plan. **This governs *discovery* waves only — where wave 2's prompts cannot be written until wave 1's findings are read and compressed.** A structure known upfront is not a two-wave run: a phased chain, or any mixed topology whose leaves you can already write (see *Mixed topology*), belongs in ONE manifest with `after` doing the ordering. If you can author every prompt now, it is one manifest.

## Leaf shapes

| Shape | Recipe |
|---|---|
| Investigation | Read-only tools (the default), closed question, ≤10-bullet return contract |
| Review | Prompt demands a JSON verdict; engine stores raw + parsed |
| Generation | `outputDir`; no isolation field needed |
| Implementation | `isolation: "worktree"` — results are branches to review; unchanged worktrees are removed, changed ones kept and listed in the summary |

Write-capable tools (Edit/Write/Bash) without `isolation: "worktree"` get the leaf's cwd auto-redirected to a scratch dir — a leaf never writes in the real tree unless explicitly worktree-isolated.

