// Contender (i): Playwright Test (TypeScript).
//
// Honest asymmetry, reported in results: a TS spec cannot be compiled to the shared
// IR, so this format is validated by structure + required markers, and its
// correctness comes from Playwright's own runner rather than the IR runner.
// The collection step (`playwright test --list`) is the format's real parser.
import { listPlaywrightSpec, runPlaywrightSpec } from '../../lib/pwtest.mjs';

export const format = 'playwright-test';
export const extensions = ['.spec.ts'];

// Comments must not be able to satisfy a check: a spec whose only `expect(` is
// inside an explanatory comment asserts nothing, and must be rejected as such.
export function stripComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

export function staticProblems(rawSource, task) {
  const source = stripComments(rawSource);
  const errors = [];
  if (!/from\s+['"](?:@playwright\/test|playwright\/test)['"]/.test(source)) {
    errors.push("must import from '@playwright/test' (the harness ships that specifier)");
  }
  if (!/\btest\s*\(/.test(source)) errors.push('no test(...) declared');
  if (!/\bexpect\s*\(/.test(source)) errors.push('no expect(...) assertion — a scenario that asserts nothing is not a scenario');
  if (/\.only\s*\(/.test(source)) errors.push('.only is not allowed in a scored scenario');
  if (/\btest\.(skip|fixme)\s*\(/.test(source)) errors.push('skipped tests score as invalid');
  return errors;
}

// Coverage: does the spec reference the fixtures and the pinned expectation for
// every check? Scored as correctness, not validity — the same split as the IR
// formats, so `valid` means "the format was written correctly" in all three.
export function coverageProblems(rawSource, task) {
  const source = stripComments(rawSource).toLowerCase();
  const markers = [...new Set(task.checks.flatMap((c) => c.markers || []))];
  return markers
    .filter((marker) => !source.includes(String(marker).toLowerCase()))
    .map((marker) => `missing required marker ${JSON.stringify(marker)}`);
}

export async function validate(source, task, file) {
  const errors = staticProblems(source, task);
  if (!errors.length && file) {
    const list = await listPlaywrightSpec(file);
    if (!list.ok) errors.push(`playwright could not collect the spec: ${list.error}`);
  }
  return { errors, coverage: coverageProblems(source, task), ir: null };
}

export async function run(source, task, file) {
  const { errors } = await validate(source, task, file);
  if (errors.length) return { passed: false, failure: { op: 'validate', error: errors.join('; ') }, steps: [], ms: 0 };
  const result = await runPlaywrightSpec(file);
  return {
    passed: result.passed,
    failure: result.passed ? null : { op: 'playwright', error: result.error || 'tests failed' },
    steps: (result.tests || []).map((t) => ({ op: t.title, ok: t.status === 'expected', error: t.errors?.[0] })),
    ms: result.ms,
  };
}
