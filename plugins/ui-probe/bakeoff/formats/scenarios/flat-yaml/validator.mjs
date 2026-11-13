// Contender (ii): flat YAML/JSON step list. Validates by parsing to the shared IR.
import fs from 'node:fs';
import { parseYaml } from '../../lib/yaml.mjs';
import { irProblems, coverageProblems, assertsNothing } from '../../lib/validate-ir.mjs';
import { runIR } from '../../lib/runner.mjs';

export const format = 'flat-yaml';
export const extensions = ['.yaml', '.yml', '.json'];

export function parse(source, file) {
  if (file && /\.json$/i.test(file)) return JSON.parse(source);
  return parseYaml(source);
}

export function validate(source, task, file) {
  let ir;
  try {
    ir = parse(source, file);
  } catch (err) {
    return { errors: [`parse error: ${err.message}`], ir: null };
  }
  // Validity is the format contract (parses, vocabulary, at least one assertion).
  // Whether the scenario asserts the task's reference values is scored as
  // correctness, not validity — otherwise a wrong expected value reads as a syntax
  // error and the two measured quantities collapse into one.
  const errors = [...irProblems(ir, task), ...assertsNothing(ir)];
  return { errors, coverage: coverageProblems(ir, task), ir };
}


export async function run(source, task, file) {
  const { errors, ir } = validate(source, task, file);
  if (errors.length) return { passed: false, failure: { op: 'validate', error: errors.join('; ') }, steps: [], ms: 0 };
  return runIR(ir);
}

export function read(file) {
  return fs.readFileSync(file, 'utf8');
}
