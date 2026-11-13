// Gherkin subset used by the bake-off: Feature / Scenario / Given-When-Then-And-But.
// Steps compile through bindings to the shared IR. No Background, examples tables
// or tags — a format that needs them can add them; the scored five tasks do not.

const STEP = /^(Given|When|Then|And|But)\s+(.+)$/;
const KEYWORDS = ['Feature:', 'Scenario:', 'Background:', 'Scenario Outline:', 'Examples:'];

export function parseFeature(source) {
  const doc = { feature: null, scenarios: [], errors: [] };
  let scenario = null;
  source.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    const where = `line ${n + 1}`;
    if (!line || line.startsWith('#') || line.startsWith('@')) return;
    if (line.startsWith('Feature:')) {
      doc.feature = line.slice('Feature:'.length).trim();
      if (!doc.feature) doc.errors.push(`${where}: Feature has no name`);
      return;
    }
    if (line.startsWith('Scenario:') || line.startsWith('Scenario Outline:')) {
      const name = line.slice(line.indexOf(':') + 1).trim();
      if (!name) doc.errors.push(`${where}: Scenario has no name`);
      scenario = { name, line: n + 1, steps: [] };
      doc.scenarios.push(scenario);
      return;
    }
    const other = KEYWORDS.find((k) => k !== 'Feature:' && k !== 'Scenario:' && k !== 'Scenario Outline:' && line.startsWith(k));
    if (other) {
      doc.errors.push(`${where}: ${other} is not supported by this runner`);
      return;
    }
    const m = STEP.exec(line);
    if (m) {
      if (!scenario) {
        doc.errors.push(`${where}: step outside a Scenario`);
        return;
      }
      scenario.steps.push({ keyword: m[1], text: m[2].trim(), line: n + 1 });
      return;
    }
    doc.errors.push(`${where}: not a Feature/Scenario/step line: ${JSON.stringify(line)}`);
  });
  if (!doc.feature) doc.errors.push('missing "Feature:" line');
  if (doc.scenarios.length === 0) doc.errors.push('no Scenario found');
  for (const s of doc.scenarios) if (s.steps.length === 0) doc.errors.push(`scenario ${JSON.stringify(s.name)} has no steps`);
  return doc;
}

// Compiles every step through the bindings. Author bindings are tried first so a
// feature can override the shipped library.
export function compile(doc, bindings) {
  const errors = [...doc.errors];
  const steps = [];
  for (const scenario of doc.scenarios) {
    for (const step of scenario.steps) {
      const binding = bindings.find((b) => b.pattern.test(step.text));
      if (!binding) {
        errors.push(`line ${step.line}: no binding for step ${JSON.stringify(step.text)}`);
        continue;
      }
      try {
        const irStep = binding.build(binding.pattern.exec(step.text));
        steps.push(irStep);
      } catch (err) {
        errors.push(`line ${step.line}: binding failed for ${JSON.stringify(step.text)}: ${err.message}`);
      }
    }
  }
  return { steps, errors };
}
