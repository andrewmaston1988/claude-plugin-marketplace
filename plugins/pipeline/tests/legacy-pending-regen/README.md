# Legacy pending-regen — surviving smoke tests

The parity fixtures (`tests/parity-fixtures/`) and runner (`tests/parity-runner.mjs`)
were regenerated against the unified-DB schema as part of plan #1 closure. What
remains here is the surviving corpus of pre-unified-DB **unit** tests that target
APIs the plan reshaped.

| File | Status under unified DB |
|---|---|
| `smoke-3.3.mjs` | Tests `rowAdd(db, {…})` (no project arg) and the old per-project DB pattern. The unified DB requires `rowAdd(db, project, {…})`; rewriting this duplicates `smoke-7-projects.mjs`. Not worth reviving. |
| `smoke-3.5.mjs` | Tests `discoverProjects()` (deleted), `worktreePath()` (deleted), and the old single-project rowAdd. Replaced by `smoke-7-projects.mjs::listEnabledProjects` coverage. Not worth reviving. |
| `smoke-4.mjs` | Tests `renderTemplate`, `loadPipelineConfig`, schema idempotency. Mostly schema-agnostic — should still pass with import-path updates, but no live regression gate guards this surface today. Candidate for revival. |
| `smoke-5.mjs` | Tests `runDoctor` shape with 5 results. Doctor will be rewritten to 11 checks in plan #6 — wait for that plan, then regenerate. |
| `smoke-6.mjs` | Tests session-gen placeholder expansion. Independent of unified-DB. Should still pass with import-path updates. Candidate for revival. |

**To revive a file:** copy back into `tests/`, swap any `rowAdd(db, {…})` calls to
`rowAdd(db, project, {…})`, and adjust import paths from `../scripts/…` to remain
relative to `tests/`. Then run `node --test tests/<file>` to verify.
