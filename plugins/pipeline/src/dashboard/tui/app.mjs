// Pipeline TUI dashboard.
//
// Layout:
//
//   ┌─ header (1 row) ──────────────────────────────────────────┐
//   │                                                            │
//   ├─ body (horizontal split) ─────────────────────────────────┤
//   │ ┌─ left (45%) ────────┐ ┌─ right (55%) ──────────────────┐│
//   │ │ agents (55% h)      │ │ pipeline (full h)              ││
//   │ ├─────────────────────┤ │                                ││
//   │ │ agent-log (45% h)   │ │                                ││
//   │ └─────────────────────┘ └────────────────────────────────┘│
//   ├─ git-log (10 rows) ───────────────────────────────────────┤
//   ├─ footer (1 row) ──────────────────────────────────────────┤
//   └────────────────────────────────────────────────────────────┘
//
// Keybindings (mutations land
// in Phase 2):
//   q, Ctrl-C        — quit
//   r                — force data refresh now
//   tab, p           — cycle to next project
//   d                — toggle show-done rows
//   ↑ / ↓ / k / j    — move row cursor
import blessed from "blessed";
import { connectUnified, close } from "../../../scripts/pipeline-db/index.mjs";
import { getPaths } from "../../paths.mjs";
import { loadProjects, loadRows } from "../shared/load-rows.mjs";
import { loadBacklog } from "../shared/load-backlog.mjs";
import { loadOrchState } from "../shared/load-orch-state.mjs";
import { loadActiveSessions } from "../shared/load-sessions.mjs";
import { loadProgressBySlug } from "../shared/load-progress.mjs";
import { loadGitLog } from "../shared/load-git-log.mjs";
import { loadAgentLog } from "../shared/load-agent-log.mjs";
import { openActionMenu } from "./action-menu.mjs";
import { openOrchestratorModal } from "./orchestrator-modal.mjs";
import {
  C_BG, C_BORDER_ACT, C_BORDER_IDLE, C_TEXT, C_DIM,
  C_GREEN, C_YELLOW, C_RED, C_CYAN, C_HASH, C_KEY_BG, C_HEADER_HL, C_SELECTED,
  STAGE_STYLE, STAGE_ORDER, STAGE_COLOR,
  fg, bg, bold,
} from "./style.mjs";
import {
  spin, queueSpin, claudeSpin,
  shimmerRunning, shimmerStage, marquee,
} from "./anim.mjs";

const ANIM_TICK_MS = 100; // 10 Hz animation re-render

// Stage transition tracking (ripple → shimmerStage fade)
const _prevStages  = new Map();
const _transitions = new Map();

function _trackTransitions(rows) {
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.feature);
    const prev = _prevStages.get(r.feature);
    if (prev !== r.stage) {
      _transitions.set(r.feature, Date.now() / 1000);
      _prevStages.set(r.feature, r.stage);
    }
  }
  for (const k of _prevStages.keys()) if (!seen.has(k)) {
    _prevStages.delete(k); _transitions.delete(k);
  }
}
function _stageElapsed(feature) {
  const t = _transitions.get(feature);
  return t ? (Date.now() / 1000 - t) : 999;
}

function _fmtAge(iso) {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (isNaN(diff)) return "—";
  const s = Math.round(diff / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s/60)}m`;
  if (s < 86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
}

// Visible length (strips blessed markup).
function _visLen(s) { return String(s ?? "").replace(/\{[^}]*\}/g, "").length; }

// blessed's setLabel only supports side:"left" or "right". For centering we
// set the label text then manually adjust the internal _label box's rleft
// to the calculated center offset on each render.
function _centerLabel(box, labelText) {
  box.setLabel(labelText);
  if (!box._label) return;
  const visible = _visLen(labelText);
  const innerW  = (box.width || 0) - (box.border ? 2 : 0);
  const left    = Math.max(1, Math.floor((innerW - visible) / 2));
  box._label.rleft = left;
  if (box._label.position) box._label.position.right = undefined;
}
function _padRight(s, n) {
  const v = _visLen(s);
  return v >= n ? s : s + " ".repeat(n - v);
}
function _truncate(s, n) {
  const v = _visLen(s);
  if (v <= n) return s;
  // Naive truncation (no markup-aware) — fine for plain text.
  return s.slice(0, n - 1) + "…";
}

// ── header / footer ─────────────────────────────────────────────────────────

function _renderHeader(project, allProjects) {
  const ts = new Date().toLocaleTimeString();
  // Header format: `<repo> · autonomous pipeline · <time>`
  // All separators + "autonomous pipeline" + clock are dim; only the repo
  // tag draws attention in terracotta.
  const projTag = allProjects.length > 1
    ? `${fg(C_HEADER_HL, bold(project.name))} ${fg(C_DIM, `[${allProjects.indexOf(project)+1}/${allProjects.length}]`)}`
    : fg(C_HEADER_HL, bold(project.name));
  return ` ${projTag} ${fg(C_DIM, "·")} ${fg(C_DIM, "autonomous pipeline")} ${fg(C_DIM, "·")} ${fg(C_DIM, ts)}`;
}

function _renderFooter() {
  const k = (key, label) => `${bg(C_KEY_BG, fg("#ffffff", ` ${key} `))} ${fg(C_DIM, label)}`;
  return ` ${k("q", "Quit")} ${k("r", "Refresh")} ${k("Tab", "Next Project")} ${k("d", "Done")} ${k("↑↓", "Cursor")} ${k("Enter", "Actions")}`;
}

// ── agents panel (left top) ─────────────────────────────────────────────────

// 8-cell ─━ progress bar — completed steps as ━ in C_GREEN, remaining as ─ in C_DIM.
function _bar(step, total, width = 8) {
  const n = Math.floor(width * step / Math.max(total, 1));
  return fg(C_GREEN, "━".repeat(n)) + fg(C_DIM, "─".repeat(width - n));
}

// Approximate liveness — process.kill(pid, 0) throws if dead.
function _pidAlive(pid) {
  if (!pid || pid <= 4) return true; // 0/<=4 → mock or non-real PID
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Per-session state → icon + name color + time color used by the agents panel row.
// Order matters: dead > stale > inprog > finished > idle.
function _sessionGlyph(session, prog, stageColor) {
  const spawnMs = Date.parse(session.spawn_time) || Date.now();
  const ageSecs = (Date.now() - spawnMs) / 1000;
  const dead     = session.pid > 0 && !_pidAlive(session.pid);
  const inprog   = prog.inprog > 0;
  const finished = !prog.todo && !prog.inprog && prog.done > 0;
  // Stalled = still in_progress AND spawned over 30 min ago. Solid filled
  // dot ● in yellow distinguishes from idle middle-dot · dim.
  const stalled  = inprog && ageSecs > 30 * 60;
  if (dead)     return { spinChar: "✗",    spinColor: C_RED,    nameColor: C_RED,    timeColor: C_RED };
  if (stalled)  return { spinChar: "●",    spinColor: C_YELLOW, nameColor: C_YELLOW, timeColor: C_YELLOW };
  if (inprog)   return { spinChar: spin(), spinColor: stageColor, nameColor: C_TEXT, timeColor: stageColor };
  // Alive but no task currently in_progress (between tasks)
  if (session.is_active === 1) {
    return { spinChar: spin(), spinColor: C_DIM, nameColor: C_TEXT, timeColor: C_DIM };
  }
  if (finished) return { spinChar: "✓",    spinColor: C_DIM,    nameColor: C_DIM,    timeColor: C_DIM };
  return         { spinChar: "·",          spinColor: C_DIM,    nameColor: C_TEXT,   timeColor: C_DIM };
}

// Orch view: single row spread across the panel width —
//   orch: on (<lastpoll>)    ·    pid <pid>    ·    uptime <uptime>
// Spread across the panel width with even gaps between the 3 segments.
function _renderOrchView(orch, panelW) {
  if (!orch.alive && orch.status === "absent") return ` ${fg(C_DIM, "›")} ${fg(C_DIM, "No orchestrator running")}`;
  const status = orch.alive ? "on" : (orch.status || "stale");
  const statusColor = orch.alive ? C_GREEN : C_RED;
  const polled = _fmtAge(orch.last_poll);
  const uptime = _fmtAge(orch.started_at);
  const pid    = orch.pid ?? "—";

  // Three segments with markup; visible widths used for spacing.
  const seg1 = `${fg(statusColor, `orch: ${status}`)} ${fg(C_DIM, `(${polled})`)}`;
  const seg2 = `${fg(C_TEXT, `pid ${pid}`)}`;
  const seg3 = `${fg(C_TEXT, `uptime ${uptime}`)}`;
  const lens = [
    `orch: ${status} (${polled})`.length,
    `pid ${pid}`.length,
    `uptime ${uptime}`.length,
  ];
  const totalContent = lens[0] + lens[1] + lens[2];
  const sep = "  ·  ";
  // Lead chevron + space (3 cells), then segments + slack.
  const lead = ` ${fg(C_TEXT, "›")} `;
  const sepCells = sep.length * 2;
  const slack = Math.max(panelW - 3 - totalContent - sepCells, 0);
  const padBetween = Math.floor(slack / 2);
  const pad = " ".repeat(padBetween);
  return `${lead}${seg1}${pad}${fg(C_DIM, sep)}${seg2}${pad}${fg(C_DIM, sep)}${seg3}`;
}

function _renderAgentsPanel(sessions, orch, progressBySlug, panelW, view) {
  if (view === "orch") return _renderOrchView(orch, panelW);
  const active = sessions.filter(s => s.is_active === 1);
  if (active.length === 0) return fg(C_DIM, "  no sessions");
  // Column widths — name flexes to fill panelW.
  //   "  <sp> <name flex>  <bar 8>  <count 6 right>  <time 6 right>"
  const W_BAR   = 8;
  const W_COUNT = 6;
  const W_TIME  = 6;
  // Leading space is just one cell so the icon sits flush against the
  // panel's left padding (single-cell inset).
  const SEPS    = 1 /* leading " " */ + 1 /* sp+name sep */ + 2 + 2 + 2 + 1 /* trailing margin */;
  const W_NAME  = Math.max(panelW - 1 /* sp */ - W_BAR - W_COUNT - W_TIME - SEPS, 12);
  const lines = [];
  for (const s of active) {
    const stype  = s.session_type || "dev";
    const stageColor = STAGE_COLOR[stype] || C_GREEN;
    const slug   = s.correlation_id || "";
    const prog   = progressBySlug[slug] || { step: 0, total: 0, done: 0, inprog: 0, todo: 0 };
    const g      = _sessionGlyph(s, prog, stageColor);
    const elapsed = _fmtAge(s.spawn_time);
    const sp      = fg(g.spinColor, g.spinChar);
    const name    = _padRight(_truncate(s.feature, W_NAME), W_NAME);
    const bar     = _bar(prog.step, prog.total, W_BAR);
    const count   = `${prog.step}/${prog.total}`.padStart(W_COUNT);
    const time    = elapsed.padStart(W_TIME);
    lines.push(` ${sp} ${fg(g.nameColor, name)}  ${bar}  ${fg(C_DIM, count)}  ${fg(g.timeColor, time)}`);
  }
  return lines.join("\n");
}

function _agentsPanelLabel(sessions, orch, view) {
  const active = sessions.filter(s => s.is_active === 1).length;
  const head = fg(C_HEADER_HL, view === "orch" ? " orchestrator " : " agents ");
  const run  = active && view !== "orch" ? " " + shimmerRunning(`${active} running ${claudeSpin()} `, C_GREEN) : "";
  let orchTag = "";
  if (orch.alive) {
    const since = _fmtAge(orch.last_poll);
    orchTag = ` ${fg(C_DIM, "·")} ${fg(C_GREEN, "orch: on")} ${fg(C_DIM, `(${since})`)}`;
  } else if (orch.status === "absent") {
    orchTag = ` ${fg(C_DIM, "·")} ${fg(C_DIM, "orch: off")}`;
  } else {
    orchTag = ` ${fg(C_DIM, "·")} ${fg(C_RED, `orch: ${orch.status}`)}`;
  }
  return head + run + orchTag;
}

// ── agent-log panel (left bottom) ───────────────────────────────────────────

// Render array of {kind: 'tool'|'msg', name?, label?, text?} entries — matches
// Activity panel color scheme — tool entries get a cyan ▶, message entries
// get a dim ». Accepts the structured {kind, name, label, text} shape so
// the renderer doesn't have to know the JSONL parse details.
function _renderAgentLogPanel(entries, panelW) {
  if (!Array.isArray(entries) || entries.length === 0) return fg(C_DIM, " no activity");
  // Reserve 4 cells for " X " (sigil + 2 spaces around it). Truncate the
  // rest so long tool labels/text don't wrap onto a second line.
  const textW = Math.max(panelW - 4, 10);
  return entries.map(e => {
    if (e.kind === "tool") {
      const body = `${e.name}: ${e.label || ""}`;
      return ` ${fg(C_CYAN, "▶")} ${fg(C_DIM, _truncate(body, textW))}`;
    }
    return ` ${fg(C_DIM, "»")} ${fg(C_TEXT, _truncate(e.text || "", textW))}`;
  }).join("\n");
}

// ── pipeline panel (right) ──────────────────────────────────────────────────

function _stageCell(row) {
  // queued rows substitute the queued-type
  // label; manual rows render as "Blocked" (red, bold) — both `blocked:`-
  // prefixed notes and `[parked-review-budget-exhausted]` map to the same
  // user-facing label since "the work needs human triage" is the only
  // distinction the dashboard owes the operator.
  const stage = row.stage;
  const elapsed = _stageElapsed(row.feature);

  let label = STAGE_STYLE[stage]?.label || stage;
  let color = STAGE_COLOR[stage] || C_TEXT;
  const qaFail  = row.qa_pass === 0;
  const blocked = stage === "manual" && (row.notes_extra || "").startsWith("blocked:");
  if (qaFail || blocked) color = C_RED;

  if (stage === "queued") {
    const m = /\btype=(\w+)\b/.exec(row.notes_extra || "");
    if (m) {
      const stype = m[1];
      label = STAGE_STYLE[stype]?.label || stype;
      color = STAGE_COLOR[stype] || C_DIM;
    }
  }

  const parked = stage === "manual" && /\[parked-review-budget-exhausted/.test(row.notes_extra || "");
  if (parked) {
    label = "blocked";
    color = C_RED;
    return fg(color, bold(label));
  }

  if (elapsed < 60) return shimmerStage(label, color, elapsed);
  return fg(color, STAGE_STYLE[stage]?.bold ? bold(label) : label);
}

function _iconCell(row, runningTypeByFeature) {
  // Blocked icon takes precedence over the spinner: a row parked at manual
  // shouldn't appear to be running just because a stale session record
  // still flags is_active=1 in the DB. The blocked state is the user-facing
  // truth — needs human triage, not "in progress".
  const notes = row.notes_extra || "";
  const blocked = row.stage === "manual"
                && (notes.startsWith("blocked:") || /\[parked-review-budget-exhausted/.test(notes));
  if (blocked)             return fg(C_RED, "⊘");
  if (runningTypeByFeature.has(row.feature)) {
    const stype = runningTypeByFeature.get(row.feature);
    return fg(STAGE_COLOR[stype] || C_GREEN, spin());
  }
  if (row.qa_pass === 0)   return fg(C_RED, "✗");
  if (row.stage === "queued") {
    const m = /\btype=(\w+)\b/.exec(row.notes_extra || "");
    const color = m ? (STAGE_COLOR[m[1]] || C_DIM) : C_DIM;
    return fg(color, queueSpin());
  }
  return " ";
}

function _notesValue(row) {
  const raw = (row.notes_extra || "").trim();
  if (!raw) return "";
  if (raw.startsWith("type=")) return ""; // queued metadata
  return raw;
}

// Returns an array of row strings — blessed.list paints its own selected bg
// across the full row width, so we don't wrap rows here.
function _renderPipelineRows(rows, sessions, panelW) {
  const fixed = 1 /* icon */ + 12 /* stage */ + 6 /* separators */;
  const fluid = Math.max(panelW - fixed, 30);
  const wFeature = Math.floor(fluid * 2/5);
  const wNotes   = fluid - wFeature;

  const _slugRe = /^(dev|test|research|review)-\d{4}-\d{2}-\d{2}-(.+)$/;
  const runningTypeByFeature = new Map();
  for (const s of sessions) {
    if (s.is_active !== 1 || !s.feature) continue;
    const m = _slugRe.exec(s.session_file || "");
    runningTypeByFeature.set(s.feature, m ? m[1] : (s.session_type || "dev"));
  }

  if (rows.length === 0) return [fg(C_DIM, "  nothing active")];
  return rows.map((r) => {
    const stage   = STAGE_COLOR[r.stage] || C_TEXT;
    const blocked = r.stage === "manual" && (r.notes_extra || "").startsWith("blocked:");
    const featureColor = (r.qa_pass === 0 || blocked) ? C_RED : stage;
    const notesColor   = blocked ? C_RED : C_DIM;
    const feature = _padRight(fg(featureColor, _truncate(r.feature, wFeature)), wFeature);
    const icon    = _iconCell(r, runningTypeByFeature);
    const stageC  = _padRight(_stageCell(r), 12);
    const notes   = _padRight(fg(notesColor, marquee(_notesValue(r), wNotes - 2)), wNotes);
    return ` ${feature}  ${icon}  ${stageC}  ${notes}`;
  });
}

function _pipelinePanelLabel(allRows, visibleRows, showAll) {
  const activeN = visibleRows.filter(r => r.stage !== "done" && r.stage !== "queued").length;
  const queuedN = allRows.filter(r => r.stage === "queued").length;
  const doneN   = allRows.filter(r => r.stage === "done").length;
  let s = fg(C_HEADER_HL, " pipeline ") + fg(C_TEXT, `${activeN} active`);
  if (!showAll && queuedN) s += "  " + fg(C_DIM, `+${queuedN} queued`);
  if (!showAll && doneN)   s += "  " + fg(C_DIM, `+${doneN} done`);
  return s + " ";
}

// ── git-log panel (bottom strip) ────────────────────────────────────────────

// Render array of {hash, msg, when} commits:
// hash w8 in C_HASH gold | msg flex in C_TEXT | when w10 in C_DIM
// right-justified to the panel's right edge.
function _renderGitLogPanel(commits, panelW) {
  if (!Array.isArray(commits) || commits.length === 0) return fg(C_DIM, "  no commits");
  const W_HASH = 8;
  // "18 minutes ago" is 14 chars; budget 15 so the column doesn't wrap. Also
  // truncate as a safety net if git --date=human ever exceeds the budget.
  const W_WHEN = 15;
  const SEPS   = 4; // "  hash  msg  when"
  const msgW   = Math.max(panelW - W_HASH - W_WHEN - SEPS - 2, 20);
  return commits.map(c => {
    const h = _padRight(c.hash || "", W_HASH);
    const m = _padRight(_truncate(c.msg || "", msgW), msgW);
    const w = _truncate(String(c.when || ""), W_WHEN).padStart(W_WHEN);
    return `  ${fg(C_HASH, h)}  ${fg(C_TEXT, m)}  ${fg(C_DIM, w)}`;
  }).join("\n");
}

function _sortRows(rows) {
  return rows.slice().sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a.stage);
    const bi = STAGE_ORDER.indexOf(b.stage);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

// ── main ────────────────────────────────────────────────────────────────────

export function runTui({ paths, refreshMs = 10000 } = {}) {
  const _paths = paths ?? getPaths();
  const db = connectUnified(_paths);

  const projects = loadProjects(db);
  if (projects.length === 0) {
    close(db);
    process.stderr.write("dashboard: no projects registered — run `pipeline project-add <name> <path>` first.\n");
    setTimeout(() => process.exit(1), 150);
    return;
  }

  let selectedProjectIdx = 0;
  let showAll = false;
  let cursorIdx = 0;
  let agentsView = "agents"; // "agents" | "orch" — toggled by `o`

  let cachedRowsAll = [];
  let cachedSessions = [];
  let cachedOrch = { status: "absent", pid: null, started_at: null, last_poll: null, alive: false };
  let cachedProgress = {};
  let cachedGitLog = [];
  let cachedAgentLog = [];

  const screen = blessed.screen({
    smartCSR: true,
    title: "pipeline",
    fullUnicode: true,
    forceUnicode: true,
    cursor: { hidden: true },
  });
  // Force 24-bit truecolor — blessed defaults to 256-color which collapses
  // the Tokyo Night muted palette into greys (#1e2030 → idx 234 → near-black).
  // Windows Terminal, modern xterms, and most VS Code integrated terminals
  // support truecolor; we set the cap then re-check tput.
  try {
    if (screen.program?.tput) {
      screen.program.tput.colors = 16777216;
      if (screen.program.tput.features) screen.program.tput.features.colors = 16777216;
    }
  } catch {}
  // belt-and-braces: some terminals need the explicit escape too
  try { screen.program.hideCursor(); } catch {}

  // Background-fill base layer — blessed only paints bg on cells it writes
  // to, so without this the empty interior of each panel + the gaps between
  // panels render as terminal-default (typically black). This base box
  // sits behind every other element and fills the visible area so empty
  // cells inherit the Tokyo Night surface color.
  // Use top-level `bg` (not just style.bg) AND `ch` so blessed paints
  // every cell of this base layer with the bg color + space char. Empty
  // style.bg alone won't paint empty cells.
  blessed.box({
    parent: screen,
    top: 0, left: 0, width: "100%", height: "100%",
    bg: C_BG, ch: " ",
    style: { bg: C_BG },
    tags: false,
  });

  // Header (top 1)
  const header = blessed.box({
    parent: screen, top: 0, left: 0, height: 1, width: "100%",
    tags: true, align: "center", style: { bg: C_BG, fg: C_TEXT },
  });

  // Footer (bottom 1)
  const footer = blessed.box({
    parent: screen, bottom: 0, left: 0, height: 1, width: "100%",
    tags: true, style: { bg: C_BG, fg: C_TEXT },
  });

  // git-log strip (10 tall, above footer)
  const gitLogBox = blessed.box({
    parent: screen, bottom: 1, left: 0, width: "100%", height: 10,
    border: { type: "line" },
    tags: true,
    style: { border: { fg: C_BORDER_IDLE, bg: C_BG }, label: { bg: C_BG, fg: C_HEADER_HL }, bg: C_BG, fg: C_TEXT },
  });

  // Body container — fills space between header (top 1) and gitLog/footer (bottom 11)
  const bodyTop = 1;
  const bodyBottom = 11; // 10 git-log + 1 footer
  // Left (45%)
  const agentsBox = blessed.box({
    parent: screen, top: bodyTop, left: 0, width: "45%",
    height: `45%-${Math.floor(bodyBottom/2)}`,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: C_BORDER_ACT, bg: C_BG }, label: { bg: C_BG, fg: C_HEADER_HL }, bg: C_BG, fg: C_TEXT },
  });
  const agentLogBox = blessed.box({
    parent: screen,
    top: `45%-${Math.floor(bodyBottom/2) - 1}`,
    left: 0, width: "45%",
    bottom: bodyBottom,
    tags: true,
    border: { type: "line" },
    style: { border: { fg: C_BORDER_IDLE, bg: C_BG }, label: { bg: C_BG, fg: C_HEADER_HL }, bg: C_BG, fg: C_TEXT },
  });
  // Right (55%) — blessed.list paints its own selection bg across the full
  // row width regardless of inline fg markup. Avoids the {/} bg-bleed bug
  // when wrapping a row that contains internal fg() closers.
  const pipelineBox = blessed.list({
    parent: screen, top: bodyTop, left: "45%",
    width: "55%", bottom: bodyBottom,
    tags: true, keys: false, vi: false, mouse: false,
    interactive: true,
    // blessed.list strips inline {color-fg} tags on the selected row when
    // invertSelected !== false (its default). That's what keeps painting
    // the selected row in plain default fg — we want the per-column
    // colors preserved.
    invertSelected: false,
    border: { type: "line" },
    style: {
      border:   { fg: C_BORDER_IDLE, bg: C_BG },
      label:    { bg: C_BG, fg: C_HEADER_HL },
      bg:       C_BG,
      fg:       C_TEXT,
      selected: { bg: C_SELECTED },
      item:     { bg: C_BG, fg: C_TEXT },
    },
  });

  let dataIntervalHandle = null;
  let animIntervalHandle = null;

  function fetchData() {
    const project = projects[selectedProjectIdx];
    const dbRows = loadRows(db, project.name, { showAll: true });
    const backlogRows = loadBacklog(db, project.name);
    cachedRowsAll  = _sortRows([...dbRows, ...backlogRows]);
    cachedSessions = loadActiveSessions(db, project.name);
    cachedOrch     = loadOrchState();
    const slugs    = cachedSessions
      .filter(s => s.is_active === 1 && s.correlation_id)
      .map(s => s.correlation_id);
    cachedProgress = loadProgressBySlug(db, slugs);
    cachedGitLog   = loadGitLog(project.root_path, { limit: 8 });
    cachedAgentLog = loadAgentLog(cachedSessions, project.root_path, { limit: 20 });
    _trackTransitions(cachedRowsAll);
  }

  function renderFrame() {
    const project = projects[selectedProjectIdx];
    const visibleRows = showAll ? cachedRowsAll : cachedRowsAll.filter(r => r.stage !== "done");
    if (cursorIdx >= visibleRows.length) cursorIdx = Math.max(visibleRows.length - 1, 0);

    header.setContent(_renderHeader(project, projects));
    footer.setContent(_renderFooter());

    _centerLabel(agentsBox,    ` ${_agentsPanelLabel(cachedSessions, cachedOrch, agentsView)} `);
    agentsBox.setContent(_renderAgentsPanel(cachedSessions, cachedOrch, cachedProgress, agentsBox.width - 4, agentsView));

    _centerLabel(agentLogBox,  ` ${fg(C_HEADER_HL, " activity ")} `);
    agentLogBox.setContent(_renderAgentLogPanel(cachedAgentLog, agentLogBox.width - 4));

    _centerLabel(pipelineBox,  ` ${_pipelinePanelLabel(cachedRowsAll, visibleRows, showAll)} `);
    pipelineBox.setItems(_renderPipelineRows(visibleRows, cachedSessions, pipelineBox.width - 4));
    if (cursorIdx >= visibleRows.length) cursorIdx = Math.max(0, visibleRows.length - 1);
    pipelineBox.select(cursorIdx);

    _centerLabel(gitLogBox,    ` ${fg(C_HEADER_HL, " log ")} `);
    gitLogBox.setContent(_renderGitLogPanel(cachedGitLog, gitLogBox.width - 4));

    screen.render();
  }

  function refresh() { fetchData(); renderFrame(); }

  function teardownAndExit(code = 0) {
    if (dataIntervalHandle) clearInterval(dataIntervalHandle);
    if (animIntervalHandle) clearInterval(animIntervalHandle);
    try { close(db); } catch {}
    try { screen.program.showCursor(); } catch {}
    try { screen.destroy(); } catch {}
    setTimeout(() => process.exit(code), 50);
  }

  screen.key(["q", "C-c"],   () => { if (menuOpen) return; teardownAndExit(0); });
  screen.key("r",            () => { if (menuOpen) return; refresh(); });
  screen.key("d",            () => { if (menuOpen) return; showAll = !showAll; renderFrame(); });
  screen.key(["tab", "p"],   () => {
    if (menuOpen) return;
    selectedProjectIdx = (selectedProjectIdx + 1) % projects.length;
    cursorIdx = 0;
    refresh();
  });
  // Menu-open guard — pipeline nav + Enter all check this so they don't
  // fire while the floating action menu owns input.
  let menuOpen = false;
  screen.key(["up", "k"],    () => { if (menuOpen) return; cursorIdx = Math.max(0, cursorIdx - 1); renderFrame(); });
  screen.key(["down", "j"],  () => {
    if (menuOpen) return;
    const visibleN = (showAll ? cachedRowsAll : cachedRowsAll.filter(r => r.stage !== "done")).length;
    cursorIdx = Math.min(visibleN - 1, cursorIdx + 1);
    renderFrame();
  });
  screen.key(["enter"], async () => {
    if (menuOpen) return;
    menuOpen = true;
    try {
      if (agentsView === "orch") {
        await openOrchestratorModal(screen, cachedOrch, () => refresh());
      } else {
        const project = projects[selectedProjectIdx];
        const visibleRows = showAll ? cachedRowsAll : cachedRowsAll.filter(r => r.stage !== "done");
        const row = visibleRows[cursorIdx];
        if (!row) { menuOpen = false; return; }
        await openActionMenu(screen, project.name, row, () => refresh());
      }
    } finally {
      menuOpen = false;
      pipelineBox.focus();
      refresh();
    }
  });
  // `o` toggles the agents panel between agent-list view and orchestrator
  // summary view. To open the orchestrator start/stop modal, press Enter
  // while in orch view.
  screen.key(["o"], () => {
    if (menuOpen) return;
    agentsView = agentsView === "agents" ? "orch" : "agents";
    renderFrame();
  });

  // blessed re-enables the cursor after some operations. Raw DECTCEM hide
  // (\x1b[?25l) is more persistent than program.hideCursor() during
  // rapid shimmer re-renders.
  const _hideCursor = () => {
    try { process.stdout.write("\x1b[?25l"); } catch {}
  };
  screen.on("render", _hideCursor);

  refresh();
  dataIntervalHandle = setInterval(refresh, refreshMs);
  animIntervalHandle = setInterval(renderFrame, ANIM_TICK_MS);
}
