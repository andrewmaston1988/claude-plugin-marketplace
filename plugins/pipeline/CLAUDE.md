# pipeline plugin — internal conventions

## Path resolution

Every config-driven path in this plugin resolves through one helper:
`resolveTemplate(template, vars, { resolveBase, configDir })` in
`scripts/worktree-paths.mjs`. No bespoke per-key logic.

### The rule (§A)

1. Substitute `{placeholder}` tokens from `vars`. Unknown placeholders pass
   through literally. `{config_dir}` is filled from the `configDir` option.
2. Expand a leading `~/` to `os.homedir()`.
3. Classify the result:
   - Absolute (POSIX `/...`, drive letter `C:\...`, UNC `\\server\share`) →
     use verbatim.
   - Otherwise → resolve against `resolveBase`.

### Categories (§B)

| Category | `resolveBase` | Keys |
|---|---|---|
| Per-project    | `projectRoot`    | `plansDir`, `governor.reports_dir`, `governor.session_dir`, `governor.log_dir`, `worktree_base` *(future)* |
| Global / install-wide | `paths.configDir` | `notifications.fallback_dir`, `session_templates_dir`, `hooks.on_notification`, `hooks.on_merge_ready`, `hooks.on_merge`, `governor.template_path` |
| Within-worktree | resolved `featureWorktreePath(...)` | `report_subpath` |

`paths.configDir` resolves to `~/.pipeline` on Mac/Windows and
`$XDG_CONFIG_HOME/pipeline` (fallback `~/.config/pipeline`) on Linux —
see `src/paths.mjs`.

Hook values are command strings; only the first whitespace-separated token
is routed through `resolveTemplate`. Trailing argv is passed through
unchanged.

### Placeholder vocabulary (§C)

| Placeholder | Source |
|---|---|
| `{root}`             | `projectRoot` (per-project context) |
| `{root_parent}`      | `dirname(projectRoot)` |
| `{root_grandparent}` | `dirname(dirname(projectRoot))` |
| `{project}`          | `project` or `basename(projectRoot)` |
| `{feature}`          | row feature / plan stem |
| `{kind}`             | `"code-review"` / `"qa-test"` |
| `{branch}` / `{branch_type}` / `{branch_local}` | orchestrator branch context |
| `{config_dir}`       | `paths.configDir` |

The canonical exported list is `PLACEHOLDER_KEYS` in
`scripts/worktree-paths.mjs`. Operator-facing skill docs read it from there
so the source of truth never drifts.

### Surfacing config to users

When a skill or doctor check prompts the operator about a config key, follow
the contract in `skills/pipeline-setup/SKILL.md` ("How to surface each config
option"): explain what the key controls, show the resolved default for this
machine, give 2–3 example values, document consequences, and accept
follow-ups.

### Locators

Resolution chains for external binaries (e.g. claude-slack) live under
`src/locators/`. Each locator returns `{ path, source }` where `source` is
the resolution-chain step that found it (`"env"`, `"cache"`, `"path"`, or
`null`). Both wizard and doctor consume the same locator — never duplicate
the chain inline.
