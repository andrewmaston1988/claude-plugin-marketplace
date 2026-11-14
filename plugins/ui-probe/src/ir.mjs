import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { KEYS, isKnownKey } from './tv/keys.mjs';
import { parseYaml } from './yaml.mjs';

export const OPS = {
  open: { required: ['url'], url: true },
  viewport: { required: ['width', 'height'], optional: ['touch', 'dpr'] },
  hover: { required: ['target'], target: true },
  tap: { required: ['target'], target: true },
  click: { required: ['target'], target: true },
  key: { required: ['key'], optional: ['repeat', 'gapMs', 'autoRepeat'] },
  include: { include: true },
  expect_visible: { required: ['target'], optional: ['timeoutMs'], target: true, assertion: true },
  expect_hidden: { required: ['target'], optional: ['timeoutMs'], target: true, assertion: true },
  expect_widths: { required: ['target', 'equals'], optional: ['tolerance', 'timeoutMs'], target: true, assertion: true },
  expect_css: { required: ['target', 'property', 'equals'], optional: ['tolerance', 'timeoutMs', 'over', 'mode'], target: true, assertion: true },
  expect_text: { required: ['target', 'equals'], optional: ['timeoutMs', 'over', 'mode'], target: true, assertion: true },
  expect_within: { required: ['target', 'box'], optional: ['holdMs', 'timeoutMs'], target: true, assertion: true },
  expect_prop: { required: ['target', 'property'], optional: ['equals', 'gt', 'lt', 'timeoutMs', 'over', 'mode'], target: true, assertion: true },
  expect_count: { required: ['target'], optional: ['equals', 'gt', 'lt', 'timeoutMs', 'over', 'mode'], target: true, assertion: true },
  expect_json: { required: ['url', 'path', 'equals'], url: true, assertion: true },
};

const POINTER_OPS = new Set(['hover', 'tap', 'click']);
const KEY_NAMES = Object.keys(KEYS);
const COMPARATORS = ['equals', 'gt', 'lt'];

const EXAMPLES = {
  open: '{ open: { url: "/media/603" } }',
  viewport: '{ viewport: { width: 390, height: 844, dpr: 3, touch: true } }',
  target: '{ click: { target: "[data-testid=save]" } }',
  expect_visible: '{ expect_visible: { target: ".dialog", timeoutMs: 5000 } }',
  expect_hidden: '{ expect_hidden: { target: ".dialog" } }',
  expect_widths: '{ expect_widths: { target: ".tile", equals: [111, 111, 111], tolerance: 1 } }',
  expect_css: '{ expect_css: { target: ".tile", property: "display", equals: "flex", over: 400 } }',
  expect_text: '{ expect_text: { target: "h1", equals: "Welcome" } }',
  key: '{ key: { key: "Down", repeat: 2 } }',
  include: '{ include: "sign-in.yaml" }',
  expect_within: '{ expect_within: { target: ".tv-card.focused", box: "safe" } }',
  expect_prop: '{ expect_prop: { target: "video", property: "paused", equals: false } }',
  expect_count: '{ expect_count: { target: "video", equals: 1 } }',
  expect_json: '{ expect_json: { url: "/health", path: "ok", equals: true } }',
};

function problem(field, message, fix, example) {
  return { field, problem: message, fix, example };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUrl(value) {
  return typeof value === 'string' && (/^https?:\/\/\S+$/.test(value) || value.startsWith('/'));
}

function validateStep(step, index, backend, problems) {
  const where = `steps[${index}]`;
  if (!isRecord(step)) {
    problems.push(problem(where, 'step must be an object', 'Use one operation with an object of parameters.', EXAMPLES.open));
    return;
  }
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    problems.push(problem(where, 'step must contain exactly one operation', 'Keep one operation per step.', EXAMPLES.open));
    return;
  }
  const op = keys[0];
  const args = step[op];
  const spec = OPS[op];
  if (!spec) {
    if (op === 'tcp_banner' || op === 'uia_text') {
      problems.push(problem(`${where}.${op}`, `${op} is not supported in this version.`, 'Use a supported operation in this phase.', EXAMPLES.expect_json));
    } else {
      problems.push(problem(`${where}.${op}`, `unknown op ${JSON.stringify(op)}`, `Choose one of: ${Object.keys(OPS).join(', ')}.`, EXAMPLES.expect_visible));
    }
    return;
  }
  if (spec.include) {
    if (typeof args !== 'string' || !args.trim()) {
      problems.push(problem(`${where}.include`, 'include must be a file path', 'Name a .yaml or .json journey file next to this one.', EXAMPLES.include));
    }
    return;
  }
  if (backend === 'http' && op !== 'expect_json') {
    problems.push(problem(`${where}.${op}`, 'http scenarios support only expect_json', 'Use expect_json or set backend to browser.', EXAMPLES.expect_json));
  }
  if (backend === 'tv' && POINTER_OPS.has(op)) {
    problems.push(problem(`${where}.${op}`, `a tv journey cannot ${op}: the remote has no pointer`, 'Use key steps; the TV backend is keyboard-only.', EXAMPLES.key));
  }
  if (!isRecord(args)) {
    problems.push(problem(`${where}.${op}`, 'parameters must be an object', 'Provide the operation parameters as an object.', EXAMPLES[op] || EXAMPLES.target));
    return;
  }
  const allowed = [...spec.required, ...(spec.optional || [])];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      problems.push(problem(`${where}.${op}.${key}`, `unknown parameter ${JSON.stringify(key)}`, `Use only: ${allowed.join(', ')}.`, EXAMPLES[op] || EXAMPLES.target));
    }
  }
  for (const key of spec.required) {
    if (!(key in args)) problems.push(problem(`${where}.${op}.${key}`, 'required parameter is missing', `Add the required ${key} parameter.`, EXAMPLES[op] || EXAMPLES.target));
  }
  if (spec.url && 'url' in args && !isUrl(args.url)) {
    problems.push(problem(`${where}.${op}.url`, 'url must be an http(s) URL or a path beginning with /', 'Use a full http(s) URL or a path relative to baseUrl.', EXAMPLES[op]));
  }
  if (spec.target && 'target' in args) {
    const target = args.target;
    if (typeof target !== 'string' || !target.trim()) {
      problems.push(problem(`${where}.${op}.target`, 'target must be a non-empty CSS selector', 'Use a CSS selector.', EXAMPLES[op] || EXAMPLES.target));
    } else if (target.startsWith('role=')) {
      problems.push(problem(`${where}.${op}.target`, 'role= targets are not in this version; use a CSS selector.', 'Replace the role target with a CSS selector.', EXAMPLES[op] || EXAMPLES.target));
    }
  }
  for (const key of ['width', 'height']) {
    if (op === 'viewport' && key in args && (!isFiniteNumber(args[key]) || args[key] <= 0)) {
      problems.push(problem(`${where}.viewport.${key}`, `${key} must be a positive finite number`, `Set ${key} to a positive number.`, EXAMPLES.viewport));
    }
  }
  if (op === 'viewport' && 'dpr' in args && (!isFiniteNumber(args.dpr) || args.dpr <= 0)) {
    problems.push(problem(`${where}.viewport.dpr`, 'dpr must be a positive finite number', 'Set dpr to a number greater than 0, or omit it.', EXAMPLES.viewport));
  }
  if ('touch' in args && typeof args.touch !== 'boolean') {
    problems.push(problem(`${where}.viewport.touch`, 'touch must be a boolean', 'Set touch to true or false.', EXAMPLES.viewport));
  }
  if ('timeoutMs' in args && (!isFiniteNumber(args.timeoutMs) || args.timeoutMs < 0)) {
    problems.push(problem(`${where}.${op}.timeoutMs`, 'timeoutMs must be a non-negative finite number', 'Use 0 for a single sample or a positive timeout in milliseconds.', EXAMPLES.expect_visible));
  }
  if ('tolerance' in args && (!isFiniteNumber(args.tolerance) || args.tolerance < 0)) {
    problems.push(problem(`${where}.${op}.tolerance`, 'tolerance must be a non-negative finite number', 'Set tolerance to 0 or a positive number.', EXAMPLES.expect_widths));
  }
  if ('over' in args && (!isFiniteNumber(args.over) || args.over <= 0)) {
    problems.push(problem(`${where}.${op}.over`, 'over must be a positive finite duration in milliseconds', 'Set over to a positive duration.', EXAMPLES[op] || EXAMPLES.expect_css));
  }
  if (op === 'expect_widths' && 'equals' in args) {
    const value = args.equals;
    const valid = isFiniteNumber(value) || (Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber));
    if (!valid) problems.push(problem(`${where}.expect_widths.equals`, 'equals must be a finite number or a non-empty array of finite numbers', 'Use one number for every match or one number per match.', EXAMPLES.expect_widths));
  }
  if (op === 'expect_css' && 'property' in args && (typeof args.property !== 'string' || !args.property.trim())) {
    problems.push(problem(`${where}.expect_css.property`, 'property must be a non-empty string', 'Name a CSS property.', EXAMPLES.expect_css));
  }
  if (op === 'key') {
    const name = args.key;
    if (typeof name !== 'string' || !isKnownKey(name)) {
      const why = name === 'Exit'
        ? 'Exit is not available to an app: Samsung certification forbids exiting on it'
        : `${JSON.stringify(name)} is not a remote key in this version`;
      problems.push(problem(`${where}.key.key`, why, `Use one of: ${KEY_NAMES.join(', ')}.`, EXAMPLES.key));
    }
    if ('repeat' in args && (!Number.isInteger(args.repeat) || args.repeat < 1)) {
      problems.push(problem(`${where}.key.repeat`, 'repeat must be a positive integer', 'Send the key once per press: repeat the step instead.', EXAMPLES.key));
    }
    if ('gapMs' in args && (!isFiniteNumber(args.gapMs) || args.gapMs < 0)) {
      problems.push(problem(`${where}.key.gapMs`, 'gapMs must be a non-negative finite number', 'Set the gap between presses in milliseconds.', EXAMPLES.key));
    }
    if ('autoRepeat' in args && typeof args.autoRepeat !== 'boolean') {
      problems.push(problem(`${where}.key.autoRepeat`, 'autoRepeat must be a boolean', 'Set autoRepeat to true to mark the second and later downs as held repeats.', EXAMPLES.key));
    }
  }
  if (op === 'expect_within' && 'box' in args) {
    const box = args.box;
    const boxed = isRecord(box)
      && ['left', 'top', 'right', 'bottom'].every((key) => isFiniteNumber(box[key]))
      && box.right > box.left && box.bottom > box.top;
    if (box !== 'safe' && !boxed) {
      problems.push(problem(`${where}.expect_within.box`, 'box must be "safe" or an object with finite left, top, right, bottom', 'Use "safe" for the 5% title-safe area, or give the edges in CSS pixels.', EXAMPLES.expect_within));
    }
  }
  if ('holdMs' in args && (!isFiniteNumber(args.holdMs) || args.holdMs < 0)) {
    problems.push(problem(`${where}.${op}.holdMs`, 'holdMs must be a non-negative finite number', 'Use 0 to judge the first in-bounds sample only.', EXAMPLES.expect_within));
  }
  if (op === 'expect_prop' || op === 'expect_count') {
    const given = COMPARATORS.filter((key) => key in args);
    if (given.length !== 1) {
      problems.push(problem(`${where}.${op}`, 'exactly one of equals, gt, lt is required', 'Compare with equals, gt or lt.', EXAMPLES[op]));
    }
    for (const key of ['gt', 'lt']) {
      if (key in args && !isFiniteNumber(args[key])) {
        problems.push(problem(`${where}.${op}.${key}`, `${key} must be a finite number`, 'Give a number to compare against.', EXAMPLES[op]));
      }
    }
  }
  if ('mode' in args) {
    if (args.mode !== 'any' && args.mode !== 'all') {
      problems.push(problem(`${where}.${op}.mode`, 'mode must be any or all', 'Use "any" for one matching frame, "all" for every frame in the window.', EXAMPLES[op] || EXAMPLES.expect_css));
    }
    if (!('over' in args)) {
      problems.push(problem(`${where}.${op}.mode`, 'mode needs over: it decides how a frame window is judged', 'Add over: <ms> with mode.', EXAMPLES[op] || EXAMPLES.expect_css));
    }
  }
  if (op === 'expect_json') {
    if ('path' in args && typeof args.path !== 'string' && !Array.isArray(args.path)) {
      problems.push(problem(`${where}.expect_json.path`, 'path must be a string or an array of path segments', 'Use a JSON property path.', EXAMPLES.expect_json));
    }
  }
}

export function validate(doc, options = {}) {
  const problems = [];
  if (!isRecord(doc)) {
    return [problem('scenario', 'scenario must be an object', 'Add id and a non-empty steps list.', '{ id: "health-check", steps: [{ expect_json: { url: "/health", path: "ok", equals: true } }] }')];
  }
  for (const key of Object.keys(doc)) {
    if (!['id', 'backend', 'steps'].includes(key)) {
      problems.push(problem(key, `unknown top-level field ${JSON.stringify(key)}`, 'Remove this field; use only id, backend, and steps.', '{ id: "health-check", steps: [{ expect_json: { url: "/health", path: "ok", equals: true } }] }'));
    }
  }
  if (!('id' in doc)) {
    problems.push(problem('id', 'required top-level field is missing', 'Add a lowercase slug id.', 'id: health-check'));
  } else if (typeof doc.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.id)) {
    problems.push(problem('id', 'id must be a lowercase slug', 'Use lowercase letters, numbers, and single hyphens.', 'id: health-check'));
  }
  const backend = doc.backend ?? 'browser';
  if (!['browser', 'http', 'tv'].includes(backend)) {
    problems.push(problem('backend', 'backend must be browser, http or tv', 'Set backend to browser, http or tv.', 'backend: browser'));
  }
  if (!('steps' in doc)) {
    problems.push(problem('steps', 'required top-level field is missing', 'Add a non-empty list of steps.', 'steps: [{ open: { url: "/" } }]'));
  } else if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    problems.push(problem('steps', 'steps must be a non-empty list', 'Add at least one operation.', 'steps: [{ open: { url: "/" } }]'));
  } else {
    const { steps, problems: includeProblems } = spliceIncludes(doc, options);
    problems.push(...includeProblems);
    steps.forEach((step, index) => validateStep(step, index, backend, problems));
  }
  return problems;
}

function includeFormat(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  return null;
}

/**
 * Inline every `include` step once, relative to the including file. Nested includes and a file
 * that includes itself are reported rather than followed: a prefix with one home stays readable.
 */
function spliceIncludes(doc, { baseDir = null, file = null, _readFile = readFileSync } = {}) {
  const steps = [];
  const problems = [];
  if (!Array.isArray(doc?.steps)) return { steps, problems };
  const rootFile = file ? resolve(file) : null;

  doc.steps.forEach((step, index) => {
    if (!isRecord(step) || Object.keys(step)[0] !== 'include') {
      steps.push(step);
      return;
    }
    const where = `steps[${index}].include`;
    const name = step.include;
    if (typeof name !== 'string' || !name.trim()) {
      problems.push(problem(where, 'include must be a file path', 'Name a .yaml or .json journey file next to this one.', EXAMPLES.include));
      return;
    }
    if (!baseDir) {
      problems.push(problem(where, `cannot include ${name}: the scenario file's directory is unknown`, 'Validate or run the scenario from its own file so includes resolve next to it.', EXAMPLES.include));
      return;
    }
    const target = resolve(baseDir, name);
    if (rootFile && target === rootFile) {
      problems.push(problem(where, `include cycle: ${name} is this same file`, 'Remove the include that points back at the including journey.', EXAMPLES.include));
      return;
    }
    const format = includeFormat(target);
    if (!format) {
      problems.push(problem(where, `${name} must be a .yaml, .yml or .json journey file`, 'Keep included journeys in a format this parser reads.', EXAMPLES.include));
      return;
    }
    let text;
    try {
      text = _readFile(target, 'utf8');
    } catch (error) {
      const why = error?.code === 'ENOENT' ? 'no such file' : error.message;
      problems.push(problem(where, `include ${name} could not be read: ${why}`, 'Check the path is relative to the including file.', EXAMPLES.include));
      return;
    }
    let included;
    try {
      included = parseScenario(text, { format });
    } catch (error) {
      problems.push(problem(where, `include ${name} did not parse: ${error.message}`, 'Fix the included journey.', EXAMPLES.include));
      return;
    }
    const nested = Array.isArray(included?.steps) ? included.steps : [];
    const inner = nested.find((entry) => isRecord(entry) && Object.keys(entry)[0] === 'include');
    if (inner) {
      const innerName = inner.include;
      const innerTarget = typeof innerName === 'string' ? resolve(dirname(target), innerName) : null;
      const cyclic = Boolean(innerTarget) && (innerTarget === rootFile || innerTarget === target);
      problems.push(problem(where, cyclic
        ? `include cycle: ${name} includes ${innerName}, which leads back to it`
        : `second-level include: ${name} includes ${innerName}; an include may only be one level deep`,
      'Inline the nested file where it is included, or move the include to the top level.', EXAMPLES.include));
      return;
    }
    steps.push(...nested);
  });
  return { steps, problems };
}

/** The scenario with its includes spliced in place, plus whatever stopped a file being read. */
export function expandIncludes(doc, options = {}) {
  const { steps, problems } = spliceIncludes(doc, options);
  return { doc: problems.length ? doc : { ...doc, steps }, problems };
}

export function assertsNothing(doc) {
  const hasAssertion = Array.isArray(doc?.steps) && doc.steps.some((step) => {
    if (!isRecord(step)) return false;
    const op = Object.keys(step)[0];
    return Boolean(OPS[op]?.assertion);
  });
  return hasAssertion ? [] : ['no assertion step: a scenario that asserts nothing is not a scenario'];
}

export function parseScenario(text, { format } = {}) {
  if (typeof text !== 'string') throw new TypeError('scenario text must be a string');
  const kind = format?.toLowerCase();
  if (kind === 'json') return JSON.parse(text);
  if (kind === 'yaml' || kind === 'yml') return parseYaml(text);
  throw new TypeError('format must be yaml or json');
}
