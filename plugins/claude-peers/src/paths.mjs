import { homedir } from "node:os";
import { join } from "node:path";

export function getPaths() {
  const home = homedir();
  const appName = "claude-peers";

  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      const base = join(appData, appName);
      return {
        configDir: base,
        dataDir: base,
        logDir: join(localAppData, appName, "logs"),
        stateDir: join(localAppData, appName),
      };
    }
    case "darwin": {
      const lib = join(home, "Library");
      const base = join(lib, "Application Support", appName);
      return {
        configDir: base,
        dataDir: base,
        logDir: join(lib, "Logs", appName),
        stateDir: base,
      };
    }
    default: {
      // Linux + other POSIX
      const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
      const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
      const xdgState = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
      return {
        configDir: join(xdgConfig, appName),
        dataDir: join(xdgData, appName),
        logDir: join(xdgState, appName, "logs"),
        stateDir: join(xdgState, appName),
      };
    }
  }
}
