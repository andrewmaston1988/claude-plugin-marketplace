import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { PIPELINE_DEFAULTS } from "./config-defaults.mjs";

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override ?? {})) {
    out[k] = v !== null && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object"
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

// Read ~/.pipeline/config.json and deep-merge with PIPELINE_DEFAULTS.
// Always returns a complete config object; missing keys fall back to defaults.
export function loadPipelineConfig(configPath = join(homedir(), ".pipeline", "config.json")) {
  if (!existsSync(configPath)) return deepMerge({}, PIPELINE_DEFAULTS);
  try {
    return deepMerge(PIPELINE_DEFAULTS, JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return deepMerge({}, PIPELINE_DEFAULTS);
  }
}

// Read the on-disk config, apply `mutator(cfg)`, and write the result back
// atomically (.tmp -> rename, mode 0o600). Returns the mutated config.
// Reads the raw on-disk JSON (not the defaults-merged copy) so the write does
// not balloon the file with every default key.
export function updatePipelineConfig(mutator, configPath = join(homedir(), ".pipeline", "config.json")) {
  let raw = {};
  if (existsSync(configPath)) {
    try { raw = JSON.parse(readFileSync(configPath, "utf8")); } catch { raw = {}; }
  }
  mutator(raw);
  mkdirSync(dirname(configPath), { recursive: true });
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmpPath, configPath);
  return raw;
}
