import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function createSessionStore({ path, log }) {
  let cache = null;

  function load() {
    if (cache !== null) return cache;
    if (!existsSync(path)) { cache = {}; return cache; }
    try {
      cache = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      log?.warn("session store corrupt, starting fresh", { path, error: e.message });
      cache = {};
    }
    return cache;
  }

  function persist(data) {
    const tmp = path + ".tmp";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, path);
  }

  return {
    get(key) {
      return load()[key];
    },

    set(key, value) {
      const data = load();
      data[key] = value;
      persist(data);
    },

    delete(key) {
      const data = load();
      delete data[key];
      persist(data);
    },

    all() {
      return { ...load() };
    },

    importAll(entries) {
      const data = load();
      for (const [k, v] of Object.entries(entries)) {
        data[k] = v;
      }
      persist(data);
    },
  };
}
