import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
