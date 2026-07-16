import fs from "node:fs";
import path from "node:path";
import { getPaths } from "./paths.mjs";

export const DEFAULTS = {
  port: 7899,
  pollIntervalMs: 1000,
  heartbeatIntervalMs: 15000,
};

export function loadConfig({ _env = process.env, paths = getPaths() } = {}) {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(path.join(paths.configDir, "config.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const cfg = { ...DEFAULTS, ...fromFile };
  if (_env.CLAUDE_PEERS_PORT) cfg.port = parseInt(_env.CLAUDE_PEERS_PORT, 10);
  return cfg;
}
