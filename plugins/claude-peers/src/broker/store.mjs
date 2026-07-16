import fs from "node:fs";
import path from "node:path";

export function emptyState() {
  return { peers: {}, messages: [] };
}

export function loadState(file, { _fs = fs } = {}) {
  let raw;
  try {
    raw = _fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return emptyState();
    throw e;
  }
  const state = JSON.parse(raw);
  if (!state || !state.peers || typeof state.peers !== "object" || Array.isArray(state.peers) || !Array.isArray(state.messages)) {
    throw new Error(`unexpected state shape in ${file}`);
  }
  return state;
}

export function saveState(file, state, { _fs = fs } = {}) {
  _fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  _fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  _fs.renameSync(tmp, file);
}
