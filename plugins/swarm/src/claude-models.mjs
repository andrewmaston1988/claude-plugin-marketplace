import { catalogModels, selectClaudeCatalog } from "./claude-catalog.mjs";
import { modelDescriptor } from "./contracts.mjs";

// That selection's identity, for a reader that must tell one catalog from the
// next without re-reading the rows it already banked.
export function claudeCatalogIdentity(env = process.env) {
  const selected = selectClaudeCatalog(env);
  return selected ? `${selected.file}@${selected.fetchedAt}` : null;
}

export function readClaudeCatalog(env = process.env) {
  const models = catalogModels(env);
  if (!models.length) return [];

  try {
    return models.flatMap((model) => {
      if (typeof model?.id !== "string" || !model.id.trim() || typeof model?.name !== "string") return [];
      const options = Array.isArray(model.thinking?.effort_options)
        ? model.thinking.effort_options.filter((option) => typeof option?.id === "string" && option.id.trim())
        : [];
      const efforts = options.map((option) => option.id);
      const defaultEffort = options.find((option) => option.badge?.message === "Default")?.id;
      return [modelDescriptor({
        provider: "claude",
        runner: "claude",
        model: model.id,
        displayName: model.name,
        ...(efforts.length ? { efforts } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
      })];
    });
  } catch {
    return [];
  }
}
