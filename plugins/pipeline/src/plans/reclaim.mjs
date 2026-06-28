import { existsSync, renameSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// If planPath is absent but complete/<basename> exists, move it back.
// Intentional mid-cycle plan retirement requires `pipeline row-delete` first.
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
