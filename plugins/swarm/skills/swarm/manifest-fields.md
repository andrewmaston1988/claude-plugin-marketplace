# Manifest field reference — schemas, child manifests, named runs, integrate.from

Deep reference for five manifest features. Read when you are actually writing one of
these fields; the decision of *whether* to use them lives in SKILL.md.

### Provider identity

\`provider\` is optional task metadata. When it is omitted, swarm resolves the model
from the provider-qualified cache and registered model matchers, then falls back to
the legacy Ollama identity. A model prefix such as \`gpt-5-codex\` never selects Codex
by itself; use \`"provider": "codex"\` or a cache row whose provider is \`codex\`.

\`fallbackModel\` is resolved independently, so a fallback may change both the model
and provider. Digest blocks accept the same optional \`provider\` field. The resolved
primary/fallback/digest identities are retained in the run's effective manifest
snapshot; \`runner\` is derived internally and is not manifest grammar.

Provider-specific roots and enabled state are checked during validation and again at
dispatch. Codex tasks reject Claude-only \`settings\` and configured project leaf
guards unless the task explicitly sets \`"leafGuard": false\`.

The public provider registry supplies discovery, usage, and runner capabilities. Pin
\`provider\` explicitly when the same model id is available from more than one provider.

### Prompt length on Windows

A leaf's `prompt` is measured through the CreateProcess-quoted command line at `swarm validate` time; a prompt over ~32k characters on Windows fails validation — point the leaf at a file holding its instructions instead of inlining it.

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
      "model": "opus",
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
    { "id": "repos", "model": "glm-5.2:cloud", "prompt": "…return ONLY JSON: [\"repoA\", \"repoB\"]" },
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
