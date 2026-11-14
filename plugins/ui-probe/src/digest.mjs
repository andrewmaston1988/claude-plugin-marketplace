// The one form of a step's digest line, shared by a run's digest and a capture's failing step.

export function digestLine(step) {
  const parts = [step.outcome.toUpperCase(), step.source, step.op];
  if (step.target) parts.push(step.target);
  if ("measured" in step) parts.push(`measured=${JSON.stringify(step.measured)}`);
  if ("expected" in step) parts.push(`expected=${JSON.stringify(step.expected)}`);
  return parts.join(" ");
}
