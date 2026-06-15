import { existsSync, renameSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/**
 * If planPath is missing but the same basename exists under the sibling
 * `complete/` directory, move it back and return { moved: true, from }.
 * Returns { moved: false } when the file is already at planPath (no-op) or
 * genuinely absent from both locations.
 *
 * Note: if a plan was intentionally retired mid-cycle, the developer should
 * have run `pipeline row-delete` first — with no row, dev-complete never fires
 * and this helper is never invoked.
 *
 * @param {string} planPath - absolute path where the plan file should reside
 * @param {{ fsImpl?: object }} [opts]
 */
export function reclaimPlanIfMisplaced(planPath, { fsImpl = null } = {}) {
  const { existsSync: exists, renameSync: rename, realpathSync: realpath } =
    fsImpl || { existsSync, renameSync, realpathSync };

  if (exists(planPath)) return { moved: false };

  let planDir;
  try {
    // Resolve the plans directory through any symlinks (the marketplace plans/
    // dir is a symlink to the CLAUDE repo's plans/).
    planDir = realpath(dirname(planPath));
  } catch {
    return { moved: false };
  }

  const from = join(planDir, "complete", basename(planPath));
  if (!exists(from)) return { moved: false };

  rename(from, join(planDir, basename(planPath)));
  return { moved: true, from };
}
