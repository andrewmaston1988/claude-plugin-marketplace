import { homedir } from "node:os";
import { join } from "node:path";

export function getPaths() {
  const base = join(homedir(), ".pipeline");
  return {
    configDir: base,
    dataDir: base,
    stateDir: base,
    logDir: join(base, "logs"),
  };
}
