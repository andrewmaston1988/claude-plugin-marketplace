// Floating action menu for the selected pipeline row. Opens on Enter, runs
// the chosen action by shelling out to the pipeline CLI, then refreshes.
// Style matches the rest of the dashboard: rounded borders, Tokyo Night
// palette, centered label, selection bg via blessed.list with
// invertSelected: false so inline fg colors survive.
import blessed from "blessed";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import {
  C_BG, C_BORDER_ACT, C_TEXT, C_DIM, C_HEADER_HL, C_SELECTED, C_RED,
  STAGE_COLOR,
  fg,
} from "./style.mjs";

const HERE       = fileURLToPath(new URL(".", import.meta.url));
const PIPELINE_BIN = resolve(HERE, "..", "..", "..", "bin", "pipeline.mjs");

// Action menu options derived from the row's stage + branch existence.
// Returns an array of
// { label, action } where action is the routing key.
export function menuOptions(row, branchExists = true) {
  const opts = [];
  const stage = row.stage;
  if (["backlog", "dev", "research", "review", "test", "queued"].includes(stage)) {
    const prefix = stage === "backlog" ? "Queue → " : "Re-queue → ";
    opts.push({ label: `${prefix}Research`,      action: "queue:research" });
    opts.push({ label: `${prefix}Dev`,           action: "queue:dev"      });
    if (branchExists) {
      opts.push({ label: `${prefix}Review (branch found)`, action: "queue:review" });
      opts.push({ label: `${prefix}Test   (branch found)`, action: "queue:test"   });
    }
  }
  if (!["backlog", "done"].includes(stage) && !row.virtual) {
    opts.push({ label: "Return to backlog", action: "stage:backlog" });
  }
  if (stage !== "done" && !row.virtual) {
    opts.push({ label: "Delete row + plan file", action: "delete" });
  }
  // Cancel is always present so Esc isn't the only way out.
  opts.push({ label: "Cancel", action: "cancel" });
  return opts;
}

// Open a confirm prompt above the action menu. Resolves true on yes.
function confirm(screen, message) {
  return new Promise((resolveConfirm) => {
    const box = blessed.box({
      parent: screen,
      top: "center", left: "center", width: 50, height: 7,
      border: { type: "line" },
      tags: true,
      label: { text: ` ${fg(C_RED, " confirm ")} `, side: "left" },
      style: {
        border: { fg: C_RED, bg: C_BG },
        label:  { bg: C_BG, fg: C_RED },
        bg:     C_BG, fg: C_TEXT,
      },
      content: `\n  ${message}\n\n  ${fg(C_DIM, "Press y to confirm · n / Esc to cancel")}`,
    });
    screen.render();
    const handler = (_ch, key) => {
      if (key && (key.name === "y")) { cleanup(); resolveConfirm(true); }
      else if (key && (key.name === "n" || key.name === "escape")) { cleanup(); resolveConfirm(false); }
    };
    function cleanup() {
      try { screen.removeListener("keypress", handler); } catch {}
      try { box.destroy(); } catch {}
      screen.render();
    }
    screen.on("keypress", handler);
  });
}

// Run a pipeline CLI subcommand. Returns { code, stdout, stderr }. Spawns
// `node <bin/pipeline.mjs> <argv...>` so it doesn't depend on a PATH entry.
// 30s timeout — a hung subcommand should never block the TUI input loop.
const RUN_PIPELINE_TIMEOUT_MS = 30_000;
function runPipeline(argv) {
  return new Promise((res) => {
    const proc = spawn(process.execPath, [PIPELINE_BIN, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch {}
      res({ code: -1, stdout: out, stderr: err + `\n[runPipeline timeout after ${RUN_PIPELINE_TIMEOUT_MS}ms]` });
    }, RUN_PIPELINE_TIMEOUT_MS);
    proc.stdout.on("data", (b) => out += b.toString());
    proc.stderr.on("data", (b) => err += b.toString());
    proc.on("close", (code) => { if (!timedOut) { clearTimeout(timer); res({ code, stdout: out, stderr: err }); } });
    proc.on("error", (e) => { if (!timedOut) { clearTimeout(timer); res({ code: -1, stdout: "", stderr: String(e) }); } });
  });
}

// Run the chosen action for `row` in `project`. Returns {ok, message} so the
// caller can flash a status line. `refreshFn` lets us trigger a data re-pull
// after the CLI exits without coupling this module to the dashboard's state.
export async function runAction(screen, project, row, action, refreshFn) {
  // queue:<stype> → re-queue the row's plan as <stype>
  if (action.startsWith("queue:")) {
    const stype = action.split(":")[1];
    const planPath = row.plan_file;
    if (!planPath || !existsSync(planPath)) {
      return { ok: false, message: `plan file missing: ${planPath || "<none>"}` };
    }
    const r = await runPipeline(["queue-plan", project, planPath, "--type", stype]);
    if (refreshFn) refreshFn();
    return r.code === 0
      ? { ok: true,  message: `queued ${row.feature} as ${stype}` }
      : { ok: false, message: (r.stderr || r.stdout).trim().split("\n").pop() };
  }
  // stage:<name> → stage-set
  if (action.startsWith("stage:")) {
    const newStage = action.split(":")[1];
    const r = await runPipeline(["stage-set", project, row.feature, newStage]);
    if (refreshFn) refreshFn();
    return r.code === 0
      ? { ok: true,  message: `${row.feature} → ${newStage}` }
      : { ok: false, message: (r.stderr || r.stdout).trim().split("\n").pop() };
  }
  // delete → confirm + row-delete + unlink plan file
  if (action === "delete") {
    const ok = await confirm(screen, `Delete ${row.feature}? plan file will also be removed.`);
    if (!ok) return { ok: true, message: "cancelled" };
    const r = await runPipeline(["row-delete", project, row.feature]);
    if (row.plan_file && existsSync(row.plan_file)) {
      try { unlinkSync(row.plan_file); } catch {}
    }
    if (refreshFn) refreshFn();
    return r.code === 0
      ? { ok: true,  message: `deleted ${row.feature}` }
      : { ok: false, message: (r.stderr || r.stdout).trim().split("\n").pop() };
  }
  if (action === "cancel") return { ok: true, message: "cancelled" };
  return { ok: false, message: `unknown action: ${action}` };
}

// Open the action menu modal. Returns a Promise resolved with the action
// outcome from runAction (or null if the menu was cancelled).
export function openActionMenu(screen, project, row, refreshFn) {
  return new Promise((resolveMenu) => {
    const opts = menuOptions(row, /* branchExists */ true);
    if (opts.length === 0) { resolveMenu(null); return; }

    // Label includes the row's stage tag —
    // `<feature>  <stage>` in the modal's border title.
    const stageColor = STAGE_COLOR[row.stage] || C_DIM;
    const labelText  = ` ${fg(C_HEADER_HL, ` ${row.feature} `)}${fg(C_DIM, "·")} ${fg(stageColor, row.stage)} `;
    const box = blessed.box({
      parent: screen,
      top: "center", left: "center", width: 60, height: opts.length + 4,
      border: { type: "line" },
      tags: true,
      label: { text: labelText, side: "left" },
      style: {
        border: { fg: C_BORDER_ACT, bg: C_BG },
        label:  { bg: C_BG, fg: C_HEADER_HL },
        bg:     C_BG, fg: C_TEXT,
      },
    });

    const list = blessed.list({
      parent: box, top: 0, left: 0, right: 0, bottom: 0,
      tags: true, keys: true, vi: true, mouse: false,
      interactive: true, invertSelected: false,
      style: {
        bg:       C_BG,
        fg:       C_TEXT,
        item:     { bg: C_BG, fg: C_TEXT },
        selected: { bg: C_SELECTED },
      },
      items: opts.map(o => `  ${o.label}`),
    });

    list.focus();
    list.select(0);
    screen.render();

    function close(result) {
      try { box.destroy(); } catch {}
      screen.render();
      resolveMenu(result);
    }

    list.key(["escape", "q"], () => close(null));
    list.on("select", async (_item, idx) => {
      const chosen = opts[idx];
      close(null);
      const result = await runAction(screen, project, row, chosen.action, refreshFn);
      resolveMenu(result);
    });
  });
}
