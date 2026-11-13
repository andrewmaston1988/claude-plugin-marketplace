#!/usr/bin/env node
// Scores scenario-format authorability (RQ8).
//
//   node score.mjs                 validate + run the shipped examples, and prove every
//                                  deliberately broken scenario is rejected
//   node score.mjs --dir <path>    score authored attempts (manifest.json or inferred paths)
//   node score.mjs --validate-only skip execution (validity only)
//
// Exits non-zero if any deliberately broken scenario passes validation, or (in the
// default self-check mode) if a shipped example fails to validate or run correct.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAll, PROBE_CLI } from './lib/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tasksDoc = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8'));
const TASKS = new Map(tasksDoc.tasks.map((t) => [t.id, t]));

const ADAPTERS = {
  'playwright-test': await import('./scenarios/playwright-test/validator.mjs'),
  'flat-yaml': await import('./scenarios/flat-yaml/validator.mjs'),
  gherkin: await import('./scenarios/gherkin/validator.mjs'),
};

function parseArgs(argv) {
  const args = { mode: 'self', dir: null, validateOnly: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') { args.mode = 'attempts'; args.dir = argv[i + 1]; i += 1; }
    else if (argv[i] === '--validate-only') args.validateOnly = true;
    else if (argv[i] === '--out') { args.out = argv[i + 1]; i += 1; }
    else if (argv[i] === '--help') { console.log('usage: node score.mjs [--dir <path>] [--validate-only] [--out <file>]'); process.exit(0); }
  }
  return args;
}

export function matchesExt(file, ext) {
  // endsWith, not path.extname: ".spec.ts" is two dots and extname returns ".ts".
  return file.toLowerCase().endsWith(ext.toLowerCase());
}

function formatFor(file) {
  return Object.entries(ADAPTERS).find(([, a]) => a.extensions.some((ext) => matchesExt(file, ext)))?.[0] || null;
}

function taskFor(file, declared) {
  if (declared && TASKS.has(declared)) return TASKS.get(declared);
  const base = path.basename(file).toLowerCase();
  return [...TASKS.keys()].find((id) => base.includes(id)) ? TASKS.get([...TASKS.keys()].find((id) => base.includes(id))) : null;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Attempts come either from a manifest (explicit) or from paths that carry
// <format>/<model>/<task> as segments (convenient for the authoring harness).
function collectAttempts(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entries = Array.isArray(manifest) ? manifest : manifest.attempts || [];
    return entries.map((e) => ({
      format: e.format || formatFor(e.file),
      model: e.model || 'unknown',
      task: e.task,
      file: path.resolve(dir, e.file),
    }));
  }
  return walk(dir).filter((f) => formatFor(f)).map((f) => {
    const segs = path.relative(dir, f).split(/[\\/]/).slice(0, -1);
    return {
      format: formatFor(f),
      model: segs.find((s) => !Object.keys(ADAPTERS).includes(s) && !TASKS.has(s)) || 'unknown',
      task: segs.find((s) => TASKS.has(s)) || null,
      file: f,
    };
  });
}

function selfCheckSet() {
  const entries = [];
  const root = path.join(HERE, 'scenarios');
  for (const format of Object.keys(ADAPTERS)) {
    const adapter = ADAPTERS[format];
    for (const bucket of ['examples', 'broken']) {
      const dir = path.join(root, format, bucket);
      if (!fs.existsSync(dir)) continue;
      for (const file of walk(dir).filter((f) => adapter.extensions.some((ext) => matchesExt(f, ext)))) {
        entries.push({
          format,
          bucket,
          model: 'shipped-example',
          task: taskFor(file)?.id,
          file,
        });
      }
    }
  }
  return entries;
}

async function scoreOne(entry, { validateOnly }) {
  const adapter = ADAPTERS[entry.format];
  const task = taskFor(entry.file, entry.task);
  if (!adapter) return { ...entry, valid: false, harnessError: true, validErrors: ['unknown format'], ran: false, correct: false };
  if (!task) return { ...entry, valid: false, harnessError: true, validErrors: ['cannot infer which task this scenario is for'], ran: false, correct: false };

  const source = fs.readFileSync(entry.file, 'utf8');
  let validation;
  try {
    validation = await adapter.validate(source, task, entry.file);
  } catch (err) {
    validation = { errors: [`validator threw: ${err.message}`], ir: null };
  }
  const valid = validation.errors.length === 0;
  const row = {
    format: entry.format,
    model: entry.model,
    task: task.id,
    file: path.relative(HERE, entry.file),
    bucket: entry.bucket || 'attempt',
    harnessError: false,
    valid,
    validErrors: validation.errors,
    coverage: validation.coverage || [],
    ran: false,
    correct: false,
    failure: null,
    ms: 0,
  };
  if (!valid || validateOnly) return row;

  let result;
  try {
    result = await adapter.run(source, task, entry.file);
  } catch (err) {
    result = { passed: false, failure: { op: 'run', error: err.message }, ms: 0 };
  }
  row.ran = true;
  const covered = row.coverage.length === 0;
  row.correct = Boolean(result.passed) && covered;
  row.failure = !result.passed
    ? result.failure?.error || 'failed'
    : (covered ? null : `ran green but does not assert the reference values: ${row.coverage.join('; ')}`);
  row.ms = result.ms || 0;
  return row;
}

function printTable(rows) {
  if (!rows.length) { console.log('(no scenarios)'); return; }
  const head = ['format', 'model', 'valid', 'correct', 'total'];
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.format}\u0000${r.model}`;
    const g = groups.get(key) || { format: r.format, model: r.model, valid: 0, correct: 0, total: 0 };
    g.total += 1;
    if (r.valid) g.valid += 1;
    if (r.correct) g.correct += 1;
    groups.set(key, g);
  }
  const widths = [24, 16, 5, 7, 5];
  console.log(head.map((h, i) => h.padEnd(widths[i])).join(' '));
  console.log(widths.map((w) => '-'.repeat(w)).join(' '));
  for (const g of [...groups.values()].sort((a, b) => a.format.localeCompare(b.format) || a.model.localeCompare(b.model))) {
    console.log([g.format, g.model, g.valid, g.correct, g.total].map((v, i) => String(v).padEnd(widths[i])).join(' '));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = args.mode === 'self' ? selfCheckSet() : collectAttempts(args.dir);
  if (!entries.length) {
    console.error(`no scenarios found${args.dir ? ` under ${args.dir}` : ''}`);
    process.exit(2);
  }

  const needs = new Set();
  for (const e of entries) {
    const task = taskFor(e.file, e.task);
    const backend = task?.backend;
    if (backend === 'browser') needs.add('web');
    if (backend === 'network') { needs.add('http'); needs.add('tcp'); }
    if (backend === 'desktop') needs.add('windows');
  }
  let fixtures = null;
  if (!args.validateOnly) {
    process.env.UI_PROBE_PROBE_CLI = PROBE_CLI;
    fixtures = await startAll({ need: [...needs] });
  }

  const rows = [];
  try {
    for (const entry of entries) {
      const row = await scoreOne(entry, args);
      rows.push(row);
      const mark = row.bucket === 'broken'
        ? (row.valid ? 'PASS-THROUGH (BAD)' : 'rejected')
        : `${row.valid ? 'valid' : 'INVALID'}${row.ran ? (row.correct ? '/correct' : '/WRONG') : ''}`;
      console.log(`${row.format.padEnd(16)} ${String(row.task).padEnd(13)} ${path.basename(row.file).padEnd(26)} ${mark}`);
      if (!row.valid && row.bucket !== 'broken') for (const e of row.validErrors) console.log(`    - ${e}`);
      if (row.valid && row.ran && !row.correct) console.log(`    ! ${row.failure}`);
    }
  } finally {
    if (fixtures) await fixtures.close();
  }

  console.log('');
  printTable(rows);

  const harnessErrors = rows.filter((r) => r.harnessError);
  if (harnessErrors.length) {
    console.error(`\nFAIL: ${harnessErrors.length} scenario(s) could not be scored (harness error, not a verdict on the scenario):`);
    for (const r of harnessErrors) console.error(`  ${r.file}: ${r.validErrors.join('; ')}`);
  }

  const broken = rows.filter((r) => r.bucket === 'broken');
  const leaked = broken.filter((r) => r.valid && !r.harnessError);
  if (leaked.length) {
    console.error(`\nFAIL: ${leaked.length} deliberately broken scenario(s) passed validation:`);
    for (const r of leaked) console.error(`  ${r.format}: ${r.file}`);
  } else if (broken.length) {
    console.log(`\nOK: all ${broken.length} deliberately broken scenarios were rejected.`);
  }

  const shipped = rows.filter((r) => r.bucket === 'examples');
  const shippedBad = shipped.filter((r) => !r.valid || (r.ran && !r.correct));
  if (shippedBad.length) {
    console.error(`\nFAIL: ${shippedBad.length} shipped example(s) invalid or incorrect.`);
  } else if (shipped.length) {
    console.log(args.validateOnly
      ? `OK: all ${shipped.length} shipped examples validated.`
      : `OK: all ${shipped.length} shipped examples validated and matched the reference values.`);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    mode: args.mode,
    validateOnly: args.validateOnly,
    fixtures: tasksDoc.fixtures,
    rows,
    counts: rows.reduce((acc, r) => {
      const key = `${r.format}/${r.model}`;
      acc[key] = acc[key] || { valid: 0, correct: 0, total: 0 };
      acc[key].total += 1;
      if (r.valid) acc[key].valid += 1;
      if (r.correct) acc[key].correct += 1;
      return acc;
    }, {}),
  };
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${args.out}`);
  }

  const failed = harnessErrors.length > 0 || leaked.length > 0 || (args.mode === 'self' && shippedBad.length > 0);
  process.exit(failed ? 1 : 0);
}

await main();
