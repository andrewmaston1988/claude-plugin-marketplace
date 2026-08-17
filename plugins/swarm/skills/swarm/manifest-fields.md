# Manifest field reference — schemas, child manifests, named runs

Deep reference for three manifest features. Read when you are actually writing one of
these fields; the decision of *whether* to use them lives in SKILL.md.

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
- Gate a named run on the `--resolved` preview — see the offer gate in `SKILL.md`.
