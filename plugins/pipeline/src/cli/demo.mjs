// `pipeline demo` — a scripted, deterministic walk through the full
// pipeline lifecycle so a first-time user can see how everything fits
// together without installing real Claude, spawning orchestrator
// sessions, or risking real projects.
//
// Teaches two things:
//   1. The lifecycle — one feature goes queued → research → dev → review
//      → dev (blocked) → review (fixed) → merge.
//   2. Queue discipline / dependencies — three more rows are pre-queued
//      at `backlog`, each blocked on the main feature. When the main
//      feature merges, the dependents are released and run their own
//      arcs in parallel, each starting at a *different* stage to show
//      that pipeline rows don't all have to enter at the same point.
//
// During each "active" stage, the demo writes a session record + progress
// entries + tool-call JSONL directly to the same ~/.pipeline DB and
// transcript dir the real dashboards read. No subprocesses, no shims,
// no flaky orchestrator spawning.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  connectUnified, close,
  rowAdd, rowUpdate, rowDelete,
  projectAdd,
  sessionRecordSpawn, sessionFinish,
  progressCreate, progressMark, progressDelete,
} from "../db/index.mjs";
import { getPaths } from "../paths.mjs";
import { resolvePlansDir } from "../plans-resolver.mjs";

const PROJECT = "pipeline-demo";
const MAIN_FEATURE = "add-dark-mode-toggle";

// ── Main feature story ────────────────────────────────────────────────
const MAIN_STORY = [
  { stage: "queued",   delay: 2000, note: "queued for research" },

  { stage: "research", delay: 60000,
    sessionType: "research",
    steps: ["map relevant files", "skim past PRs for context", "outline approach", "produce research notes"],
    note: "Investigating the codebase, picking an approach…" },

  { stage: "dev",      delay: 60000,
    sessionType: "dev",
    steps: ["add ThemeContext", "wire toggle in Settings", "persist to localStorage", "fall back to prefers-color-scheme", "update App root", "tighten types"],
    note: "Research output: feature is viable. Touches Settings.tsx, theme.ts, App.tsx." },

  { stage: "review",   delay: 60000,
    sessionType: "review",
    steps: ["scan diff", "check edge cases", "verify tests cover", "write review notes"],
    note: "Implementation done — 47 lines added, 3 modified. Awaiting review." },

  { stage: "dev",      delay: 60000,
    sessionType: "dev",
    steps: ["reproduce the BLOCKER", "fix no-preference handling", "tighten doc strings", "re-run tests", "self-review", "update plan notes"],
    note: "[BLOCKER] does not handle prefers-color-scheme: no-preference\n[ADVISORY] doc strings on toggle helpers are verbose" },

  { stage: "review",   delay: 60000,
    sessionType: "review",
    steps: ["re-scan diff", "verify BLOCKER fix", "verify advisory addressed", "approve"],
    note: "Fixed it! System preference now respected; doc strings tightened." },

  { stage: "merge",    delay: 60000,
    sessionType: "merge",
    steps: ["fetch upstream", "rebase onto main", "re-run CI smoke", "fast-forward main", "delete feature branch", "tag release"],
    note: "[APPROVED] merged onto main — releasing dependent rows" },
];

// ── Dependent rows ────────────────────────────────────────────────────
const DEPENDENTS = [
  {
    feature: "persist-theme-across-tabs",
    backlogNote: "blocked: depends_on=add-dark-mode-toggle (needs ThemeContext)",
    arc: [
      { stage: "queued",   delay: 1000, note: "dep cleared — queued for research" },
      { stage: "research", delay: 30000, sessionType: "research",
        steps: ["check BroadcastChannel support", "consider storage event approach", "outline approach"],
        note: "Investigating cross-tab theme propagation…" },
      { stage: "dev",      delay: 30000, sessionType: "dev",
        steps: ["wire BroadcastChannel", "listen for storage event fallback", "update ThemeContext", "add tests"],
        note: "Implementing cross-tab sync." },
      { stage: "review",   delay: 25000, sessionType: "review",
        steps: ["scan diff", "verify no flicker on init", "approve"],
        note: "Reviewing cross-tab implementation." },
      { stage: "merge",    delay: 20000, sessionType: "merge",
        steps: ["rebase onto main", "smoke test", "ff-only push"],
        note: "[APPROVED] merged." },
    ],
  },
  {
    feature: "add-theme-system-tray-icon",
    backlogNote: "blocked: depends_on=add-dark-mode-toggle (needs theme value to render icon)",
    arc: [
      { stage: "queued",   delay: 1000, note: "dep cleared — plan already approved, queued for dev" },
      { stage: "dev",      delay: 30000, sessionType: "dev",
        steps: ["add tray icon asset", "subscribe to theme changes", "swap icon source", "test on Windows + macOS"],
        note: "Implementing system tray icon swap." },
      { stage: "review",   delay: 25000, sessionType: "review",
        steps: ["scan diff", "verify cross-platform paths", "approve"],
        note: "Reviewing tray-icon implementation." },
      { stage: "merge",    delay: 20000, sessionType: "merge",
        steps: ["rebase onto main", "smoke test", "ff-only push"],
        note: "[APPROVED] merged." },
    ],
  },
  {
    feature: "dark-mode-changelog-entry",
    backlogNote: "blocked: depends_on=add-dark-mode-toggle (changelog references the feature)",
    arc: [
      { stage: "queued",   delay: 1000, note: "dep cleared — external PR ready, queued for review" },
      { stage: "review",   delay: 25000, sessionType: "review",
        steps: ["scan CHANGELOG diff", "verify wording matches feature", "approve"],
        note: "Reviewing docs-only PR." },
      { stage: "merge",    delay: 20000, sessionType: "merge",
        steps: ["rebase onto main", "ff-only push"],
        note: "[APPROVED] merged." },
    ],
  },
];

const FLAVOR = {
  research: [
    "scanning imports — Settings and Layout look most affected",
    "checking past PRs for prior dark-mode work",
    "no existing theme context — will need to add one",
    "noting prefers-color-scheme as the fallback path",
    "research notes draft looks complete",
  ],
  dev: [
    "adding the new context module",
    "tests look green so far",
    "tightening types — useTheme returns a discriminated union",
    "double-checking the wiring",
    "running tsc one more time",
    "self-review: looks clean",
  ],
  review: [
    "reading the diff top to bottom",
    "edge case check: prefers-color-scheme not preferred? not handled",
    "tests cover happy path but not the no-preference branch",
    "minor: verbose doc strings",
    "drafting review comments",
  ],
  merge: [
    "checking the working tree is clean",
    "no conflicts on rebase",
    "smoke tests green",
    "ff-only push succeeded",
    "branch cleanup done",
  ],
};

const TOOL_TEMPLATES = {
  research: [
    (s) => ({ name: "Grep",      input: { pattern: "theme|dark[- ]mode", path: "src/" } }),
    (s) => ({ name: "Read",      input: { file_path: "src/Settings.tsx" } }),
    (s) => ({ name: "WebSearch", input: { query: `react ${s}` } }),
    (s) => ({ name: "Write",     input: { file_path: "research-notes.md", content: `# ${s}\n\n…\n` } }),
  ],
  dev: [
    (s) => ({ name: "Edit",  input: { file_path: "src/theme.ts", old_string: "// theme defaults", new_string: "// theme defaults + dark mode" } }),
    (s) => ({ name: "Write", input: { file_path: "src/ThemeContext.tsx", content: "import React from 'react'…" } }),
    (s) => ({ name: "Edit",  input: { file_path: "src/Settings.tsx", old_string: "<Toggle …", new_string: "<Toggle id='dark-mode' …" } }),
    (s) => ({ name: "Bash",  input: { command: "npm test -- --watch=false" } }),
    (s) => ({ name: "Edit",  input: { file_path: "src/App.tsx", old_string: "<App>", new_string: "<ThemeProvider><App>" } }),
    (s) => ({ name: "Bash",  input: { command: "npx tsc --noEmit" } }),
  ],
  review: [
    (s) => ({ name: "Read", input: { file_path: "src/ThemeContext.tsx" } }),
    (s) => ({ name: "Grep", input: { pattern: "prefers-color-scheme", path: "src/" } }),
    (s) => ({ name: "Read", input: { file_path: "src/__tests__/theme.test.ts" } }),
    (s) => ({ name: "Bash", input: { command: "git diff main..HEAD -- src/" } }),
  ],
  merge: [
    (s) => ({ name: "Bash", input: { command: "git fetch origin main" } }),
    (s) => ({ name: "Bash", input: { command: "git rebase origin/main" } }),
    (s) => ({ name: "Bash", input: { command: "npm test -- --watch=false" } }),
    (s) => ({ name: "Bash", input: { command: "git push origin main --ff-only" } }),
    (s) => ({ name: "Bash", input: { command: "git branch -D feature/feature-branch" } }),
    (s) => ({ name: "Bash", input: { command: "git tag -a v0.42.0 -m 'release'" } }),
  ],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Structured event stream — the /pipeline demo subcommand tails this and narrates
// each event in user-facing prose. Format: [event] <kind> key=value ...
function _emitEvent(kind, fields = {}) {
  const parts = [`[event] ${kind}`];
  for (const [k, v] of Object.entries(fields)) {
    const safe = String(v == null ? "" : v).replace(/\s+/g, "_");
    parts.push(`${k}=${safe}`);
  }
  process.stdout.write(parts.join(" ") + "\n");
}

function _jsonlPath(projectRoot, correlationId) {
  const enc = String(projectRoot).replace(/[:\\/]/g, "-");
  const dir = join(homedir(), ".claude", "projects", enc);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${correlationId}.jsonl`);
}

function _appendAssistant(jsonlPath, block) {
  appendFileSync(jsonlPath, JSON.stringify({
    type:    "assistant_message",
    message: { role: "assistant", content: [block] },
  }) + "\n");
}

function _purgeProject(db) {
  for (const f of [MAIN_FEATURE, ...DEPENDENTS.map(d => d.feature)]) {
    try { rowDelete(db, PROJECT, f); } catch {}
  }
  try {
    db.prepare("DELETE FROM pipeline_rows WHERE project = ?").run(PROJECT);
    db.prepare("DELETE FROM sessions WHERE project = ?").run(PROJECT);
    db.prepare("DELETE FROM progress_steps WHERE slug IN (SELECT slug FROM progress_files WHERE project = ?)").run(PROJECT);
    db.prepare("DELETE FROM progress_files WHERE project = ?").run(PROJECT);
    db.prepare("DELETE FROM projects WHERE name = ?").run(PROJECT);
  } catch {}
}

async function _runActiveStage(db, projectRoot, feature, step, stepIndex, isAborted) {
  _emitEvent("session_start", { feature, session_type: step.sessionType, steps: step.steps.length, stage: step.stage });
  const correlationId = `${feature}-${step.sessionType}-${stepIndex}-${Date.now()}`;
  const sessionFile = join(projectRoot, "sessions", `${step.sessionType}-${stepIndex}-${feature}.md`);
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, `# ${step.sessionType} session ${stepIndex} for ${feature}\n`);

  sessionRecordSpawn(db, {
    correlationId,
    project:     PROJECT,
    feature,
    sessionType: step.sessionType,
    cwd:         projectRoot,
    sessionFile,
    // pid=1 takes the TUI's _pidAlive `pid <= 4` early-return path,
    // so the spinner shows instead of a red ✗.
    pid: 1,
  });

  const slug = `${step.sessionType}-${stepIndex}-${feature}`;
  progressCreate(db, PROJECT, { slug, steps: step.steps, sessionType: step.sessionType, pid: 1 });

  const jsonlPath = _jsonlPath(projectRoot, correlationId);
  _appendAssistant(jsonlPath, { type: "text", text: `Starting ${step.sessionType} session for ${feature}.` });

  const palette = TOOL_TEMPLATES[step.sessionType] || TOOL_TEMPLATES.dev;
  const flavors = FLAVOR[step.sessionType] || FLAVOR.dev;
  const stepCount = step.steps.length;
  const tickMs = Math.max(400, Math.floor(step.delay / stepCount));
  const SUB_EMISSIONS = 3;
  const subMs = Math.max(300, Math.floor(tickMs / SUB_EMISSIONS));

  for (let s = 1; s <= stepCount; s++) {
    if (isAborted()) break;
    progressMark(db, slug, s, "inprogress");

    for (let sub = 0; sub < SUB_EMISSIONS; sub++) {
      if (isAborted()) break;
      if (sub === 0) {
        _appendAssistant(jsonlPath, { type: "text", text: `→ ${step.steps[s - 1]}` });
      } else {
        const fIdx = ((s - 1) * SUB_EMISSIONS + sub) % flavors.length;
        _appendAssistant(jsonlPath, { type: "text", text: flavors[fIdx] });
      }
      const tIdx = ((s - 1) * SUB_EMISSIONS + sub) % palette.length;
      _appendAssistant(jsonlPath, { type: "tool_use", ...palette[tIdx](step.steps[s - 1]) });
      await sleep(subMs);
    }

    if (isAborted()) break;
    progressMark(db, slug, s, "completed");
  }

  if (step.sessionType === "merge" && feature === MAIN_FEATURE) {
    _appendAssistant(jsonlPath, { type: "text", text: `[demo] merging '${feature}' — releasing ${DEPENDENTS.length} dependent rows` });
  } else {
    _appendAssistant(jsonlPath, { type: "text", text: `${step.sessionType} session complete.` });
  }
  sessionFinish(db, correlationId);
  _emitEvent("session_end", { feature, session_type: step.sessionType });
  // Git commit happens at the pop-off moment in _walkStory, not here.
}

async function _walkStory(db, projectRoot, feature, story, isAborted) {
  for (let i = 0; i < story.length && !isAborted(); i++) {
    const step = story[i];
    rowUpdate(db, PROJECT, feature, { stage: step.stage, notes_extra: step.note });
    const firstNoteLine = step.note.split("\n")[0];
    _emitEvent("stage", { feature, stage: step.stage, note: firstNoteLine });
    if (step.sessionType) {
      await _runActiveStage(db, projectRoot, feature, step, i, isAborted);
    } else if (step.delay > 0 && !isAborted()) {
      await sleep(step.delay);
    }
  }
  // Idle 60s at merge, then pop off + commit at the same moment.
  if (!isAborted()) {
    _emitEvent("merge_idle", { feature });
    await sleep(60000);
    if (!isAborted()) {
      rowUpdate(db, PROJECT, feature, { stage: "done", notes_extra: "merged + idle window elapsed" });
      let hash = "";
      try {
        const markerFile = join(projectRoot, "sessions", `merged-${feature}.txt`);
        writeFileSync(markerFile, `merged: ${feature}\n`);
        spawnSync("git", ["add", "."], { cwd: projectRoot });
        spawnSync("git", ["commit", "-q", "-m", feature], { cwd: projectRoot });
        const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
        if (r.status === 0) hash = (r.stdout || "").trim();
      } catch {}
      _emitEvent("pop", { feature, commit_hash: hash, commit_msg: feature });
    }
  }
}

export async function run(cmd, argv) {
  if (cmd !== "demo") return null;
  const flags = new Set(argv);
  const cleanup = flags.has("--cleanup-only");

  const paths = getPaths();
  const db = connectUnified(paths);

  if (cleanup) {
    _purgeProject(db);
    close(db);
    process.stdout.write(`pipeline demo: cleaned up '${PROJECT}'\n`);
    setTimeout(() => process.exit(0), 150);
    return;
  }

  _purgeProject(db);

  const root = mkdtempSync(join(tmpdir(), "pipeline-demo-"));
  const projectRoot = join(root, "project");
  const plansDir = resolvePlansDir({ project: PROJECT, projectRoot });
  mkdirSync(plansDir, { recursive: true });

  const mainPlan = join(plansDir, `${MAIN_FEATURE}.md`);
  writeFileSync(mainPlan,
    "# add dark mode toggle\n\n" +
    "- preference toggle in settings\n" +
    "- persist to localStorage\n" +
    "- fall back to system preference (prefers-color-scheme)\n"
  );
  for (const dep of DEPENDENTS) {
    writeFileSync(
      join(plansDir, `${dep.feature}.md`),
      `# ${dep.feature.replace(/-/g, " ")}\n\n- depends on ${MAIN_FEATURE}\n`
    );
  }

  // Minimal git init so the dashboard's gitLog panel has something to show.
  // We pre-bake a handful of realistic-looking commits at startup — the demo
  // itself does no per-stage git work, the row state lives only in the DB.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.email", "demo@pipeline"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name",  "pipeline-demo"], { cwd: projectRoot });
  const FAKE_COMMITS = [
    { msg: "initial: project scaffolding",          file: "README.md",   body: "# demo project\n" },
    { msg: "feat: add Settings page",               file: "src/Settings.tsx", body: "// Settings\n" },
    { msg: "feat: theme tokens",                    file: "src/theme.ts", body: "// theme tokens\n" },
    { msg: "chore: bump deps",                      file: "package.json", body: '{"name":"demo"}\n' },
    { msg: "fix: null-guard prefs read",            file: "src/Settings.tsx", body: "// Settings v2\n" },
    { msg: "test: snapshot Settings render",        file: "src/__tests__/settings.test.ts", body: "// test\n" },
  ];
  for (const c of FAKE_COMMITS) {
    const fp = join(projectRoot, c.file);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, c.body);
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-q", "-m", c.msg], { cwd: projectRoot });
  }

  // Direct DB insert — bypass projectAdd's validation entirely.
  db.prepare(
    "INSERT INTO projects (name, root_path, enabled, created_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)"
  ).run(PROJECT, projectRoot);

  for (const dep of DEPENDENTS) {
    rowAdd(db, PROJECT, {
      feature:    dep.feature,
      planFile:   join(plansDir, `${dep.feature}.md`),
      stage:      "backlog",
      dependsOn:  MAIN_FEATURE,
    });
    rowUpdate(db, PROJECT, dep.feature, { notes_extra: dep.backlogNote });
    _emitEvent("queued", { feature: dep.feature, stage: "backlog", depends_on: MAIN_FEATURE });
  }

  _emitEvent("ready", {
    dashboard:    "http://localhost:8765/pipeline",
    project:      PROJECT,
    main_feature: MAIN_FEATURE,
    deps:         DEPENDENTS.map(d => d.feature).join(","),
  });

  setTimeout(() => {
    if (aborted) return;
    for (const dep of DEPENDENTS) {
      try {
        rowUpdate(db, PROJECT, dep.feature, {
          stage:       "queued",
          notes_extra: `queued — waiting for ${MAIN_FEATURE} to merge`,
        });
        _emitEvent("queued", { feature: dep.feature, stage: "queued", from: "backlog", reason: `waiting_for=${MAIN_FEATURE}` });
      } catch {}
    }
  }, 60000);

  process.stdout.write(
`\npipeline demo: ready.

  Project: ${PROJECT}
  Dashboard: http://localhost:8765/pipeline   (or: pipeline dashboard tui)

You'll see:
  • ${MAIN_FEATURE} walking queued → research → dev → review → dev
    (blocked) → review (fixed) → merge over ~6 min.
  • Three dependent rows sitting in 'backlog', each blocked on the
    main feature. When main merges they jump into action *in parallel*,
    each starting at a different stage (research / dev / review) to
    show that pipeline rows don't all enter at the same point.

Press Ctrl-C to stop and clean up.
`
  );

  let aborted = false;
  const isAborted = () => aborted;
  const tearDown = () => {
    if (aborted) return;
    aborted = true;
    process.stdout.write(`\npipeline demo: shutting down…\n`);
    try { _purgeProject(db); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { close(db); } catch {}
    setTimeout(() => process.exit(0), 150);
  };
  process.on("SIGINT",  tearDown);
  process.on("SIGTERM", tearDown);

  // Main: create the row and walk it (_walkStory handles idle + pop-off + commit at tail).
  rowAdd(db, PROJECT, { feature: MAIN_FEATURE, planFile: mainPlan, stage: MAIN_STORY[0].stage });
  _emitEvent("queued", { feature: MAIN_FEATURE, stage: MAIN_STORY[0].stage });
  await _walkStory(db, projectRoot, MAIN_FEATURE, MAIN_STORY, isAborted);
  if (aborted) return;

  _emitEvent("unblock", { features: DEPENDENTS.map(d => d.feature).join(","), because: `${MAIN_FEATURE}_popped` });

  await Promise.all(DEPENDENTS.map(async (dep) => {
    if (aborted) return;
    await _walkStory(db, projectRoot, dep.feature, dep.arc, isAborted);
  }));

  if (!aborted) _emitEvent("complete");

  if (aborted) return;

  process.stdout.write(`\npipeline demo: story complete. All 4 rows at 'merge' for inspection.\nPress Ctrl-C to teardown.\n`);

  const keepalive = setInterval(() => {}, 1 << 30);
  await new Promise((resolveExit) => {
    process.on("SIGINT",  resolveExit);
    process.on("SIGTERM", resolveExit);
  });
  clearInterval(keepalive);
  tearDown();
}
