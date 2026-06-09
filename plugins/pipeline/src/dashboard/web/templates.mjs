// HTML template for the web dashboard. Goal: visually mirror the TUI as
// closely as a browser allows — monospace, Tokyo Night palette, rounded
// panel borders with centered inset labels, char-based icons + spinners,
// same column layouts as the TUI panels.

const STAGE_COLOR = {
  merge:    "#95b170",
  manual:   "#e0af68",
  test:     "#7dcfff",
  dev:      "#afb9d8",
  research: "#c099ff",
  review:   "#95b170",
  queued:   "#4a5a78",
  backlog:  "#4a5a78",
  done:     "#4a5a78",
};

const C_BG          = "#1e2030";
const C_BORDER_ACT  = "#7aa2f7";
const C_BORDER_IDLE = "#38597b";
const C_HEADER_HL   = "#8e5b4e";
const C_TEXT        = "#afb9d8";
const C_DIM         = "#4a5a78";
const C_GREEN       = "#95b170";
const C_YELLOW      = "#e0af68";
const C_RED         = "#c25c66";
const C_CYAN        = "#7dcfff";
const C_HASH        = "#e0af68";
const C_SELECTED    = "#2a3b5c";

export function renderIndex({ projects, active }) {
  const projOptions = projects.map(p =>
    `<option value="${p.name}"${p.name === active ? " selected" : ""}>${p.name}</option>`
  ).join("");

  const stageColorJson = JSON.stringify(STAGE_COLOR);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="dark">
  <title>pipeline</title>
  <style>
    /* First-paint hint — prevents the light flash before the main
       stylesheet applies in browsers that prefer light by default
       or apply a forced-dark-mode override. */
    :root { color-scheme: dark; }
    html { background: ${C_BG}; color: ${C_TEXT}; }
    :root {
      --bg: ${C_BG}; --text: ${C_TEXT}; --dim: ${C_DIM};
      --border-act: ${C_BORDER_ACT}; --border-idle: ${C_BORDER_IDLE};
      --header-hl: ${C_HEADER_HL}; --selected: ${C_SELECTED};
      --green: ${C_GREEN}; --yellow: ${C_YELLOW}; --red: ${C_RED};
      --cyan: ${C_CYAN}; --hash: ${C_HASH};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--bg); color: var(--text); height: 100vh; overflow: hidden;
      font-family: "Cascadia Mono", "Cascadia Code", Menlo, Consolas, ui-monospace, monospace;
      font-size: 13px; line-height: 1.45; font-variant-numeric: tabular-nums;
    }

    /* Header bar — repo · autonomous pipeline · time · project picker */
    .topbar { display: flex; align-items: center; gap: 12px; padding: 4px 12px;
      background: var(--bg); }
    .topbar .repo { color: var(--header-hl); font-weight: bold; }
    .topbar .dim { color: var(--dim); }
    .topbar select { background: var(--bg); color: var(--text);
      border: 1px solid var(--border-idle); border-radius: 4px;
      padding: 1px 6px; font: inherit; }
    .topbar .clock { margin-left: auto; color: var(--dim); }
    .topbar .keys { display: flex; gap: 8px; color: var(--dim); font-size: 11px; }
    .topbar .keys b { color: var(--text); background: var(--border-idle);
      padding: 1px 5px; border-radius: 3px; }

    /* Panels — rounded border, centered inset label, palette bg */
    .grid { display: grid; grid-template-columns: 45fr 55fr;
      grid-template-rows: minmax(0,3fr) minmax(0,2fr) 12em;
      gap: 6px; padding: 4px 12px; height: calc(100vh - 64px); }
    .panel { position: relative;
      border: 1px solid var(--border-idle); border-radius: 8px;
      background: var(--bg);
      padding: 14px 10px 8px;
      /* No overflow:hidden — would clip the centered inset label that
         sits at top:-8px riding the border. .panel-inner handles
         scroll of overflowing content. */
    }
    .panel.active { border-color: var(--border-act); }
    .panel-label { position: absolute; top: -7px;
      background: var(--bg); padding: 0 8px; color: var(--header-hl);
      height: 14px; line-height: 14px;
      left: 50%; transform: translateX(-50%);
      white-space: nowrap; font-size: 12px;
    }
    .agents-panel    { grid-column: 1; grid-row: 1; }
    .activity-panel  { grid-column: 1; grid-row: 2; }
    .pipeline-panel  { grid-column: 2; grid-row: 1 / span 2; }
    .gitlog-panel    { grid-column: 1 / span 2; grid-row: 3; }
    .row.activity { grid-template-columns: 2ch minmax(0,1fr); }
    .panel-inner { height: 100%; overflow-y: auto; }

    /* Tabular rows in panels — monospace columns mimic the TUI */
    .row { display: grid; align-items: center; gap: 8px; padding: 1px 6px; }
    .row.agents { grid-template-columns: 2ch minmax(0,1fr) 8ch 6ch 6ch; }
    .row.pipeline { grid-template-columns: minmax(0,1fr) 2ch 14ch minmax(0,1.4fr); }
    .row.gitlog   { grid-template-columns: 8ch 1fr 12ch; }
    .row.selected { background: var(--selected); border-radius: 3px; }
    .row.pipeline { cursor: pointer; border-radius: 3px; transition: background-color 80ms; }
    .row.pipeline:hover { background: var(--selected); }
    .row.agents.clickable { cursor: pointer; border-radius: 3px; transition: background-color 80ms; }
    .row.agents.clickable:hover { background: var(--selected); }
    .cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cell.right { text-align: right; }
    .cell.center { text-align: center; }
    .dim { color: var(--dim); }
    .glyph.spin { animation: spin-tick 1.2s steps(10) infinite; }
    @keyframes spin-tick { /* purely decorative; real spinner re-rendered by JS */ }

    .bar { font-family: inherit; letter-spacing: 0; }
    .bar .done { color: var(--green); }
    .bar .rest { color: var(--dim); }
    .hash { color: var(--hash); }
    .stage-pill { font-weight: bold; }
    .stage-pill.italic { font-style: italic; }

    /* Stage shimmer — per-char brightness/saturation wave with staggered
       animation-delay so the bright spot ripples across the label.
       Triggered for ~60s after a stage transition (JS adds/removes class). */
    .shimmer { white-space: pre; }   /* preserve space chars inside span list */

    /* Smooth horizontal marquee for the pipeline notes cell. */
    .marquee-notes { overflow: hidden; }
    .marquee-inner { display: inline-block; white-space: nowrap; will-change: transform;
                     animation: marquee var(--marquee-dur, 30s) linear infinite; }
    @keyframes marquee {
      from { transform: translateX(0); }
      to   { transform: translateX(calc(-1 * var(--marquee-shift, 50%))); }
    }
    .shimmer span { display: inline-block; animation: char-shimmer 1.2s ease-in-out infinite; }
    /* Flower glyph cycles through chars of varying width — pin it to a
       fixed-width slot so the rest of the header doesn't shift around. */
    .claude-spin { display: inline-block; width: 1.5ch; text-align: center; }
    @keyframes char-shimmer {
      0%, 100% { filter: brightness(1)    saturate(1);   }
      50%      { filter: brightness(1.55) saturate(1.4); }
    }
    .shimmer span:nth-child(1) { animation-delay:   0ms; }
    .shimmer span:nth-child(2) { animation-delay: 100ms; }
    .shimmer span:nth-child(3) { animation-delay: 200ms; }
    .shimmer span:nth-child(4) { animation-delay: 300ms; }
    .shimmer span:nth-child(5) { animation-delay: 400ms; }
    .shimmer span:nth-child(6) { animation-delay: 500ms; }
    .shimmer span:nth-child(7) { animation-delay: 600ms; }
    .shimmer span:nth-child(8) { animation-delay: 700ms; }
    .shimmer span:nth-child(9) { animation-delay: 800ms; }
    .shimmer span:nth-child(10){ animation-delay: 900ms; }
    .shimmer span:nth-child(11){ animation-delay:1000ms; }
    .shimmer span:nth-child(12){ animation-delay:1100ms; }
    .shimmer span:nth-child(13){ animation-delay:1200ms; }
    .shimmer span:nth-child(14){ animation-delay:1300ms; }
    .shimmer span:nth-child(15){ animation-delay:1400ms; }

    /* Status footer */
    .footer { position: fixed; bottom: 0; left: 0; right: 0;
      background: var(--bg); border-top: 1px solid var(--border-idle);
      padding: 3px 12px; display: flex; gap: 8px; color: var(--dim); font-size: 11px;
      align-items: center; }
    .footer .toast { margin-left: auto; color: var(--green); }

    /* Modal — centered, same palette */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(30,32,48,0.72);
      display: none; align-items: center; justify-content: center; z-index: 10; }
    .modal-backdrop.show { display: flex; }
    .modal { background: var(--bg); border: 1px solid var(--border-act);
      border-radius: 8px; min-width: 380px; padding: 0; overflow: hidden; }
    .modal h3 { padding: 6px 14px; color: var(--header-hl); font-weight: normal;
      border-bottom: 1px solid var(--border-idle); font-size: 12px; }
    .modal h3 .stage { margin-left: 8px; }
    .modal ul { list-style: none; }
    .modal li { padding: 6px 14px; cursor: pointer; color: var(--text); }
    .modal li:hover, .modal li.active { background: var(--selected); }
    .modal li.danger { color: var(--red); }
  </style>
</head>
<body>

<header class="topbar">
  <span class="repo" id="repo">—</span>
  <span class="dim">·</span>
  <span class="dim">autonomous pipeline</span>
  <span class="dim">·</span>
  <select id="project-picker">${projOptions}</select>
  <span class="clock" id="clock">--:--:--</span>
  <span class="keys">
    <b>o</b> <span>orch</span>
    <b>d</b> <span>done</span>
    <b>r</b> <span>refresh</span>
    <b>Enter</b> <span>actions</span>
  </span>
</header>

<main class="grid">
  <section class="panel agents-panel active" id="agents-panel">
    <div class="panel-label" id="agents-label">agents</div>
    <div class="panel-inner" id="agents-inner">
      <div class="dim" style="padding: 8px;">no sessions</div>
    </div>
  </section>
  <section class="panel activity-panel">
    <div class="panel-label">activity</div>
    <div class="panel-inner" id="activity-inner">
      <div class="dim" style="padding: 8px;">no activity</div>
    </div>
  </section>
  <section class="panel pipeline-panel" id="pipeline-panel">
    <div class="panel-label" id="pipeline-label">pipeline</div>
    <div class="panel-inner" id="pipeline-inner">
      <div class="dim" style="padding: 8px;">no rows</div>
    </div>
  </section>
  <section class="panel gitlog-panel">
    <div class="panel-label">log</div>
    <div class="panel-inner" id="gitlog-inner">
      <div class="dim" style="padding: 8px;">no commits</div>
    </div>
  </section>
</main>

<footer class="footer">
  <span>pipeline web dashboard</span>
  <span class="toast" id="toast"></span>
</footer>

<div class="modal-backdrop" id="modal-backdrop">
  <div class="modal">
    <h3 id="modal-title">action</h3>
    <ul id="modal-options"></ul>
  </div>
</div>

<script>
(() => {
  const STAGE_COLOR = ${stageColorJson};
  const $ = (s) => document.querySelector(s);
  let state = null;
  let agentsView = "agents"; // "agents" | "orch"
  let selectedFeature = null;
  let showAll = false;

  const SPIN_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  const QUEUE_SPIN  = ["⠁","⠂","⠄","⠂"];
  const CLAUDE_SPIN = ["·","*","+","✧","✶","✸","✲","✻","❊","✽","❋","❆","❋","✽","❊","✻","✲","✸","✶","✧","+","*","·"];
  function claudeSpin() { return CLAUDE_SPIN[Math.floor(Date.now()/166) % CLAUDE_SPIN.length]; }
  // Stage-transition tracking for shimmer effect (fades out at 60s).
  const lastStages  = new Map(); // feature → last seen stage
  const transitions = new Map(); // feature → ms when stage changed
  function trackTransitions(rows) {
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.feature);
      const prev = lastStages.get(r.feature);
      if (prev !== undefined && prev !== r.stage) {
        transitions.set(r.feature, Date.now());
      }
      lastStages.set(r.feature, r.stage);
    }
    for (const k of [...lastStages.keys()]) {
      if (!seen.has(k)) { lastStages.delete(k); transitions.delete(k); }
    }
  }
  function isShimmering(feature) {
    const t = transitions.get(feature);
    return t && (Date.now() - t) < 60_000;
  }
  function spin()      { return SPIN_FRAMES[Math.floor(Date.now()/110) % SPIN_FRAMES.length]; }

  // Horizontal-scroll marquee for the pipeline notes cell — mirrors the
  // TUI marquee() in tui/anim.mjs. Width is the column's visible width in
  // chars; we measure it dynamically from the rendered cell so the marquee
  // fills all available space instead of being capped at a fixed length.
  const MARQUEE_FALLBACK_WIDTH = 50;
  const MARQUEE_SEP            = "   ·   ";
  const MARQUEE_SPEED          = 5;
  // Measured once at first paint — monospace font so a single value works.
  let _charPx = 0;
  function _measureCharPx() {
    if (_charPx > 0) return _charPx;
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;";
    probe.textContent = "MMMMMMMMMM";
    document.body.appendChild(probe);
    _charPx = probe.offsetWidth / 10;
    document.body.removeChild(probe);
    return _charPx;
  }
  function marqueeText(text, widthChars) {
    if (!widthChars || widthChars < 4) widthChars = MARQUEE_FALLBACK_WIDTH;
    text = String(text || "").replace(/\\n/g, " | ");
    if (text.length <= widthChars) return text;
    const padded  = text + MARQUEE_SEP;
    const offset  = Math.floor(Date.now()/1000 * MARQUEE_SPEED) % padded.length;
    const doubled = padded + padded;
    return doubled.slice(offset, offset + widthChars);
  }
  function queueSpin() { return QUEUE_SPIN[Math.floor(Date.now()/330) % QUEUE_SPIN.length]; }

  function fmtAge(iso) {
    if (!iso) return "—";
    const diff = Date.now() - Date.parse(iso);
    if (isNaN(diff)) return "—";
    const s = Math.round(diff/1000);
    if (s < 60) return s+"s";
    if (s < 3600) return Math.round(s/60)+"m";
    if (s < 86400) return Math.round(s/3600)+"h";
    return Math.round(s/86400)+"d";
  }
  function bar(step, total, w=8) {
    const n = Math.floor(w * step / Math.max(total, 1));
    return '<span class="bar">'
      + '<span class="done">' + '━'.repeat(n) + '</span>'
      + '<span class="rest">' + '─'.repeat(w-n) + '</span>'
      + '</span>';
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }
  function sessionGlyph(s, prog) {
    const ageS = (Date.now() - Date.parse(s.spawn_time))/1000;
    // Liveness: caller filters to is_active === 1 already, so any
    // session reaching this glyph is alive per the DB. The previous
    // pid-based heuristic was backwards on Windows (real PIDs are
    // always > 4) and rendered a red glyph in place of the spinner.
    const dead = s.is_active === 0;
    if (dead) return { ch: "✗", color: "var(--red)" };
    if (prog.inprog > 0 && ageS > 30*60) return { ch: "●", color: "var(--yellow)" };
    if (prog.inprog > 0) {
      const c = STAGE_COLOR[s.session_type] || "var(--green)";
      return { ch: spin(), color: c };
    }
    if (prog.todo === 0 && prog.done > 0) return { ch: "✓", color: "var(--dim)" };
    return { ch: "·", color: "var(--dim)" };
  }

  async function fetchState() {
    const project = $("#project-picker").value;
    if (!project) return;
    try {
      const r = await fetch("/api/state?project=" + encodeURIComponent(project));
      if (!r.ok) return;
      state = await r.json();
      render();
    } catch {}
  }

  function renderHeader() {
    $("#repo").textContent = state?.project ? state.project.name : "—";
    $("#clock").textContent = new Date().toLocaleTimeString();
  }

  function renderAgentsLabel() {
    if (!state) return;
    const sessions = (state.sessions || []).filter(s => s.is_active === 1);
    const o = state.orch || {};
    let tail = "";
    if (o.alive)                       tail = ' <span class="dim">·</span> <span style="color:var(--green)">orch: on</span> <span class="dim">(' + fmtAge(o.last_poll) + ')</span>';
    else if (o.status === "absent")    tail = ' <span class="dim">·</span> <span class="dim">orch: off</span>';
    else                               tail = ' <span class="dim">·</span> <span style="color:var(--red)">orch: ' + esc(o.status || "stale") + '</span>';
    const head = agentsView === "orch" ? "orchestrator" : "agents";
    let running = '';
    if (agentsView !== "orch" && sessions.length) {
      const runText = sessions.length + ' running';
      const shimmerHtml = '<span class="shimmer" style="color:var(--green)">'
        + Array.from(runText).map(c => '<span>' + esc(c) + '</span>').join('')
        + '</span>';
      running = ' <span class="dim">·</span> ' + shimmerHtml
        + ' <span class="claude-spin" style="color:var(--green)">' + claudeSpin() + '</span>';
    }
    $("#agents-label").innerHTML = head + running + tail;
  }

  function renderAgentsPanel() {
    if (!state) return;
    const inner = $("#agents-inner");
    if (agentsView === "orch") {
      const o = state.orch || {};
      const isOff = !o.alive && o.status === "absent";
      const status = o.alive ? "on" : (o.status || "off");
      const color  = o.alive ? "var(--green)" : "var(--red)";
      const pid    = isOff ? "—" : (o.pid ?? "—");
      const polled = isOff ? "—" : fmtAge(o.last_poll);
      const uptime = isOff ? "—" : fmtAge(o.started_at);
      inner.innerHTML = '<div class="row agents clickable" id="orch-row" style="grid-template-columns:1fr 1fr 1fr;padding:8px;">'
        + '<div><span style="color:' + color + '">orch: ' + status + '</span> <span class="dim">(' + polled + ')</span></div>'
        + '<div class="cell center">pid ' + pid + '</div>'
        + '<div class="cell right">uptime ' + uptime + '</div>'
        + '</div>';
      const row = document.getElementById("orch-row");
      row.onclick = () => openOrchModal(o);
      return;
    }
    const sessions = (state.sessions || []).filter(s => s.is_active === 1);
    if (sessions.length === 0) {
      inner.innerHTML = '<div class="dim" style="padding:8px;">no sessions</div>';
      return;
    }
    inner.innerHTML = sessions.map(s => {
      // Progress is keyed by session-file basename (no extension, no path),
      // e.g. "dev-2026-06-08-add-dark-mode-toggle". Three prior bugs here:
      //   1. used the full path → never matched the basename key
      //   2. regex /\\.md$/ matched literal "\.md" (escaped backslash + .md)
      //      which doesn't appear at the end of a path — strip was a no-op.
      //   3. this entire file is one big template literal — every backslash
      //      we want in the SERVED JS must be doubled in the SOURCE. So a
      //      regex char-class with backslash needs \\\\, and a literal-dot
      //      escape needs \\.
      const slug = (s.session_file || "").split(/[\\\\/]/).pop().replace(/\\.md$/, "");
      const prog = state.progress[slug] || { step:0,total:0,done:0,inprog:0,todo:0 };
      const g    = sessionGlyph(s, prog);
      const stageColor = STAGE_COLOR[s.session_type] || "var(--green)";
      return '<div class="row agents">'
        + '<div class="cell center" style="color:'+g.color+'">'+g.ch+'</div>'
        + '<div class="cell">'+esc(s.feature)+'</div>'
        + '<div>'+bar(prog.step, prog.total)+'</div>'
        + '<div class="cell right dim">'+prog.step+'/'+prog.total+'</div>'
        + '<div class="cell right" style="color:'+stageColor+'">'+fmtAge(s.spawn_time)+'</div>'
        + '</div>';
    }).join("");
  }

  // Skip-re-render signature: rebuilding innerHTML restarts CSS animations.
  let _pipelineSig = "";
  function renderPipelinePanel() {
    if (!state) return;
    const inner = $("#pipeline-inner");
    let rows = (state.rows || []).slice();
    if (!showAll) rows = rows.filter(r => r.stage !== "done");
    trackTransitions(rows);
    const active = rows.filter(r => r.stage !== "queued").length;
    const queued = (state.rows||[]).filter(r => r.stage === "queued").length;
    const done   = (state.rows||[]).filter(r => r.stage === "done").length;
    // Match TUI: "pipeline" in header-hl, "N active" in --text (white).
    let label = 'pipeline <span style="color:var(--text)">' + active + ' active</span>';
    if (!showAll && queued) label += ' <span class="dim">+'+queued+' queued</span>';
    if (!showAll && done)   label += ' <span class="dim">+'+done+' done</span>';
    $("#pipeline-label").innerHTML = label;

    const sig = (showAll ? "all|" : "noDone|") + selectedFeature + "|" + rows.map(r =>
      r.feature + ":" + r.stage + ":" + (r.notes_extra || "") + ":" + r.qa_pass
    ).join(";");
    if (sig === _pipelineSig) return;
    _pipelineSig = sig;
    if (rows.length === 0) {
      inner.innerHTML = '<div class="dim" style="padding:8px;">no rows</div>';
      return;
    }
    inner.innerHTML = rows.map(r => {
      const color = STAGE_COLOR[r.stage] || "var(--text)";
      const blocked = r.stage === "manual" && (r.notes_extra || "").startsWith("blocked:");
      const featColor  = (r.qa_pass === 0 || blocked) ? "var(--red)" : color;
      const notesColor = blocked ? "var(--red)" : "var(--dim)";
      let icon = "";
      if (r.qa_pass === 0)             icon = '<span style="color:var(--red)">✗</span>';
      else if (blocked)                icon = '<span style="color:var(--red)">⊘</span>';
      else if (r.stage === "queued")   icon = '<span class="dim queue-spin">'+queueSpin()+'</span>';
      else if (r.stage === "research" || r.stage === "dev" || r.stage === "review")
        icon = '<span class="pipe-spin" style="color:'+color+'">'+spin()+'</span>';
      const stageClass = r.stage === "backlog" ? "stage-pill italic" : "stage-pill";
      const sel = r.feature === selectedFeature ? " selected" : "";
      const stageHtml = isShimmering(r.feature)
        ? '<span class="shimmer">' + Array.from(r.stage).map(c => '<span>'+esc(c)+'</span>').join('') + '</span>'
        : esc(r.stage);
      return '<div class="row pipeline'+sel+'" data-feature="'+esc(r.feature)+'">'
        + '<div class="cell" style="color:'+featColor+'">'+esc(r.feature)+'</div>'
        + '<div class="cell center">'+icon+'</div>'
        + '<div class="cell '+stageClass+'" style="color:'+color+'">'+stageHtml+'</div>'
        + (() => {
            const noteFlat = String(r.notes_extra || "").replace(/\\n/g, " | ");
            const SHORT = 32;
            if (noteFlat.length <= SHORT) {
              return '<div class="cell" style="color:'+notesColor+'">'+esc(noteFlat)+'</div>';
            }
            const dur = Math.max(6, Math.round(noteFlat.length / 8));
            const unit = esc(noteFlat) + MARQUEE_SEP;
            const unitCh = noteFlat.length + MARQUEE_SEP.length;
            return '<div class="cell marquee-notes" style="color:'+notesColor+'"><span class="marquee-inner" style="--marquee-dur:'+dur+'s;--marquee-shift:'+unitCh+'ch">'
              + unit + unit + unit + unit + '</span></div>';
          })()
        + '</div>';
    }).join("");
    inner.querySelectorAll(".row.pipeline").forEach(el => {
      el.onclick = () => {
        selectedFeature = el.dataset.feature;
        renderPipelinePanel();
        const row = rows.find(r => r.feature === selectedFeature);
        if (row) openActionMenu(row);
      };
    });
  }

  // Activity panel is purely additive — we only APPEND new entries instead
  // of re-rendering the whole list each poll. After append we scroll to the
  // bottom so the newest entries are always visible (tailing). The shown
  // count is tracked separately from state so polls that return the same
  // set are no-ops.
  let activityShownCount = 0;
  function _activityEntryHtml(e) {
    if (e.kind === "tool") {
      return '<div class="row activity">'
        + '<div class="cell" style="color:var(--cyan)">▶</div>'
        + '<div class="cell dim">'+esc(e.name)+': '+esc(e.label || "")+'</div>'
        + '</div>';
    }
    return '<div class="row activity">'
      + '<div class="cell dim">»</div>'
      + '<div class="cell">'+esc(e.text || "")+'</div>'
      + '</div>';
  }
  function renderActivity({ reset = false } = {}) {
    if (!state) return;
    const inner = $("#activity-inner");
    const entries = state.agentLog || [];
    if (reset) {
      inner.innerHTML = "";
      activityShownCount = 0;
    }
    if (entries.length === 0 && activityShownCount === 0) {
      inner.innerHTML = '<div class="dim" style="padding:8px;">no activity</div>';
      return;
    }
    if (entries.length <= activityShownCount) return; // nothing new
    if (activityShownCount === 0) inner.innerHTML = ""; // clear the "no activity" placeholder
    const newEntries = entries.slice(activityShownCount);
    inner.insertAdjacentHTML("beforeend", newEntries.map(_activityEntryHtml).join(""));
    activityShownCount = entries.length;
    // Tail to bottom so the newest entries are visible.
    inner.scrollTop = inner.scrollHeight;
  }

  // Track the last-rendered commit signature so we (a) skip re-rendering
  // when nothing changed, and (b) don't flash "no commits" if the loader
  // returned an empty list transiently (git was busy when the API call
  // ran). The user sees a stable list that only grows as new commits land.
  let _gitlogSig = "";
  function renderGitlog() {
    if (!state) return;
    const inner = $("#gitlog-inner");
    const commits = state.gitLog || [];
    if (commits.length === 0) {
      if (_gitlogSig === "") {
        inner.innerHTML = '<div class="dim" style="padding:8px;">no commits</div>';
      }
      // else: keep showing the last good render — don't flash empty.
      return;
    }
    const sig = commits.map(c => c.hash).join("|");
    if (sig === _gitlogSig) return;
    _gitlogSig = sig;
    inner.innerHTML = commits.map(c =>
      '<div class="row gitlog">'
      + '<div class="cell hash">'+esc(c.hash)+'</div>'
      + '<div class="cell">'+esc(c.msg)+'</div>'
      + '<div class="cell right dim">'+esc(c.when)+'</div>'
      + '</div>'
    ).join("");
  }

  function render() {
    renderHeader();
    renderAgentsLabel();
    renderAgentsPanel();
    renderActivity();
    renderPipelinePanel();
    renderGitlog();
  }

  // Mirrors the TUI's menuOptions(row, branchExists) helper so the two
  // dashboards never diverge. branchExists is derived from the row's
  // branch field (truthy and not the "—" sentinel).
  function buildMenuOptions(row) {
    const branchExists = !!(row.branch && row.branch !== "—");
    const opts = [];
    if (["backlog","dev","research","review","test","queued"].includes(row.stage)) {
      const prefix = row.stage === "backlog" ? "Queue → " : "Re-queue → ";
      opts.push({ label: prefix + "Research", action: "queue:research" });
      opts.push({ label: prefix + "Dev",      action: "queue:dev"      });
      if (branchExists) {
        opts.push({ label: prefix + "Review (branch found)", action: "queue:review" });
        opts.push({ label: prefix + "Test   (branch found)", action: "queue:test"   });
      }
    }
    if (!["backlog","done"].includes(row.stage) && !row.virtual) opts.push({ label: "Return to backlog", action: "stage:backlog" });
    if (row.stage !== "done" && !row.virtual) opts.push({ label: "Delete row + plan file", action: "delete", danger: true });
    opts.push({ label: "Cancel", action: "cancel" });
    return opts;
  }

  function openActionMenu(row) {
    const opts = buildMenuOptions(row);
    const color = STAGE_COLOR[row.stage] || "var(--text)";
    $("#modal-title").innerHTML = esc(row.feature)
      + '<span class="stage" style="color:'+color+'"> · '+esc(row.stage)+'</span>';
    const ul = $("#modal-options");
    ul.innerHTML = opts.map((o,i) =>
      '<li data-i="'+i+'"'+(o.danger?' class="danger"':'')+'>'+esc(o.label)+'</li>'
    ).join("");
    ul.querySelectorAll("li").forEach(li => {
      li.onclick = async () => {
        const a = opts[+li.dataset.i].action;
        closeModal();
        if (a === "cancel") return;
        let r;
        if (a.startsWith("queue:")) {
          const type = a.split(":")[1];
          r = await fetch("/api/action/queue-plan", { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: state.project.name, planFile: row.plan_file, type }) });
        } else if (a.startsWith("stage:")) {
          const stage = a.split(":")[1];
          r = await fetch("/api/action/stage-set", { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: state.project.name, feature: row.feature, stage }) });
        } else if (a === "delete") {
          if (!confirm("Delete " + row.feature + "? Plan file will also be removed.")) return;
          r = await fetch("/api/action/row-delete", { method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: state.project.name, feature: row.feature, planFile: row.plan_file }) });
        }
        const toast = $("#toast");
        toast.textContent = (r && r.ok) ? "✓ " + a : "✗ " + a;
        setTimeout(() => { toast.textContent = ""; }, 2500);
        fetchState();
      };
    });
    $("#modal-backdrop").classList.add("show");
  }
  function closeModal() { $("#modal-backdrop").classList.remove("show"); }

  function openOrchModal(orch) {
    const opts = [];
    if (orch.alive) {
      opts.push({ label: "Stop orchestrator", action: "orch-stop" });
    } else {
      opts.push({ label: "Start orchestrator", action: "orch-start" });
    }
    opts.push({ label: "Refresh status", action: "refresh" });
    opts.push({ label: "Cancel", action: "cancel" });
    $("#modal-title").innerHTML = 'orchestrator <span class="stage" style="color:'
      + (orch.alive ? 'var(--green)' : 'var(--dim)')
      + '"> · '+ (orch.alive ? 'on' : (orch.status || 'off')) + '</span>';
    const ul = $("#modal-options");
    ul.innerHTML = opts.map((o,i) =>
      '<li data-i="'+i+'">'+esc(o.label)+'</li>'
    ).join("");
    ul.querySelectorAll("li").forEach(li => {
      li.onclick = async () => {
        const a = opts[+li.dataset.i].action;
        closeModal();
        if (a === "cancel") return;
        if (a === "refresh") { fetchState(); return; }
        const r = await fetch("/api/action/" + a, { method: "POST",
          headers: { "content-type": "application/json" }, body: "{}" });
        const toast = $("#toast");
        toast.textContent = (r && r.ok) ? "✓ " + a : "✗ " + a;
        setTimeout(() => { toast.textContent = ""; }, 2500);
        fetchState();
      };
    });
    $("#modal-backdrop").classList.add("show");
  }
  $("#modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop") closeModal(); };

  // Keyboard shortcuts mirror the TUI where reasonable.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === "o") { agentsView = (agentsView === "agents" ? "orch" : "agents"); render(); }
    if (e.key === "d") { showAll = !showAll; render(); }
    if (e.key === "r") { fetchState(); }
  });

  $("#project-picker").addEventListener("change", () => { selectedFeature = null; activityShownCount = 0; renderActivity({ reset: true }); fetchState(); });

  fetchState();
  setInterval(fetchState, 3000);
  // Animation tick — re-render agents panel (active spinners) every frame,
  // and update queue-spin chars in the pipeline panel in-place (textContent
  // only, no innerHTML rewrite) so hover state stays alive.
  setInterval(() => {
    if (!state) return;
    renderAgentsPanel();
    const qf = queueSpin();
    document.querySelectorAll(".row.pipeline .queue-spin").forEach(el => { el.textContent = qf; });
    const cf = claudeSpin();
    document.querySelectorAll(".claude-spin").forEach(el => { el.textContent = cf; });
    const sp = spin();
    document.querySelectorAll(".pipe-spin").forEach(el => { el.textContent = sp; });
    // Marquee is now pure-CSS — see @keyframes marquee.
  }, 110);
  setInterval(() => $("#clock").textContent = new Date().toLocaleTimeString(), 1000);
})();
</script>
</body>
</html>`;
}
