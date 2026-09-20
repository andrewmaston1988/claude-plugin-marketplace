import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelDescriptor } from "./contracts.mjs";

function catalogHome(input) {
  const env = input?.env && typeof input.env === "object" ? input.env : input;
  return env?.HOME || env?.USERPROFILE || homedir();
}

function catalogRows(catalog) {
  const models = catalog?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  return models;
}

function readCatalogFile(path) {
  try {
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    const rows = catalogRows(catalog);
    const fetchedAt = Number(catalog?.fetchedAt);
    if (!rows || !Number.isFinite(fetchedAt)) return null;
    return { catalog, fetchedAt };
  } catch {
    return null;
  }
}

export function readClaudeCatalog(env = process.env) {
  const directory = join(catalogHome(env), ".claude", "cache", "model-catalog");
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith("-cc.json"));
  } catch {
    return [];
  }
  if (!files.length) return [];

  const catalogs = files
    .map((entry) => readCatalogFile(join(directory, entry.name)))
    .filter(Boolean)
    .sort((a, b) => b.fetchedAt - a.fetchedAt);
  const models = catalogRows(catalogs[0]?.catalog);
  if (!models) return [];

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
