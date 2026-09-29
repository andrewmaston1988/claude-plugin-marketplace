// Which rows a lineage collapse hides: the supersession reading, the elders
// still waiting on a graded successor, and the tables that drop them.
import { collapseFamilies, visibleModels } from "./discovery.mjs";

// The key a supersession reading is looked up by. Provider-qualified at this one
// site: two providers that share a model name must never chain into each other's
// family, and every caller of the map below has to agree on the tuple shape.
export const supersessionKey = (provider, model) => JSON.stringify([provider, model]);

// Which rows a collapse hides, as provider+model -> the model that supersedes it,
// beside the elders it would have hidden but for `ready`. `collapseFamilies` marks
// chains; `visibleModels` decides which of a chain are actually shown, and only the
// hidden members land in `superseded`. A graded view passes a `ready(provider,
// model)` predicate — an elder whose successor has not earned a grade yet is not
// hidden by it, it is *pending* it, and says so.
export function supersessionReading(rows, { providerKey = () => "unqualified", isDenylisted = () => false, cloudSuffix = ":cloud", ready = () => true } = {}) {
  const familyNames = new Map();
  for (const row of rows) {
    const provider = providerKey(row);
    const names = familyNames.get(provider) || new Set();
    names.add(row.model);
    familyNames.set(provider, names);
  }
  const superseded = new Map();
  const pending = new Map();
  for (const [provider, names] of familyNames) {
    const suffix = provider === "ollama" ? cloudSuffix : "";
    const families = collapseFamilies([...names].map((model) => ({ model })), suffix);
    const visible = new Set(visibleModels(families, { isDenylisted }).map((row) => row.model));
    for (const row of families) {
      if (!row.supersededBy || visible.has(row.model)) continue;
      const key = supersessionKey(provider, row.model);
      // `ready` is asked per provider+model so another provider's grades for a
      // shared name cannot retire this family's elder.
      if (ready(provider, row.supersededBy)) superseded.set(key, row.supersededBy);
      else pending.set(key, row.supersededBy);
    }
  }
  return { superseded, pending };
}

// The hidden rows alone, for the callers that only drop them.
export function supersededByMap(rows, options) {
  return supersessionReading(rows, options).superseded;
}

// The same reading applied to a table: superseded rows leave, unless `keep` says
// otherwise — a card's base model is the unit every other row is a multiple of,
// so it is never the row that goes.
export function dropSuperseded(rows, { providerKey = () => "unqualified", keep = () => false, cloudSuffix = ":cloud", isDenylisted = () => false } = {}) {
  const superseded = supersededByMap(rows, { providerKey, cloudSuffix, isDenylisted });
  return rows.filter((row) => keep(row) || !superseded.has(supersessionKey(providerKey(row), row.model)));
}
