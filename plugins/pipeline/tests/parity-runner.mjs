// Parity runner — snapshot regression suite over tests/parity-fixtures/.
//
// Each fixture: input.json (argv + preload), expected.{db.json,stdout,stderr,exit}.
// CLI subprocess writes go to a tmp HOME so the operator's ~/.pipeline is never touched.
//
//   Run as test:        node --test tests/parity-runner.mjs
//   Regenerate fixtures: node tests/parity-runner.mjs --regen
//
// Legacy fixtures (captured from the pre-unified-DB Python pipeline) carry a
// `db_before_sql` SQL dump instead of `preload`. The runner converts them on
// first --regen pass: parses the SQL dump, derives the preload struct, runs the
// op, then rewrites input.json in the new shape and drops the obsolete
// expected.db.sql.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, writeFileSync, readdirSync, existsSync,
  mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { connectPath, close } from "../scripts/pipeline-db/connection.mjs";
import { projectAdd } from "../scripts/pipeline-db/projects.mjs";
import { rowAdd, rowUpdate } from "../scripts/pipeline-db/rows.mjs";
import { progressCreate, progressMark } from "../scripts/pipeline-db/progress.mjs";

const _here   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(_here, "parity-fixtures");
const PLUGIN  = dirname(_here);
const BIN     = join(PLUGIN, "bin", "pipeline.mjs");
const PROJECT = "testproject";
const REGEN   = process.argv.includes("--regen");

// ── Legacy SQL parsing (used only during migration from db_before_sql) ────────

const PY_PIPELINE_COLS = [
  "feature","plan_file","stage","branch","r_model","d_model","q_model",
  "session_type","session_file","budget_usd","qa_pass","dev_retries",
  "spawn_failed","notes_extra","created_at","updated_at","depends_on",
  "rebase_required","target_branch","last_error","rvw_model",
  "review_retries","review_retry_budget","review_verdict",
];
const PY_PROGRESS_FILE_COLS = [
  "slug","parent_slug","prefix","feature_project","pid","session_type",
  "is_active","created_at","completed_at","notes",
];
const PY_PROGRESS_STEP_COLS = ["id","slug","step_index","content","state"];

function parseSqlValues(s) {
  const out = []; let i = 0; const n = s.length;
  while (i < n) {
    while (i < n && (s[i] === " " || s[i] === ",")) i++;
    if (i >= n) break;
    if (s.startsWith("NULL", i)) { out.push(null); i += 4; }
    else if (s[i] === "'") {
      let v = ""; i++;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; }
        else if (s[i] === "'") { i++; break; }
        else v += s[i++];
      }
      out.push(v);
    } else {
      let num = "";
      while (i < n && /[-\d.eE+]/.test(s[i])) num += s[i++];
      if (num) out.push(Number(num));
    }
  }
  return out;
}
function parseInserts(sql, table, cols) {
  const rows = [];
  const re = new RegExp(`INSERT INTO "${table}" VALUES\\((.+?)\\);`, "g");
  let m;
  while ((m = re.exec(sql)) !== null) {
    const vals = parseSqlValues(m[1]);
    const obj = {};
    for (let k = 0; k < cols.length && k < vals.length; k++) obj[cols[k]] = vals[k];
    rows.push(obj);
  }
  return rows;
}

// Python iterdump renders UTF-8 em-dash (U+2014) bytes as latin-1: 'â€"'.
function unmojibake(v) {
  if (typeof v !== "string") return v;
  return v.replace(/â€”/g, "—");
}
function deepUnmojibake(obj) {
  if (Array.isArray(obj)) return obj.map(deepUnmojibake);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepUnmojibake(v);
    return out;
  }
  return unmojibake(obj);
}

// ── Fixture migration: db_before_sql → preload ────────────────────────────────

function migrateInput(caseDir, op, input) {
  if (input.preload) return input;
  const sqlBefore   = input.db_before_sql || "";
  const expectedSql = existsSync(join(caseDir, "expected.db.sql"))
    ? readFileSync(join(caseDir, "expected.db.sql"), "utf8") : "";

  const preload = {
    pipeline_rows:  parseInserts(sqlBefore, "pipeline_rows", PY_PIPELINE_COLS).map(deepUnmojibake),
    progress_files: [],
    progress_steps: [],
  };

  if (op === "progress-mark") {
    const targetSlug = input.argv[2];
    const files = parseInserts(expectedSql, "progress_files", PY_PROGRESS_FILE_COLS);
    const steps = parseInserts(expectedSql, "progress_steps", PY_PROGRESS_STEP_COLS);
    const file = files.find(f => f.slug === targetSlug);
    if (file) {
      preload.progress_files = [{
        slug: file.slug, parent_slug: file.parent_slug ?? null,
        prefix: file.prefix ?? null,
      }];
      preload.progress_steps = steps
        .filter(s => s.slug === targetSlug)
        .map(s => ({ slug: s.slug, step_index: s.step_index, content: s.content, state: "pending" }));
    }
  } else if (op === "progress-delete") {
    const files = parseInserts(expectedSql, "progress_files", PY_PROGRESS_FILE_COLS);
    const steps = parseInserts(expectedSql, "progress_steps", PY_PROGRESS_STEP_COLS);
    preload.progress_files = files.map(f => ({
      slug: f.slug, parent_slug: f.parent_slug ?? null, prefix: f.prefix ?? null,
    }));
    preload.progress_steps = steps.map(s => ({
      slug: s.slug, step_index: s.step_index, content: s.content, state: "pending",
    }));
  } else if (op === "progress-list-active" || op === "active-progress") {
    const files = parseInserts(expectedSql, "progress_files", PY_PROGRESS_FILE_COLS);
    const steps = parseInserts(expectedSql, "progress_steps", PY_PROGRESS_STEP_COLS);
    preload.progress_files = files.map(f => ({
      slug: f.slug, parent_slug: f.parent_slug ?? null, prefix: f.prefix ?? null,
    }));
    preload.progress_steps = steps.map(s => ({
      slug: s.slug, step_index: s.step_index, content: s.content, state: s.state || "pending",
    }));
  }

  return {
    argv:       input.argv,
    stdin_text: input.stdin_text ?? null,
    preload,
  };
}

// ── Seeding the unified DB from preload ───────────────────────────────────────

function seedFromPreload(db, preload) {
  for (const r of preload.pipeline_rows ?? []) {
    rowAdd(db, PROJECT, {
      feature:           r.feature,
      planFile:          r.plan_file,
      stage:             r.stage,
      branch:            r.branch,
      rModel:            r.r_model,
      dModel:            r.d_model,
      qModel:            r.q_model,
      rvwModel:          r.rvw_model,
      sessionType:       r.session_type,
      sessionFile:       r.session_file,
      budgetUsd:         r.budget_usd,
      dependsOn:         r.depends_on,
      targetBranch:      r.target_branch,
      reviewVerdict:     r.review_verdict,
      reviewRetries:     r.review_retries ?? undefined,
      reviewRetryBudget: r.review_retry_budget ?? undefined,
    });
    const update = {};
    if (r.qa_pass !== null && r.qa_pass !== undefined) update.qa_pass = r.qa_pass;
    if (r.dev_retries)     update.dev_retries     = r.dev_retries;
    if (r.spawn_failed)    update.spawn_failed    = r.spawn_failed;
    if (r.notes_extra)     update.notes_extra     = r.notes_extra;
    if (r.rebase_required) update.rebase_required = r.rebase_required;
    if (r.last_error)      update.last_error      = r.last_error;
    if (Object.keys(update).length) rowUpdate(db, PROJECT, r.feature, update);
  }

  const stepsBySlug = {};
  for (const s of preload.progress_steps ?? []) {
    (stepsBySlug[s.slug] ??= []).push(s);
  }
  const files = preload.progress_files ?? [];
  // Parents first so foreign-key-style parent_slug references resolve.
  const ordered = [
    ...files.filter(f => !f.parent_slug),
    ...files.filter(f =>  f.parent_slug),
  ];
  for (const f of ordered) {
    const fSteps = (stepsBySlug[f.slug] || [])
      .slice()
      .sort((a, b) => a.step_index - b.step_index);
    progressCreate(db, PROJECT, {
      slug:       f.slug,
      steps:      fSteps.map(s => s.content),
      parentSlug: f.parent_slug ?? null,
      prefix:     f.prefix ?? null,
    });
    for (const s of fSteps) {
      if (s.state && s.state !== "pending") {
        progressMark(db, f.slug, s.step_index, s.state);
      }
    }
  }
}

// ── DB snapshot for comparison ────────────────────────────────────────────────

// `projects` is fixture setup, not test data — root_path is OS-tmp non-deterministic.
const DUMP = {
  pipeline_rows:   { order: "project, feature",   drop: ["created_at", "updated_at"] },
  progress_files:  { order: "slug",               drop: ["created_at", "completed_at"] },
  progress_steps:  { order: "slug, step_index",   drop: ["id"] },
};

function dumpDb(db) {
  const out = {};
  for (const [table, { order, drop }] of Object.entries(DUMP)) {
    const dropSet = new Set(drop || []);
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    out[table] = rows.map(r => {
      const filtered = {};
      for (const [k, v] of Object.entries(r)) if (!dropSet.has(k)) filtered[k] = v;
      return filtered;
    });
  }
  return out;
}

// ── Per-fixture execution ─────────────────────────────────────────────────────

function makeFakeRepo(parent) {
  const repo = join(parent, "repo");
  mkdirSync(repo, { recursive: true });
  const r = spawnSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" });
  if (r.status !== 0) throw new Error("git init failed");
  return repo;
}

function translateArgv(rawArgv) {
  return rawArgv.map(a => (a === "{project_root}" || a === "{memory_dir}") ? PROJECT : a);
}

function runFixture(caseDir, op) {
  const rawInput = JSON.parse(readFileSync(join(caseDir, "input.json"), "utf8"));
  const input    = migrateInput(caseDir, op, rawInput);

  const tmp = mkdtempSync(join(tmpdir(), "parity-"));
  const isLinux = process.platform === "linux";
  const dataDir = isLinux
    ? join(tmp, ".local", "share", "pipeline")
    : join(tmp, ".pipeline");
  const xdgEnv = isLinux ? {
    XDG_CONFIG_HOME: join(tmp, ".config"),
    XDG_DATA_HOME:   join(tmp, ".local", "share"),
    XDG_STATE_HOME:  join(tmp, ".local", "state"),
  } : {};
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, ...xdgEnv };
  try {
    const repo   = makeFakeRepo(tmp);
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "pipeline.db");

    const db = connectPath(dbPath);
    try {
      projectAdd(db, { name: PROJECT, rootPath: repo });
      seedFromPreload(db, input.preload);

      if (op === "queue-plan") {
        // queue-plan reads plans/<feature>.md from the project root.
        const argvNoFlags = input.argv.filter(a => !a.startsWith("--"));
        // [op, {project_root}, feature]
        const feature = argvNoFlags[2];
        const plansDir = join(repo, "plans");
        mkdirSync(plansDir);
        writeFileSync(
          join(plansDir, feature + ".md"),
          `# ${feature}\n\n*Branch: \`autonomous/${feature}\`*\n`
        );
      } else if (op === "row-add") {
        // row-add now validates plan-file existence at intake. Seed the file
        // under <repo>/plans/ — matches the bare-filename resolution rule the
        // row-add check uses (mirrors queue-plan).
        // argv: [op, {project_root}, feature, plan-file, stage, ...flags]
        const planArg = input.argv[3];
        if (planArg && !planArg.startsWith("--")) {
          const plansDir = join(repo, "plans");
          mkdirSync(plansDir, { recursive: true });
          writeFileSync(join(plansDir, basename(planArg)), "# stub\n");
        }
      }
    } finally { close(db); }

    const argv = translateArgv(input.argv);
    const result = spawnSync(process.execPath, [BIN, ...argv], {
      env, cwd: PLUGIN, stdio: "pipe", timeout: 15000,
      input: input.stdin_text || undefined,
    });
    const rawStdout = result.stdout ? result.stdout.toString() : "";
    const stderr    = result.stderr ? result.stderr.toString() : "";
    const exitCode  = result.status;

    const db2 = connectPath(dbPath);
    let snapshot;
    try { snapshot = dumpDb(db2); } finally { close(db2); }

    // Normalise OS-tmp repo path to `{repo}` so fixtures stay portable across
    // runs and platforms. Stored absolute plan_file paths (from queue-plan)
    // depend on the temp dir; this canonicalises them. Backslashes in Windows
    // paths get converted to forward slashes throughout the snapshot and stdout.
    const repoFwd = repo.replace(/\\/g, "/");
    const normalisedSnapshot = JSON.parse(
      JSON.stringify(snapshot)
        .replace(/\\\\/g, "/")
        .replaceAll(repoFwd, "{repo}")
    );
    const stdout = rawStdout
      .replace(/\\\\/g, "/")
      .replaceAll(repo.replace(/\\/g, "/"), "{repo}")
      .replaceAll(repo, "{repo}");

    return { input, stdout, stderr, exitCode, snapshot: normalisedSnapshot };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Discovery ─────────────────────────────────────────────────────────────────

function discoverCases() {
  if (!existsSync(ROOT)) return [];
  const out = [];
  for (const op of readdirSync(ROOT).sort()) {
    const opDir = join(ROOT, op);
    if (!statSync(opDir).isDirectory()) continue;
    for (const c of readdirSync(opDir).sort()) {
      const caseDir = join(opDir, c);
      if (!statSync(caseDir).isDirectory()) continue;
      if (existsSync(join(caseDir, "input.json"))) out.push({ op, case: c, dir: caseDir });
    }
  }
  return out;
}

const cases = discoverCases();
if (cases.length === 0) {
  test("fixtures present", () => assert.fail(`no fixtures at ${ROOT}`));
}

if (REGEN) {
  for (const c of cases) {
    process.stdout.write(`regen: ${c.op}/${c.case}\n`);
    const r = runFixture(c.dir, c.op);
    writeFileSync(join(c.dir, "input.json"),       JSON.stringify(r.input, null, 2) + "\n");
    writeFileSync(join(c.dir, "expected.db.json"), JSON.stringify(r.snapshot, null, 2) + "\n");
    writeFileSync(join(c.dir, "expected.stdout"),  r.stdout);
    writeFileSync(join(c.dir, "expected.stderr"),  r.stderr);
    writeFileSync(join(c.dir, "expected.exit"),    String(r.exitCode) + "\n");
    const oldSql = join(c.dir, "expected.db.sql");
    if (existsSync(oldSql)) unlinkSync(oldSql);
  }
  process.stdout.write(`regenerated ${cases.length} fixtures\n`);
} else {
  for (const c of cases) {
    test(`parity ${c.op}/${c.case}`, () => {
      const normLf = s => s.replace(/\r\n/g, "\n");
      const expStdout = readFileSync(join(c.dir, "expected.stdout"), "utf8");
      const expStderr = existsSync(join(c.dir, "expected.stderr"))
        ? readFileSync(join(c.dir, "expected.stderr"), "utf8") : "";
      const expExit   = parseInt(readFileSync(join(c.dir, "expected.exit"), "utf8").trim(), 10);
      const expSnap   = JSON.parse(readFileSync(join(c.dir, "expected.db.json"), "utf8"));

      const r = runFixture(c.dir, c.op);

      if (c.op === "rows" || c.op === "progress-list-active" || c.op === "queue-plan") {
        const strip = obj => {
          if (Array.isArray(obj)) return obj.map(strip);
          if (obj && typeof obj === "object") {
            const out = {};
            for (const [k, v] of Object.entries(obj)) {
              if (k === "created_at" || k === "updated_at" || k === "completed_at") continue;
              out[k] = strip(v);
            }
            return out;
          }
          return obj;
        };
        assert.deepStrictEqual(
          strip(JSON.parse(normLf(r.stdout) || "null")),
          strip(JSON.parse(normLf(expStdout) || "null")),
          `stdout mismatch ${c.op}/${c.case}`
        );
      } else {
        assert.equal(normLf(r.stdout), normLf(expStdout),
          `stdout mismatch ${c.op}/${c.case}`);
      }
      assert.equal(normLf(r.stderr), normLf(expStderr),
        `stderr mismatch ${c.op}/${c.case}`);
      assert.equal(r.exitCode, expExit, `exit mismatch ${c.op}/${c.case}`);
      assert.deepStrictEqual(r.snapshot, expSnap,
        `db snapshot mismatch ${c.op}/${c.case}`);
    });
  }
}
