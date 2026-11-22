## Step 2 — Build the command

Assemble flags from answers. Show the user **the full command including the flags they didn't choose** so they see the defaults that are about to be applied:

```
pipeline setup --non-interactive
  [--register-project <name>:<absolute-path>]
  [--worktree-layout 1|2] [--worktree-base "<template>"]
  [--slack <channel>]
  [--pipeline-channel <channel>]
  [--governance-channel <channel>]
  [--models dev_default=...,review_default=...,governor=...]
  [--review-skill <name>]
  [--review-deep-flag <flag>]
  [--plans-dir <template>]
  [--merge-hook <abs-path>]
  [--on-merge <abs-path>]
  [--merge-check <abs-path>]
  [--recognised-branch-types <list>]
  [--no-deps]
  [--no-autostart]
  [--no-path-alias]
  [--continue-on-failed-prechecks]
```

Wait for confirmation before running. The setup writes to `~/.pipeline/config.json` and your shell profile — the user must see what's about to happen.

## Step 3 — Run it

```bash
node "$PIPELINE_BIN" setup --non-interactive <flags>
```

Stream the output (it walks the 11 wizard steps). It should end with:

> All checks passed.
> Setup complete!

If a check fails, surface it and offer either to re-run with `--continue-on-failed-prechecks` (proceed despite warnings) or to fix the underlying issue first. The most common failures:

- **No git on PATH** — install Git.
- **Node < 22** — pipeline needs `node:sqlite` which is 22+. Upgrade or use `nvm use 22`.
- **Already-registered project's root_path is missing** — earlier demo crash leftover; `pipeline project-remove <name> --purge` clears it.

## Step 4 — Tell them what's next

After success, summarise what just changed and what they can do now:

- `~/.pipeline/config.json` written (models, Slack channels, project list)
- `~/.pipeline/pipeline.db` is the SQLite DB the orchestrator + dashboards read
- Orchestrator autostart entry installed (if they chose)
- `pipeline` PATH alias added to shell profile (if they chose) — **restart their shell** for the interactive alias to take effect; the `~/.local/bin` shim works immediately
- At least one project registered (if they chose)

Suggested next moves:

- `pipeline doctor` to confirm everything's wired (works without shell restart via the shim)
- `/pipeline demo` to see the full lifecycle end-to-end with narration
- `/queue <plan-file> dev` to queue real work in a registered project

## Anti-patterns

- **Don't run the wizard directly.** It hangs without a TTY. Always pass `--non-interactive`.
- **Don't ask every question with no context.** Every question gets the what/default/implication trio so the user knows what they're agreeing to.
- **Don't ask about every single model.** Defaults are good; only ask when the user has a reason.
- **Don't proceed without showing the assembled command.** Setup writes to `~/.pipeline/config.json` and shell profile — the user must see what's about to happen.
