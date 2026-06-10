// Locate claude-slack: env > marketplace cache > PATH. Returns { path, source }.
import { existsSync as _realExistsSync, readdirSync as _realReaddirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function findClaudeSlackPlugin({
  _env = process.env,
  _existsSync = _realExistsSync,
  _readdirSync = _realReaddirSync,
} = {}) {
  if (_env.CLAUDE_SLACK_PLUGIN && _existsSync(_env.CLAUDE_SLACK_PLUGIN)) {
    return { path: _env.CLAUDE_SLACK_PLUGIN, source: "env" };
  }

  const home = _env.USERPROFILE || _env.HOME || homedir();
  const cache = join(home, ".claude", "plugins", "cache");
  if (_existsSync(cache)) {
    try {
      for (const owner of _readdirSync(cache)) {
        const sb = join(cache, owner, "slack-bridge");
        if (!_existsSync(sb)) continue;
        for (const ver of _readdirSync(sb)) {
          const exe = join(sb, ver, "bin", "claude-slack.mjs");
          if (_existsSync(exe)) return { path: exe, source: "cache" };
        }
      }
    } catch { /* unreadable cache */ }
  }

  // Split on both ; and : — Windows CMD vs mingw bash on Windows.
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
