// Read the orchestrator's state file + liveness for the dashboard.
import { readState, pidAlive, deleteState } from "../../../scripts/orchestrator/state-file.mjs";

export function loadOrchState() {
  const state = readState();
  if (!state) return { status: "absent", pid: null, started_at: null, last_poll: null, alive: false };

  // pid<=4 is a mock/dev convention — never a real orchestrator PID.
  const isMockPid = state.pid <= 4;
  const alive     = isMockPid
                  ? state.status === "running"
                  : (state.pid ? pidAlive(state.pid) : false);

  // Stale state file: status says "running" but PID is dead — the orchestrator
  // crashed without its SIGTERM cleanup running. Delete the file so subsequent
  // reads return "absent" and the dashboard renders "No orchestrator running"
  // instead of a confusing red "running" line. Only do this for real PIDs
  // (preserve the mock-PID dev convention).
  if (!isMockPid && state.pid && !alive && state.status === "running") {
    deleteState();
    return { status: "absent", pid: null, started_at: null, last_poll: null, alive: false };
  }

  return {
    status:     state.status     || "unknown",
    pid:        state.pid        || null,
    started_at: state.started_at || null,
    last_poll:  state.last_poll  || null,
    alive,
  };
}
