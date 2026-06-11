// Orchestrator-state view model shared by the agents-panel orch view in
// both dashboards.
import { PALETTE } from "./glyph.mjs";
import { fmtAge } from "./util.mjs";

export function orchViewModel(orch, now = Date.now()) {
  const o = orch || {};
  const off = !o.alive && o.status === "absent";
  return {
    off,
    alive: !!o.alive,
    status: o.alive ? "on" : (o.status || "stale"),
    statusColor: o.alive ? PALETTE.green : PALETTE.red,
    pid: off ? "—" : (o.pid ?? "—"),
    polled: off ? "—" : fmtAge(o.last_poll, now),
    uptime: off ? "—" : fmtAge(o.started_at, now),
  };
}
