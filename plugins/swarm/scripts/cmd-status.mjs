// `swarm status <resultsDir> [--watch]` and `swarm status --mine` — split out of swarm.mjs,
// which now just dispatches to it, the same shape as cmd-grade.mjs. One command's two modes:
// a progress view of one run, and the session-scoped list of runs still holding worktrees.
import { getConfig, swarmHome } from "../src/config.mjs";
import { costOfFor } from "../src/run-cost.mjs";
import { renderStatus } from "../src/results.mjs";
import { launcherSession } from "../src/scheduler.mjs";
import { dim, out, err } from "../src/ui.mjs";

// This session's finished runs whose kept worktrees are still on disk, each with the
// command that prunes it. Read-only — it prunes nothing — and it lists every run this
// session owns while its trees remain, including the ones the nudge hook has already
// named: the marker gates the hook's line, never this listing.
async function mine() {
  const sessionId = launcherSession(process.env);
  if (!sessionId) {
    err("swarm: status --mine needs a session — set CODEX_SESSION_ID or CLAUDE_CODE_SESSION_ID, or name one run dir: swarm status <resultsDir>.");
    return 1;
  }
  const { projectRunsHoldingWorktrees, formatMineStatus } = await import("../src/prune-nudge.mjs");
  const { realRepoToplevel } = await import("../src/manifest-leaf-guard.mjs");
  // A missing toplevel is not an all-clear: runs are filed per repo, so the scan below
  // would find nothing and print the empty case from anywhere outside a checkout.
  const cwd = process.cwd();
  const toplevel = realRepoToplevel(cwd);
  if (!toplevel) {
    err(`swarm: status --mine needs a git repo — ${cwd} is not inside one.`);
    return 1;
  }
  const runs = projectRunsHoldingWorktrees({ home: swarmHome(process.env), toplevel, sessionId });
  for (const line of formatMineStatus(runs)) out(line);
  return 0;
}

export async function cmdStatus(rest) {
  // Parsed before the positional dir: `--mine` is a flag, and rest[0] is a path.
  if (rest.includes("--mine")) return await mine();
  const quietWarnMs = (getConfig().quietWarnSecs ?? 60) * 1000;
  if (rest.includes("--watch")) {
    const ivIdx = rest.indexOf("--interval");
    const secs = ivIdx >= 0 ? Math.max(1, Number(rest[ivIdx + 1]) || 5) : 5;
    // Repaint until Ctrl-C. Env override lets tests bound the loop.
    const maxTicks = Number(process.env.SWARM_WATCH_TICKS) || Infinity;
    for (let i = 0; i < maxTicks; i++) {
      process.stdout.write("\x1b[2J\x1b[H");
      out(renderStatus(rest[0], Date.now(), quietWarnMs, costOfFor(getConfig())));
      out(dim(`(watch: refreshing every ${secs}s — Ctrl-C to exit)`));
      await new Promise((r) => setTimeout(r, secs * 1000));
    }
    return 0;
  }
  out(renderStatus(rest[0], Date.now(), quietWarnMs, costOfFor(getConfig())));
  return 0;
}
