// Runs one authored Playwright Test spec against the same fixtures as the IR runner.
// The bake-off ships the `playwright` package (not `@playwright/test`), so a temp
// project supplies a one-line `@playwright/test` shim that re-exports `playwright/test`
// — one library instance, canonical import specifier for the author.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { playwrightPackageDir, playwrightEnv } from './paths.mjs';

let counter = 0;

function prepare(specPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ui-probe-pwtest-${process.pid}-${counter += 1}-`));
  const pkg = playwrightPackageDir();
  fs.mkdirSync(path.join(dir, 'node_modules', '@playwright', 'test'), { recursive: true });
  fs.symlinkSync(pkg, path.join(dir, 'node_modules', 'playwright'), 'junction');
  fs.writeFileSync(path.join(dir, 'node_modules', '@playwright', 'test', 'package.json'), JSON.stringify({
    name: '@playwright/test', version: '0.0.0', type: 'module', exports: { '.': './index.mjs' },
  }));
  fs.writeFileSync(path.join(dir, 'node_modules', '@playwright', 'test', 'index.mjs'), "export * from 'playwright/test';\n");
  fs.copyFileSync(specPath, path.join(dir, path.basename(specPath)));
  fs.writeFileSync(path.join(dir, 'playwright.config.mjs'), `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', workers: 1, fullyParallel: false, timeout: 30000, retries: 0,
  reporter: [['json', { outputFile: 'report.json' }]], outputDir: 'test-results' });
`);
  return dir;
}

function walkSuites(suite, out) {
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      out.push({
        title: spec.title,
        status: test.status,
        errors: (test.results || []).flatMap((r) => (r.errors || []).map((e) => e.message || String(e))),
      });
    }
  }
  for (const child of suite.suites || []) walkSuites(child, out);
}

// Collection only: proves the spec parses and declares at least one test, without
// running it. This is the Playwright format's own compiler doing the validating.
export function listPlaywrightSpec(specPath, { timeoutMs = 60000 } = {}) {
  const dir = prepare(specPath);
  const cli = path.join(playwrightPackageDir(), 'cli.js');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', '-c', 'playwright.config.mjs', '--list'], {
      cwd: dir, env: playwrightEnv({ CI: '1' }), windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      const text = `${out}\n${err}`.trim();
      const collected = /Total:\s*\d+\s+test/i.test(text) || /\bTotal:\s*[1-9]/.test(text) || /›/.test(out);
      resolve({ ok: code === 0 && collected, error: code === 0 ? (collected ? null : 'no tests collected') : text.slice(0, 1200) });
    });
  });
}

export function runPlaywrightSpec(specPath, { timeoutMs = 180000 } = {}) {
  const dir = prepare(specPath);
  const cli = path.join(playwrightPackageDir(), 'cli.js');
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cli, 'test', '-c', 'playwright.config.mjs'], {
      cwd: dir, env: playwrightEnv({ CI: '1' }), windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ passed: false, error: e.message, tests: [], ms: Date.now() - started }); });
    child.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      let report = null;
      try { report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')); } catch { /* no report */ }
      const tests = [];
      for (const suite of report?.suites || []) walkSuites(suite, tests);
      const topErrors = (report?.errors || []).map((e) => e.message || String(e));
      const failed = tests.filter((t) => t.status !== 'expected' && t.status !== 'skipped');
      const passed = tests.length > 0 && failed.length === 0 && topErrors.length === 0 && report?.stats?.unexpected === 0;
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({
        passed,
        tests,
        error: topErrors.length ? topErrors.join('\n') : (failed.flatMap((t) => t.errors).join('\n') || (tests.length === 0 ? `no tests collected\n${err.slice(0, 800)}` : null)),
        ms,
      });
    });
  });
}
