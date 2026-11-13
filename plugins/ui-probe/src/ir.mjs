import { parseYaml } from './yaml.mjs';

export const OPS = {
  open: { required: ['url'], url: true },
  viewport: { required: ['width', 'height'], optional: ['touch'] },
  hover: { required: ['target'], target: true },
  tap: { required: ['target'], target: true },
  click: { required: ['target'], target: true },
  expect_visible: { required: ['target'], optional: ['timeoutMs'], target: true, assertion: true },
  expect_hidden: { required: ['target'], optional: ['timeoutMs'], target: true, assertion: true },
  expect_widths: { required: ['target', 'equals'], optional: ['tolerance', 'timeoutMs'], target: true, assertion: true },
  expect_css: { required: ['target', 'property', 'equals'], optional: ['tolerance', 'timeoutMs', 'over'], target: true, assertion: true },
  expect_text: { required: ['target', 'equals'], optional: ['timeoutMs'], target: true, assertion: true },
  expect_json: { required: ['url', 'path', 'equals'], url: true, assertion: true },
};

const EXAMPLES = {
  open: '{ open: { url: "/media/603" } }',
  viewport: '{ viewport: { width: 390, height: 844, touch: true } }',
  target: '{ click: { target: "[data-testid=save]" } }',
  expect_visible: '{ expect_visible: { target: ".dialog", timeoutMs: 5000 } }',
  expect_hidden: '{ expect_hidden: { target: ".dialog" } }',
  expect_widths: '{ expect_widths: { target: ".tile", equals: [111, 111, 111], tolerance: 1 } }',
  expect_css: '{ expect_css: { target: ".tile", property: "display", equals: "flex", over: 400 } }',
  expect_text: '{ expect_text: { target: "h1", equals: "Welcome" } }',
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
      const plan = op === 'tcp_banner' ? 'ui-probe-4-protocols' : 'ui-probe-3-windows';
      problems.push(problem(`${where}.${op}`, `${op} is not in this version; it belongs to the later ${plan} plan.`, 'Use a supported operation in this phase.', EXAMPLES.expect_json));
    } else {
      problems.push(problem(`${where}.${op}`, `unknown op ${JSON.stringify(op)}`, `Choose one of: ${Object.keys(OPS).join(', ')}.`, EXAMPLES.expect_visible));
    }
    return;
  }
  if (backend === 'http' && op !== 'expect_json') {
    problems.push(problem(`${where}.${op}`, 'http scenarios support only expect_json', 'Use expect_json or set backend to browser.', EXAMPLES.expect_json));
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
    problems.push(problem(`${where}.expect_css.over`, 'over must be a positive finite duration in milliseconds', 'Set over to a positive duration.', EXAMPLES.expect_css));
  }
  if (op === 'expect_widths' && 'equals' in args) {
    const value = args.equals;
    const valid = isFiniteNumber(value) || (Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber));
    if (!valid) problems.push(problem(`${where}.expect_widths.equals`, 'equals must be a finite number or a non-empty array of finite numbers', 'Use one number for every match or one number per match.', EXAMPLES.expect_widths));
  }
  if (op === 'expect_css' && 'property' in args && (typeof args.property !== 'string' || !args.property.trim())) {
    problems.push(problem(`${where}.expect_css.property`, 'property must be a non-empty string', 'Name a CSS property.', EXAMPLES.expect_css));
  }
  if (op === 'expect_json') {
    if ('path' in args && typeof args.path !== 'string' && !Array.isArray(args.path)) {
      problems.push(problem(`${where}.expect_json.path`, 'path must be a string or an array of path segments', 'Use a JSON property path.', EXAMPLES.expect_json));
    }
  }
}

export function validate(doc) {
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
  if (!['browser', 'http'].includes(backend)) {
    problems.push(problem('backend', 'backend must be browser or http', 'Set backend to browser or http.', 'backend: browser'));
  }
  if (!('steps' in doc)) {
    problems.push(problem('steps', 'required top-level field is missing', 'Add a non-empty list of steps.', 'steps: [{ open: { url: "/" } }]'));
  } else if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    problems.push(problem('steps', 'steps must be a non-empty list', 'Add at least one operation.', 'steps: [{ open: { url: "/" } }]'));
  } else {
    doc.steps.forEach((step, index) => validateStep(step, index, backend, problems));
  }
  return problems;
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
