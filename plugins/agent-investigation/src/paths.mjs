import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { platform } from "node:os";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Claude Code stores transcripts under ~/.claude/projects/<slug>/<session-id>/...
export function getClaudeProjectsDir() {
  return join(homedir(), ".claude", "projects");
}

// Claude Code's project-slug encoding: every non-alphanumeric char in the absolute
// cwd becomes '-' (e.g. C:\code\foo-bar → C--code-foo-bar).
export function getProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function getPaths() {
  const isWindows = platform() === "win32";
  const isMac = platform() === "darwin";

  let configDir, dataDir, stateDir, logDir;

  if (isWindows) {
    const appdata = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const localAppdata = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    configDir = join(appdata, "agent-investigation");
    dataDir = configDir;
    stateDir = join(localAppdata, "agent-investigation");
    logDir = join(localAppdata, "agent-investigation", "logs");
  } else if (isMac) {
    configDir = join(homedir(), "Library", "Application Support", "agent-investigation");
    dataDir = configDir;
    stateDir = configDir;
    logDir = join(homedir(), "Library", "Logs", "agent-investigation");
  } else {
    // Linux
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const xdgDataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const xdgStateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    configDir = join(xdgConfigHome, "agent-investigation");
    dataDir = join(xdgDataHome, "agent-investigation");
    stateDir = join(xdgStateHome, "agent-investigation");
    logDir = join(xdgStateHome, "agent-investigation", "logs");
  }

  return {
    pluginRoot,
    configDir,
    dataDir,
    stateDir,
    logDir,
  };
}

export default { getPaths };
