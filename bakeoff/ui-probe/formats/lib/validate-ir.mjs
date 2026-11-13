// The one scenario vocabulary all three formats are scored against.
// Flat-YAML and Gherkin compile to this IR; Playwright Test is free-form TypeScript
// and cannot be compiled, so it is validated by structure + markers instead
// (see formats/playwright-test/validator.mjs — the asymmetry is reported).

export const OPS = {
  open: { required: ['url'], url: true },
  viewport: { required: ['width', 'height'], numbers: ['width', 'height'], optional: ['touch'] },
  hover: { required: ['target'], target: true },
  tap: { required: ['target'], target: true },
  click: { required: ['target'], target: true },
  expect_visible: { required: ['target'], target: true, optional: ['timeoutMs'] },
  expect_hidden: { required: ['target'], target: true, optional: ['timeoutMs'] },
  expect_widths: { required: ['target', 'equals'], target: true, optional: ['tolerance'] },
  expect_css: { required: ['target', 'property', 'equals'], target: true, optional: ['tolerance'] },
  expect_text: { required: ['target', 'equals'], target: true },
  expect_json: { required: ['url', 'path', 'equals'], url: true },
  tcp_banner: { required: ['port', 'equals'], numbers: ['port'], optional: ['host'] },
  uia_text: { required: ['window', 'control', 'equals'] },
};

const ROLE_TARGET = /^role=([a-z]+)(?:\[name=(?:"[^"]*"|'[^']*')\])?$/;

export function targetProblem(target) {
  if (typeof target !== 'string' || !target.trim()) return 'target must be a non-empty string';
  if (target.startsWith('role=') && !ROLE_TARGET.test(target)) {
    return `bad role target ${JSON.stringify(target)}; expected role=<role>[name="<name>"]`;
  }
  return null;
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// Validates one IR step. Returns an array of problems (empty = fine).
export function stepProblems(step, where) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return [`${where}: step must be an object`];
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    return [`${where}: a step has exactly one op key, got ${keys.length} (${keys.join(', ') || 'none'})`];
  }
  const op = keys[0];
  const spec = OPS[op];
  if (!spec) return [`${where}: unknown op ${JSON.stringify(op)}; allowed: ${Object.keys(OPS).join(', ')}`];

  const args = step[op];
  const problems = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return [`${where} (${op}): parameters must be an object`];
  }
  for (const key of Object.keys(args)) {
    const allowed = spec.required.includes(key) || (spec.optional || []).includes(key);
    if (!allowed) problems.push(`${where} (${op}): unknown parameter ${JSON.stringify(key)}; allowed: ${[...spec.required, ...(spec.optional || [])].join(', ')}`);
  }
  for (const key of spec.required) {
    if (!(key in args)) problems.push(`${where} (${op}): missing required parameter ${JSON.stringify(key)}`);
  }
  if (spec.url && 'url' in args && !/^https?:\/\/\S+$/.test(String(args.url))) {
    problems.push(`${where} (${op}): url must be http(s), got ${JSON.stringify(args.url)}`);
  }
  if (spec.target && 'target' in args) {
    const p = targetProblem(args.target);
    if (p) problems.push(`${where} (${op}): ${p}`);
  }
  for (const key of spec.numbers || []) {
    if (key in args && !isNumber(args[key])) problems.push(`${where} (${op}): ${key} must be a finite number`);
  }
  if ('timeoutMs' in args && (!isNumber(args.timeoutMs) || args.timeoutMs <= 0)) {
    problems.push(`${where} (${op}): timeoutMs must be a positive number`);
  }
  if ('tolerance' in args && (!isNumber(args.tolerance) || args.tolerance < 0)) {
    problems.push(`${where} (${op}): tolerance must be a number >= 0`);
  }
  if (op === 'expect_widths') {
    const eq = args.equals;
    if (!Array.isArray(eq) || eq.length === 0 || !eq.every(isNumber)) {
      problems.push(`${where} (${op}): equals must be a non-empty array of numbers`);
    }
  }
  if (op === 'expect_css' && 'property' in args && (typeof args.property !== 'string' || !args.property.trim())) {
    problems.push(`${where} (${op}): property must be a non-empty string`);
  }
  return problems;
}

export function irProblems(ir, task) {
  const problems = [];
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) return ['scenario must be an object'];
  for (const key of ['id', 'task', 'backend', 'steps']) {
    if (!(key in ir)) problems.push(`missing top-level field ${JSON.stringify(key)}`);
  }
  if (ir.task && ir.task !== task.id) problems.push(`task is ${JSON.stringify(ir.task)}, expected ${JSON.stringify(task.id)}`);
  if (ir.backend && ir.backend !== task.backend) {
    problems.push(`backend is ${JSON.stringify(ir.backend)}, expected ${JSON.stringify(task.backend)}`);
  }
  if (!Array.isArray(ir.steps) || ir.steps.length === 0) {
    problems.push('steps must be a non-empty list');
    return problems;
  }
  ir.steps.forEach((step, i) => problems.push(...stepProblems(step, `steps[${i}]`)));
  return problems;
}

export function assertsNothing(ir) {
  const assertionOps = new Set(['expect_visible', 'expect_hidden', 'expect_widths', 'expect_css', 'expect_text', 'expect_json', 'tcp_banner', 'uia_text']);
  const has = Array.isArray(ir?.steps) && ir.steps.some((s) => assertionOps.has(Object.keys(s || {})[0]));
  return has ? [] : ['no assertion step: a scenario that asserts nothing is not a scenario'];
}

// A uniform single value satisfies a uniform list (all elements the same width).
function sameValue(actual, expected) {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length === expected.length && actual.every((v, i) => String(v) === String(expected[i]))) return true;
    return actual.length === 1 && expected.every((v) => String(v) === String(actual[0]));
  }
  return String(actual) === String(expected);
}

// Every reference check the task pins must have a step that addresses it.
// Without this a scenario can be valid, run clean, and assert nothing.
export function coverageProblems(ir, task) {
  const steps = Array.isArray(ir?.steps) ? ir.steps : [];
  const problems = [];
  for (const check of task.checks) {
    const hit = steps.some((step) => {
      const op = Object.keys(step || {})[0];
      if (op !== check.op) return false;
      const args = step[op] || {};
      if (check.target && !String(args.target || '').includes(check.target)) return false;
      if (check.url && String(args.url || '') !== check.url) return false;
      if (check.control && String(args.control || '') !== check.control) return false;
      if (check.property && String(args.property || '') !== check.property) return false;
      if (check.port && Number(args.port) !== Number(check.port)) return false;
      if ('equals' in check && !sameValue(args.equals, check.equals)) return false;
      return true;
    });
    if (!hit) problems.push(`no step asserts reference check ${JSON.stringify(check.id)} (expected ${check.op} on ${check.target || check.url || check.control}${'equals' in check ? ` = ${JSON.stringify(check.equals)}` : ''})`);
  }
  return problems;
}
