// Claude Code's cached model catalog: the window data it ships per model.
// Duplicated byte-for-byte into each plugin that needs it, because an install
// copies only a plugin's own directory.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function catalogHome(input) {
  const env = input?.env && typeof input.env === "object" ? input.env : input;
  return env?.HOME || env?.USERPROFILE || homedir();
}

function readCatalogFile(path) {
  try {
    const file = JSON.parse(readFileSync(path, "utf8"));
    const catalog = file?.catalog;
    const fetchedAt = Number(file?.fetchedAt);
    if (!Array.isArray(catalog?.config?.models) || !Number.isFinite(fetchedAt)) return null;
    return { catalog, fetchedAt };
  } catch {
    return null;
  }
}

// The catalog the reader serves: the highest embedded `fetchedAt` on disk. Never
// the newest mtime — catalog files accumulate and the two disagree, so mtime would
// pick a file whose contents are older than the one it replaced.
export function selectClaudeCatalog(env = process.env) {
  const directory = join(catalogHome(env), ".claude", "cache", "model-catalog");
  let files;
  try {
    files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith("-cc.json"));
  } catch {
    return null;
  }
  if (!files.length) return null;
  return files
    .map((entry) => {
      const parsed = readCatalogFile(join(directory, entry.name));
      return parsed && { ...parsed, file: entry.name };
    })
    .filter(Boolean)
    .sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
}

// The selected catalog's model rows, or none when there is no usable catalog.
export function catalogModels(env = process.env) {
  const models = selectClaudeCatalog(env)?.catalog?.config?.models;
  return Array.isArray(models) ? models : [];
}

export const stripModelSuffix = (model) => model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");

// The row's declared input window, or null when the catalog cannot answer:
// exact id, then the id without `[1m]`/date, then the longest id the model
// contains — so a wrapped Bedrock id still matches.
export function maxInputTokens(rows, model) {
  if (!Array.isArray(rows) || typeof model !== "string" || !model) return null;
  const ids = rows.filter((row) => typeof row?.id === "string" && row.id);
  const wanted = stripModelSuffix(model);
  const match = ids.find((row) => row.id === model)
    ?? ids.find((row) => stripModelSuffix(row.id) === wanted)
    ?? ids.filter((row) => model.includes(row.id)).sort((a, b) => b.id.length - a.id.length)[0];
  const tokens = Number(match?.runtime?.max_input_tokens);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}
