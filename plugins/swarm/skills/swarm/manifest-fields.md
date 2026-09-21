# Manifest field reference — schemas, child manifests, named runs, integrate.from

Deep reference for six manifest features. Read when you are actually writing one of
these fields; the decision of *whether* to use them lives in SKILL.md.

### Where a leaf runs — the write tools decide

**A leaf that can write gets its own tree; a leaf that cannot reads the live repo.** Nothing
declares this — `allowedTools` already says which a leaf is, and a second field saying the
same thing is a second field to disagree with.

| The leaf holds | It runs in | Its branch |
|---|---|---|
| `Read,Grep,Glob` (the default) | the live repo, at the `cwd` it was given | none — it commits nothing |
| `Edit`, `Write` or `Bash` | a private worktree on repo HEAD | `swarm/<run>/<id>`, scoped to this run |

So granting `Bash` to a leaf moves it out of the live repo into a tree of its own. That is
intended, and worth knowing when you add the tool.

A writer sits at the same depth in its tree as in the live checkout, so cwd-relative paths in
its prompt still resolve. A gitignored cwd (`build/`, `.claude/worktrees/x`) is created in the
tree, since the checkout never carried it.

Two optional keys, both writer-only, both omitted by the common case:

- **`workspace`** — the name of a tree SHARED with other leaves. Reach for it when leaves must
  accumulate on one branch (a phased chain). Every leaf naming one workspace must be totally
  ordered by `after`: two unordered members would race in one directory, and validation
  refuses them.
- **`branch`** — a stable branch name instead of the derived one. Naming it opts out of run
  scoping by construction, so a second run of the same manifest meets the first's kept tree.
  That is the point of naming it; `prepareIsolation` still refuses to reset a tree holding
  unlanded commits.

A writer whose `cwd` is not inside a git repository is refused — there is no repo to branch
from. A reader has no such constraint: it reads wherever it was pointed, which is how a leaf
reads logs or a data dump outside any repo. `compute`, `integrate` and `manifest` nodes spawn
no leaf, so none of this applies, and naming either key on one is refused.

```json
{
  "tasks": [
    { "id": "survey", "provider": "claude", "model": "claude-haiku-4-5-20251001", "prompt": "…" },
    { "id": "impl", "provider": "claude", "model": "claude-sonnet-5", "allowedTools": "Read,Edit,Bash", "prompt": "…" },
    { "id": "review", "provider": "claude", "model": "claude-sonnet-5", "after": ["impl"], "allowedTools": "Read,Edit,Bash",
      "workspace": "feat", "prompt": "…" },
    { "id": "read-logs", "provider": "claude", "model": "claude-haiku-4-5-20251001", "cwd": "C:/logs", "prompt": "…" }
  ]
}
```

`survey` reads the live repo; `impl` gets a private tree without asking; `review` shares the
`feat` tree with anything else naming it; `read-logs` reads a directory that is not a repo.

**To start a tree from another task's commits, use an `integrate` node** — it creates the
target tree and merges the named branches into it. There is no key for basing one tree on
another's branch.

### Provider identity

`provider` is **required** on every leaf — Claude ones too — and nothing is inferred:
not from the model name, not from the discovery cache, and there is no Ollama fallback.
A leaf without it fails `validate` with the fix and an example. `provider` is one of
`claude`, `ollama`, `codex` (or a registered provider). Compute, integrate and manifest
nodes spawn no leaf and take none.

```json
{ "id": "a", "provider": "claude", "model": "claude-opus-5", "prompt": "…" }
```

Claude aliases (`haiku`, `sonnet`, `opus`, `fable`) are refused as model names under any
provider — name the full id (`claude-opus-5`). Grades are filed under the model you author,
so an alias would split one model into two score rows.

`fallbackModel` needs its own `fallbackProvider` (a Claude primary cannot force a Codex
fallback, and vice versa); `fallbackProvider` without `fallbackModel` is refused. The digest
block requires `provider` too. The resolved primary/fallback/digest identities are retained
in the run's effective manifest snapshot; `runner` is derived internally and is not
manifest grammar.

Provider-specific roots and enabled state are checked during validation and again at
dispatch. Codex tasks reject Claude-only `settings` and configured project leaf
guards unless the task explicitly sets `"leafGuard": false`.

### Effort — `effort`

`effort` is optional. Every dispatching leaf receives an explicit effort: the manifest
value wins, otherwise the model's provider-declared default is used, otherwise swarm
uses `"medium"`. When the provider declares an effort list, swarm rejects a value that
is not in that list; undeclared models accept any non-empty effort.

The public provider registry supplies discovery, usage, and runner capabilities.

### Context window — `contextWindow`

`contextWindow` is an opt-in per-leaf field for `:cloud` models whose real window is 1M:

```json
{ "id": "sweep", "provider": "ollama", "model": "glm-5.3:cloud",
  "contextWindow": "1m", "prompt": "…" }
```

The only accepted value is `"1m"`. It asks Claude Code to take its 1M path by suffixing the
CLI model name; swarm keeps the model identity itself bare, so score history, denylist
matching and provider API calls still see `glm-5.3:cloud`, not `glm-5.3:cloud[1m]`.

Known windows today: `glm-5.3:cloud`, `deepseek-v4.1-flash:cloud` and
`glm-5.3-flash:cloud` have 1M windows; `minimax-m3:cloud` has 512k. Do not put
`"contextWindow": "1m"` on a model whose real limit is lower: the leaf may avoid early
compaction only to hit provider API errors past the true window.

There is no partial-window manifest value for `:cloud` leaves. A 512k model such as
`minimax-m3:cloud` cannot declare 512k through swarm today, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
does not reach `:cloud` models. The 1M route is also measured at about +45% `:cloud` meter
cost for the same output, so treat it as supported rather than recommended.

Claude-model leaves use the existing `disable1mContext` / `CLAUDE_CODE_DISABLE_1M_CONTEXT`
path instead of this field. Codex tasks reject `contextWindow`, and Ollama `launch` mode
rejects it because the launcher validates the suffixed model name before Claude Code can
interpret `[1m]`.

### Prompt length on Windows

A leaf's `prompt` is measured through the CreateProcess-quoted command line at `swarm validate` time; a prompt over ~32k characters on Windows fails validation — point the leaf at a file holding its instructions instead of inlining it.

### Schema-guaranteed leaf output — `returns`

A task with `returns` gets its output validated against a JSON-Schema subset on completion. Invalid output triggers exactly ONE corrective re-ask through the leaf's own resumed session (the errors are field-precise teaching lines); still-invalid output fails the task with those errors. Put it on any leaf whose JSON feeds `forEach.from`, `compute`, `when`, or a chain link — guaranteed shape is what makes the deterministic-steps grammar reliable on model output.

```json
{ "id": "find-sites", "provider": "ollama", "model": "glm-5.2:cloud",
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

**Citations are verified mechanically — warn, never destroy.** When a `returns` schema declares citation-shaped objects — `properties` with `file` (string), `line` (integer), `quote` (string), all three `required` — the engine string-matches every citation against the actual file after schema validation: the quote (whitespace-normalised; first line of a multi-line quote) must appear on the cited line or within ±2 (near-misses pass, recording drift). A refuted citation shares the ONE corrective re-ask; a still-refuted one **never fails the leaf and never deletes the finding** — it is annotated in place (`citation: "verified" | "drift" | "refuted"`), the leaf stays `ok` with its output intact, and the closing block plus `citations: {checked, drifted, refuted}` say so loudly. The mechanical check cannot tell a fabrication from a whitespace-mangled quote of a real line (decompiled/minified code defeats it), so it flags; the **verifier wave** — an LLM that reads the file — is what rules. Put this shape on every finder that cites code, and route its output through a verifier. Paths resolve against the leaf's cwd (out-of-cwd citations are refuted); `"verifyCitations": false` on the task opts out. `validate` announces covered tasks.

**Finder-prompt guidance: quote a SHORT distinctive fragment (10–40 chars), not the whole line.** The check matches a substring of the cited line, so a fragment of a 200-char decompiled line verifies where a reformatted full-line quote would refute. Tell finders to cite the smallest span that identifies the code, and to omit any finding whose quote they cannot vouch for — the gate is the backstop, the finder prompt is the front line.

### Proven read coverage — `mustRead`

A leaf with `mustRead` must prove, from its OWN transcript, that it `Read` the files/ranges it declares. After the run the engine parses the leaf's stream-json for `Read` tool calls and checks each required range against them; a shortfall shares the same ONE corrective re-ask as `returns`/citations (the re-ask names each uncovered range with a ready-to-paste `Read offset <a> limit <n>`), then — still short — **is recorded, never fails the leaf** (same warn-not-destroy discipline as citations: the checker can be wrong, the consumer rules). The result carries `coverage: { status, required, read, missed }`, `run.log` a `{event:"coverage"}` line, `mechanicalOf` a `coverage` column, and the closing block a loud line. Put it on a reviewer or verifier that MUST have seen the principle doc / diff shard before it opines.

```json
{
  "tasks": [
    {
      "id": "review-arch",
      "prompt": "Review the scheduler for architectural defects.",
      "provider": "claude", "model": "claude-opus-5",
      "allowedTools": "Read,Grep,Glob",
      "mustRead": [
        "plugins/swarm/src/scheduler.mjs",
        { "path": "plugins/swarm/src/coverage.mjs", "lines": [[1, 120], [200, 260]] }
      ]
    }
  ]
}
```

Entry forms: a bare string (whole file — the engine reads it to count lines, an empty file requires nothing); `{ "path", "lines": [[a, b], …] }` (exactly those ranges); `{ "index": "<file>", "lane": <n>? }` (a JSON `{ entries, lanes? }` doc whose entries expand to requirements — one level, no nesting). A `{{resultPath:<dep>}}` in a `path`/`index` resolves to the dep's result file (dep must be in `after`; only `resultPath`, never `{{result:}}`). Rules: leaf-only (never `compute`/`integrate`/`manifest` nodes); on a `forEach` task it copies to every clone unchanged (same lane per clone); relative paths resolve against the leaf's cwd, absolutes stand (principle files and shards live outside the worktree); Read paths compare case-insensitively on Windows; only the `Read` tool counts (a Bash `cat`/`sed`, a Grep, an MCP read do not — they carry no checkable offset/limit and the harness truncates Bash output). Only a claude stream-json transcript is understood (which covers `:cloud` models through the claude CLI); any other runner fails closed — the whole requirement is recorded missed. Cap: 500 entries (use an index above that). `validate` announces enforced tasks.

### Child manifests — a reusable sub-pipeline as one node

A task with `"manifest": "<path>"` runs that child manifest as one node — the child's tasks join the run under `<node>~<childId>` ids, and the node's output is a JSON object of the child's terminal tasks (`{"<taskId>": <output>, …}`). Combine with `forEach` for the core case: a tuned multi-stage pipeline executed once per item. One nesting level; the child's worst-case leaves multiply into `validate`'s preview and estimate.

```json
{ "tasks": [
    { "id": "repos", "provider": "ollama", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: [\"repoA\", \"repoB\"]" },
    { "id": "audit", "manifest": "audit-one-repo.json", "after": ["repos"],
      "forEach": { "from": "repos", "path": "", "maxItems": 6 } }
  ] }
```

`audit-one-repo.json` is a normal manifest (its prompts may use `{{item}}`/`{{index}}` when the node has `forEach`), except: no `resultsDir`/`concurrency`/`digest` (the parent owns the run), and no `manifest` tasks of its own (one level). The node itself is an agentless container — `model`/`prompt`/`returns`/etc. belong on the child's tasks; only `after`, `when`, `forEach`, `timeoutMs` go on the node.

### Folding a `forEach` fan-out back — `integrate.from` naming the parent

`integrate.from` accepts a `forEach` task's id, meaning **every clone that expanded from
it**: `from: ["fix"]` resolves at merge time to `fix[0]`…`fix[n-1]`, in index order — exactly
as if the author had listed the clones by hand, which is impossible at authoring time since
clone ids are minted at run time from the source array's length. `integrate()` itself is
unchanged: it still merges named branches sequentially into the `into` worktree, a content
conflict still leaves markers plus a `conflicts` list with the node `ok`. A capped or empty
`forEach` source leaves nothing to merge; a failed clone is handled exactly as a failed
hand-listed source is today. `validate`'s preview line reuses the `forEach`'s own cap:
`join ≤ 30 branches (fix forEach)`. See the README's "Folding a forEach fan-out back" for the
worked example.

### Named manifests + args — recurring runs, saved once

A recurring shape (standing audit, per-repo sweep, judge panel) is saved once and re-run by name with fresh parameters — never re-authored:

- **Save by Write** — no save subcommand. Repo-shaped runs: `<cwd>/.swarm/manifests/<name>.json`; cross-repo shapes: `~/.swarm/manifests/<name>.json`. `swarm list` shows what is saved where.
- **Invoke by name**: `swarm run <name> --args '{"base":"master"}'` / `swarm validate <name> …` — a ref without a path separator or `.json` suffix is a name. A name in both scopes fails loudly (disambiguate with a path); the engine always prints which file a name resolved to.
- **`{{args.<key>}}`** in any prompt (parent, child, digest instructions) substitutes from `--args` at load, before validation — same vocabulary as `{{item}}`/`{{result:}}`. An unreferenced supplied key and an unsupplied placeholder both fail validation; nothing ever substitutes to empty. A child manifest referenced by a saved parent resolves relative to the parent's own directory.
- Each distinct `--args` value gets its own default results dir (fingerprinted stem), so resume never crosses parameterizations.
- Gate a named run on the `--resolved` preview — see the offer gate in `SKILL.md`.
