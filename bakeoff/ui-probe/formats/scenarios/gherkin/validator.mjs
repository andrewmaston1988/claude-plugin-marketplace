// Contender (iii): Gherkin + step bindings. The feature is prose; the bindings are
// code. Validation compiles the feature to the shared IR and checks that too.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFeature, compile } from '../../lib/gherkin.mjs';
import { steps as defaultSteps } from './steps/default-steps.mjs';
import { irProblems, coverageProblems, assertsNothing } from '../../lib/validate-ir.mjs';
import { runIR } from '../../lib/runner.mjs';

export const format = 'gherkin';
export const extensions = ['.feature'];

// An author may ship `<name>.steps.mjs` beside the feature; those win over the library.
async function bindingsFor(file) {
  const sibling = file ? file.replace(/\.feature$/i, '.steps.mjs') : null;
  if (sibling && fs.existsSync(sibling)) {
    const mod = await import(pathToFileURL(path.resolve(sibling)).href);
    if (!Array.isArray(mod.steps)) throw new Error(`${path.basename(sibling)} must export a "steps" array`);
    return [...mod.steps, ...defaultSteps];
  }
  return defaultSteps;
}

export async function compileSource(source, file) {
  const doc = parseFeature(source);
  let bindings;
  try {
    bindings = await bindingsFor(file);
  } catch (err) {
    return { ir: null, errors: [...doc.errors, `bindings: ${err.message}`], doc };
  }
  const { steps, errors } = compile(doc, bindings);
  const ir = { id: null, task: null, backend: null, steps };
  return { ir, errors, doc };
}

export async function validate(source, task, file) {
  const { ir, errors, doc } = await compileSource(source, file);
  if (!ir) return { errors, ir: null };
  const merged = { ...ir, id: doc.feature, task: task.id, backend: task.backend };
  const problems = [...errors, ...irProblems(merged, task), ...assertsNothing(merged)];
  return { errors: problems, coverage: coverageProblems(merged, task), ir: merged };
}

export async function run(source, task, file) {
  const { errors, ir } = await validate(source, task, file);
  if (errors.length) return { passed: false, failure: { op: 'validate', error: errors.join('; ') }, steps: [], ms: 0 };
  return runIR(ir);
}
