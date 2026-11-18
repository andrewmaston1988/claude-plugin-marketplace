// The CLI usage text: every subcommand, its arguments, and one line on what it does.
export const USAGE = `usage: swarm.mjs <command>
  models [--all]             list launchable models from enabled providers (+ Claude aliases)
  list                       saved manifests (<cwd>/.swarm/manifests + ~/.swarm/manifests)
  validate <manifest.json | name> [--args '<json>'] [--resolved]   lint; exit 1 with readable errors
  run <manifest.json | name> [--args '<json>'] [--force]   execute the plan (use Bash run_in_background)
  status <resultsDir>        one-shot progress view of a run (reads run.log)
  status <resultsDir> --watch [--interval <secs>]   live repaint until Ctrl-C
  status --mine              this session's finished runs still holding kept worktrees, each with its prune command
  wait <resultsDir> [--timeout <secs>]  block until the run settles, then print the final roster (exit 0 clean · 1 leaf not ok · 2 engine died · 3 timed out)
  stop <resultsDir>          cooperative stop: signal a live engine and wait, or record a dead one — never kills a process
  prune <resultsDir> [--dry-run] [--discard-unlanded]   deletes at once — --dry-run previews; refuses a live run, keeps unlanded or dirty work and names it
  compact <path> [--dry-run]  strip inline image bytes from every leaf transcript under a results dir, run dir or runs root — --dry-run measures only, a live run is skipped
  mcp list [--json]          MCP servers a leaf starts, with today's off/on state and the repos that turn one on
  mcp set --off <a,b> [--repo <repo>=<servers>]…   write the leaf MCP config: the off list plus the repos that turn one back on
  report <resultsDir>        render the run's digest.md/report.md → digest.html/report.html (self-contained, theme-aware; backfill for old runs)
  ask <resultsDir> <taskId> "<question>" [--model <m>]   resume a finished leaf's session with a follow-up
  quota | usage              provider utilization per limit window (exit 1 when Anthropic is exhausted)
  ollama-usage [--cookie '<value>']   ollama.com :cloud weekly-allowance meter (exit 1 when exhausted)
  grade --init <resultsDir>  write grades.json — one skeleton row per model leaf (Claude tiers included), for you to fill in
  grade --file <grades.json>   validate the filled batch and append it to ~/.swarm/model-scores.jsonl
  grade --waive <resultsDir> --reason "<text>"   excuse a run from grading — writes grade-waiver.json, never a store row
  perf [--aspect X] [--model Y] [--domain D] [--overall]   aspect x model table; --overall = one combined ranking
  scores backfill-realmodel [--dry-run]   rewrite alias-named score rows to the model their leaf transcript reports
  cost                       one cost list per provider, cheapest to dearest (meter + static rate cards)
  refresh-prices [--dry-run]   re-read both vendors' published price tables and bank them at ~/.swarm/rate-cards.json
  serve [--daemon]           phone dashboard over ~/.swarm/runs on the LAN (config: dashboard.enabled/port/bind/token)
  serve restart | doctor | stop | status | enable | disable | install-autostart | uninstall-autostart
  config init                write every shipped key into ~/.swarm/config.json, keeping what is set and folding an old-shaped file ("provider"/"codex") into "providers" — it prints the mapping and leaves the previous file at config.json.bak; the /swarm:swarm setup skill walks it
  statusline install         write the self-resolving statusline shim to ~/.swarm/statusline.mjs and print the settings.json line
  install                    put swarm on PATH: bash + cmd wrappers and the resolver copy in ~/.local/bin (idempotent; never edits a shell profile)`;
