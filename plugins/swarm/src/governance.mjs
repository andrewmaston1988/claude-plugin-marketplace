import { allowedRootsFor } from "./providers.mjs";
import { isUnderRoot } from "./roots.mjs";
// Cyclic on purpose: ValidationError is manifest.mjs's, and it is only ever
// referenced inside checkRunRoots' body — never at module-evaluation time.
import { ValidationError } from "./manifest.mjs";

// An empty roots list denies every cwd, so a provider that has never been given one is
// UNCONFIGURED, not mis-located — naming the empty list it failed against teaches nothing.
// The shipped config.default.json is exactly this case, so the first thing a new install
// sees must be the way out of it rather than a bare denial.
function unconfigured(provider, rootLabel) {
  return `provider '${provider}' has no ${rootLabel} configured, and swarm runs nothing outside its ` +
    `configured roots — so every task is refused. Run /swarm:swarm setup to choose the directory roots ` +
    `swarm may work in, or add ${rootLabel} to ~/.swarm/config.json by hand.`;
}
// Every provider, Claude included — operator, 2026-09-21: allowedRoots is the single
// statement of where swarm may run anything. The old `claude` early return made the roots
// list a non-Anthropic policy, which left the Claude leaves that do the writing ungated.
export function checkGovernance(provider, model, effCwd, l, cfg, errors) {
  // The top-level list is the default; a provider entry narrows it and can never widen it.
  // `roots === undefined` is a provider nobody ever configured — a different refusal from
  // the explicit [] that denies on purpose, and the label names whichever key binds.
  const { roots, deniedBy } = allowedRootsFor(cfg, provider);
  if (roots === undefined) {
    errors.push(`${l}: ${unconfigured(provider, deniedBy)}`);
    return;
  }
  if (!roots.some((root) => isUnderRoot(effCwd, root))) {
    errors.push(
      `${l}: provider '${provider}' model '${model}' and its cwd '${effCwd}' is not under any ` +
      `${deniedBy} entry — ${provider === "claude"
        ? `swarm runs nothing outside its configured roots`
        : `blocked by data governance policy (only Anthropic is covered by the data agreement)`}. ` +
      `Configure ${deniedBy} in ~/.swarm/config.json to permit this provider there.`
    );
  }
}

export function checkRunRoots(gateIds, cfg, toplevel, errors) {
  // Resolved per seated provider, so a top-level list bounds the run too. The label comes
  // from the provider that actually binds: naming providers.<id>.allowedRoots when the
  // top-level key is the constraint sends the operator to a key with no effect.
  const gate = gateIds.map((id) => ({ id, ...allowedRootsFor(cfg, id) }));
  const gateRoots = [...new Set(gate.flatMap((g) => g.roots || []))];
  if (gateRoots.length && !gateRoots.some((root) => isUnderRoot(toplevel, root))) {
    const labels = [...new Set(gate.map((g) => g.deniedBy))].join(" / ");
    errors.push(
      `swarm: this run's repo '${toplevel}' is not under any allowedRoots entry for the providers it seats ` +
      `(${gateIds.join(", ")}) — dispatch from a repo under ${gateRoots.join(", ")}, or add its root to ` +
      `${labels} in ~/.swarm/config.json`
    );
    throw new ValidationError(errors);
  }
}
