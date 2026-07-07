// Floating modal for orchestrator control. Opens on `o`, shows current
// status (running / not started / stale) + offers Start / Stop / Cancel.
// Start spawns the orchestrator detached so it outlives the TUI process.
import blessed from "blessed";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  C_BG, C_BORDER_ACT, C_TEXT, C_DIM, C_HEADER_HL, C_SELECTED, C_RED, C_GREEN,
  fg,
} from "./style.mjs";

const HERE       = fileURLToPath(new URL(".", import.meta.url));
const ORCH_ENTRY = resolve(HERE, "..", "..", "orchestrator", "index.mjs");

function _options(orch) {
  const opts = [];
  if (orch.alive) {
    opts.push({ label: "Stop orchestrator",  action: "stop"  });
  } else {
    opts.push({ label: "Start orchestrator", action: "start" });
  }
  opts.push({ label: "Refresh status",       action: "refresh" });
  opts.push({ label: "Cancel",               action: "cancel"  });
  return opts;
}

function _statusLine(orch) {
  if (orch.alive)                  return fg(C_GREEN, `running (PID ${orch.pid})`);
  if (orch.status === "absent")    return fg(C_DIM,   "not started");
  return                                 fg(C_RED,   `stale (${orch.status})`);
}

function _runOrch(argv, { detached = false } = {}) {
  return new Promise((res) => {
    const opts = detached
      ? { stdio: "ignore", detached: true }
      : { stdio: ["ignore", "pipe", "pipe"] };
    const proc = spawn(process.execPath, [ORCH_ENTRY, ...argv], opts);
    if (detached) {
      try { proc.unref(); } catch {}
      res({ code: 0, stdout: "", stderr: "" });
      return;
    }
    let out = "", err = "";
    proc.stdout.on("data", (b) => out += b.toString());
    proc.stderr.on("data", (b) => err += b.toString());
    proc.on("close", (code) => res({ code, stdout: out, stderr: err }));
    proc.on("error", (e) => res({ code: -1, stdout: "", stderr: String(e) }));
  });
}

export function openOrchestratorModal(screen, orch, refreshFn) {
  return new Promise((resolveModal) => {
    let opts = _options(orch);

    const labelText = ` ${fg(C_HEADER_HL, " orchestrator ")}${fg(C_DIM, "·")} ${_statusLine(orch)} `;
    const box = blessed.box({
      parent: screen,
      top: "center", left: "center", width: 50, height: opts.length + 4,
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
        bg: C_BG, fg: C_TEXT,
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
      resolveModal(result);
    }

    list.key(["escape", "q"], () => close({ ok: true, message: "cancelled" }));
    list.on("select", async (_item, idx) => {
      const chosen = opts[idx];
      if (chosen.action === "cancel") { close({ ok: true, message: "cancelled" }); return; }
      if (chosen.action === "refresh") {
        if (refreshFn) refreshFn();
        close({ ok: true, message: "refreshed" });
        return;
      }
      if (chosen.action === "start") {
        await _runOrch([], { detached: true });
        if (refreshFn) refreshFn();
        close({ ok: true, message: "orchestrator started" });
        return;
      }
      if (chosen.action === "stop") {
        const r = await _runOrch(["--shutdown"]);
        if (refreshFn) refreshFn();
        close(r.code === 0
          ? { ok: true, message: "orchestrator stopped" }
          : { ok: false, message: (r.stderr || r.stdout).trim().split("\n").pop() });
        return;
      }
      close({ ok: false, message: `unknown action: ${chosen.action}` });
    });
  });
}
