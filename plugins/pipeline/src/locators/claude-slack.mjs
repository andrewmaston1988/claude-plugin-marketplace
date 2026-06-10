// Locate the claude-slack notifier binary. Extracted from wizard.mjs and
// doctor.mjs which had drifting near-duplicate copies of this resolution
// chain.
//
// Resolution order:
//   1. process.env.CLAUDE_SLACK_PLUGIN — absolute path, verbatim if it exists.
//   2. ~/.claude/plugins/cache/<owner>/slack-bridge/<ver>/bin/claude-slack.mjs
//      (the marketplace install layout — robust to PowerShell where the
//      `claude-slack` shell function is invisible from a non-PowerShell shell).
//   3. PATH walk with platform-appropriate extensions. Splits on both `;` and
//      `:` to survive both Windows CMD and mingw bash on Windows.
//   4. null.
//
// Returns { path, source } where source ∈ {"env","cache","path",null}.
// `_env` and `_existsSync` are injection seams for tests.
import { existsSync as _realExistsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findClaudeSlackPlugin({ _env = process.env, _existsSync = _realExistsSync } = {}) {
  // 1) env override
  if (_env.CLAUDE_SLACK_PLUGIN && _existsSync(_env.CLAUDE_SLACK_PLUGIN)) {
    return { path: _env.CLAUDE_SLACK_PLUGIN, source: "env" };
  }

  // 2) plugins/cache walk
  const home = _env.USERPROFILE || _env.HOME || homedir();
  const cache = join(home, ".claude", "plugins", "cache");
  if (_existsSync(cache)) {
    try {
      for (const owner of readdirSync(cache)) {
        const sb = join(cache, owner, "slack-bridge");
        if (!_existsSync(sb)) continue;
        for (const ver of readdirSync(sb)) {
          const exe = join(sb, ver, "bin", "claude-slack.mjs");
          if (_existsSync(exe)) return { path: exe, source: "cache" };
        }
      }
    } catch { /* tolerate unreadable cache */ }
  }

  // 3) PATH walk
  const dirs = (_env.PATH || "").split(/[;:]/);
  const exts = process.platform === "win32"
    ? [".exe", ".cmd", ".bat", ".mjs", ".js", ""]
    : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const full = join(d, "claude-slack" + ext);
      if (_existsSync(full)) return { path: full, source: "path" };
    }
  }

  return { path: null, source: null };
}
