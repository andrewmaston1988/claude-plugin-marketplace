import { resolve } from "node:path";
import {
  connectUnified, close,
  projectAdd, projectList, projectRemove, projectSetEnabled, projectUpdate,
} from "../../scripts/pipeline-db/index.mjs";
import { updatePipelineConfig } from "../pipeline-config.mjs";
import { getFlag } from "./helpers.mjs";

// Write a per-project plansDir override to cfg.plansDirs[<name>] in config.json.
// Pass null/undefined to remove the entry.
function _setPlansDirOverride(name, plansDir) {
  updatePipelineConfig(cfg => {
    if (plansDir) {
      cfg.plansDirs = cfg.plansDirs ?? {};
      cfg.plansDirs[name] = plansDir;
    } else if (cfg.plansDirs) {
      delete cfg.plansDirs[name];
      if (Object.keys(cfg.plansDirs).length === 0) delete cfg.plansDirs;
    }
  });
}

export async function run(cmd, argv) {

  // ── project-add ──────────────────────────────────────────────────────────────
  if (cmd === "project-add") {
    const [name, rootPathArg] = argv;
    if (!name || !rootPathArg) {
      process.stderr.write("usage: project-add <name> <absolute-root-path> [--plans-dir <path>]\n");
      return 1;
    }
    const rootPath = resolve(rootPathArg);
    const plansDir = getFlag("--plans-dir", argv);
    const db = connectUnified();
    try {
      // DB row stores name/root_path/enabled only; per-project plansDir overrides
      // live in config.json under cfg.plansDirs[<name>] so they are declarative
      // and diffable alongside the rest of the config.
      const row = projectAdd(db, { name, rootPath });
      if (plansDir) _setPlansDirOverride(name, plansDir);
      process.stdout.write(`OK: registered '${row.name}' -> ${row.root_path}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    } finally { close(db); }
  }

  // ── project-list ─────────────────────────────────────────────────────────────
  if (cmd === "project-list") {
    const fmt = getFlag("--format", argv) || "plain";
    const db = connectUnified();
    try {
      const rows = projectList(db);
      if (fmt === "json") {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } else {
        if (!rows.length) {
          process.stdout.write("(no projects registered)\n");
        } else {
          for (const r of rows) {
            const status = r.enabled ? "enabled" : "disabled";
            process.stdout.write(`${r.name}\t${status}\t${r.root_path}\n`);
          }
        }
      }
      return 0;
    } finally { close(db); }
  }

  // ── project-remove ───────────────────────────────────────────────────────────
  if (cmd === "project-remove") {
    const [name] = argv;
    if (!name) {
      process.stderr.write("usage: project-remove <name> [--purge]\n");
      return 1;
    }
    const purge = argv.includes("--purge");
    const db = connectUnified();
    try {
      const ok = projectRemove(db, name, { purge });
      if (!ok) {
        process.stderr.write(`not found: project '${name}'\n`);
        return 1;
      }
      process.stdout.write(purge ? `OK: removed '${name}' (purged)\n` : `OK: removed '${name}'\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    } finally { close(db); }
  }

  // ── project-enable ───────────────────────────────────────────────────────────
  if (cmd === "project-enable") {
    const [name] = argv;
    if (!name) { process.stderr.write("usage: project-enable <name>\n"); return 1; }
    const db = connectUnified();
    try {
      const ok = projectSetEnabled(db, name, 1);
      if (!ok) { process.stderr.write(`not found: project '${name}'\n`); return 1; }
      process.stdout.write(`OK: enabled '${name}'\n`);
      return 0;
    } finally { close(db); }
  }

  // ── project-disable ──────────────────────────────────────────────────────────
  if (cmd === "project-disable") {
    const [name] = argv;
    if (!name) { process.stderr.write("usage: project-disable <name>\n"); return 1; }
    const db = connectUnified();
    try {
      const ok = projectSetEnabled(db, name, 0);
      if (!ok) { process.stderr.write(`not found: project '${name}'\n`); return 1; }
      process.stdout.write(`OK: disabled '${name}'\n`);
      return 0;
    } finally { close(db); }
  }

  // ── project-update ───────────────────────────────────────────────────────────
  if (cmd === "project-update") {
    const [name] = argv;
    if (!name) {
      process.stderr.write("usage: project-update <name> [--plans-dir <path>] [--clear-plans-dir]\n");
      return 1;
    }
    const plansDir = getFlag("--plans-dir", argv);
    const clearPlansDir = argv.includes("--clear-plans-dir");
    if (!plansDir && !clearPlansDir) {
      process.stderr.write("error: at least one of --plans-dir <path> or --clear-plans-dir must be provided\n");
      return 1;
    }
    const db = connectUnified();
    try {
      // Confirm the project exists; also clear the legacy DB column so the
      // new cfg.plansDirs entry is the only source for this project.
      const row = projectUpdate(db, name, { plansDir: null });
      if (!row) {
        process.stderr.write(`not found: project '${name}'\n`);
        return 1;
      }
      _setPlansDirOverride(name, clearPlansDir ? null : plansDir);
      process.stdout.write(`OK: updated '${row.name}'\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    } finally { close(db); }
  }

  return null;
}
