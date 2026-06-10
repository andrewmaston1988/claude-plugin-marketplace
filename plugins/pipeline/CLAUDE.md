# pipeline plugin — local conventions

## Plans directory

Every consumer that asks "where do this project's plan files live?" routes
through `src/plans-resolver.mjs::resolvePlansDir`. There is no second
implementation — `src/cli/rows.mjs` (`backlog-scan`, `row-add`),
`src/dashboard/shared/load-backlog.mjs`, `scripts/session-gen.mjs`, and
`src/cli/demo.mjs` all share the same answer. Adding a new caller? Import
the helper.

**Resolution precedence**:

1. Project-row `plans_dir` column (literal absolute path, set via
   `pipeline project-add --plans-dir <abs>` / `project-update`). Wins for
   that one project.
2. `cfg.plansDir` from `~/.pipeline/config.json` — a template; placeholders
   substituted per-project; relative paths resolve against the project root.
3. `<project-root>/plans` — historical default.

**Placeholder vocabulary** (handled by `resolveTemplate` in
`scripts/worktree-paths.mjs`):

| Placeholder | Source |
|---|---|
| `{root}` | the project root path |
| `{root_parent}` | `dirname(root)` |
| `{root_grandparent}` | `dirname(dirname(root))` |
| `{project}` | the project name |

Leading `~/` expands to the home directory; absolute paths pass through.
Unknown placeholders render literally — a typo (`{projetc}/plans`) produces
a visibly-wrong path rather than silently dropping to the default.

**Signature**: `resolvePlansDir({ project, projectRoot, projectPlansDir, _config })`
returns an absolute path. `_config` is the test-injection point; production
callers omit it. `projectPlansDir` is the literal value from the project
row's `plans_dir` column when the caller has it (currently only
`load-backlog.mjs`); other callers may omit it.

A companion helper `resolvePlanFile(planFile, opts)` resolves a single plan
filename: absolute paths pass through; bare filenames join under the
project's plans directory.
