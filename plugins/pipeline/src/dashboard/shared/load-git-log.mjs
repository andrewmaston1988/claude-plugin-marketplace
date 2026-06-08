// Read recent git log entries from `projectRoot`. Returns [{hash, msg, when}].
// 8-char hash, message, relative date — the three columns shown by the git-log panel.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function loadGitLog(projectRoot, { limit = 10 } = {}) {
  if (!projectRoot || !existsSync(join(projectRoot, ".git"))) return [];
  try {
    const out = execFileSync(
      "git",
      ["log", `-${limit}`, "--no-merges", "--pretty=format:%h%x09%s%x09%cr"],
      { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").filter(Boolean).map(line => {
      const [hash, msg, when] = line.split("\t");
      return { hash, msg, when };
    });
  } catch { return []; }
}
