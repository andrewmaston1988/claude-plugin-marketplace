import { homedir } from "node:os";
import { join } from "node:path";

function _xdg(envName, fallback) {
  return process.env[envName] || fallback;
}

export function getPaths() {
  if (process.platform === "linux") {
    const home = process.env.HOME || homedir();
    const cfgBase   = _xdg("XDG_CONFIG_HOME", join(home, ".config"));
    const dataBase  = _xdg("XDG_DATA_HOME",   join(home, ".local", "share"));
    const stateBase = _xdg("XDG_STATE_HOME",  join(home, ".local", "state"));
    return {
      configDir: join(cfgBase,   "pipeline"),
      dataDir:   join(dataBase,  "pipeline"),
      stateDir:  join(stateBase, "pipeline"),
      logDir:    join(stateBase, "pipeline", "logs"),
    };
  }
  const base = join(homedir(), ".pipeline");
  return {
    configDir: base,
    dataDir: base,
    stateDir: base,
    logDir: join(base, "logs"),
  };
}
