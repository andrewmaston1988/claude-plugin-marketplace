// Single home for the waiter's timing and its command string. slack_seize's
// returned command, the `wait` CLI and the Stop hook's re-arm nudge all read
// from here, so the numbers and the invocation can never drift apart.
import { fileURLToPath } from "node:url";
import { getPaths } from "../paths.mjs";

// One long-poll window. Short on purpose: an idle HTTP socket held for hours is
// what a reconnect or a broker restart kills, so every failure is a retry at a
// window boundary rather than a lost waiter.
export const WAIT_WINDOW_MS = 55_000;

// Strictly under BASH_TIMEOUT_MS: the waiter prints WAIT EXPIRED and exits on its
// own before Bash kills the background task, so expiry is a wake with an
// instruction rather than a silent death.
export const WAIT_CAP_MS = 6_900_000;
export const BASH_TIMEOUT_MS = 7_000_000;

const CLI_PATH = fileURLToPath(new URL("../../bin/claude-slack.mjs", import.meta.url));

// Matches bin/claude-slack.mjs getDefaultPaths().configFile, so a caller that
// passes the default path (or nothing) gets no flag.
function defaultConfigPath() {
  return getPaths().configDir + "/config.json";
}

// `--config` only when the path is non-default: a hook that reads the default
// config against a broker started on a custom one 401s, and a hook that treats
// any error as "allow" then fails silently.
export function waitCommand(peerId, { configPath } = {}) {
  let cmd = `node "${CLI_PATH}" wait --peer ${peerId}`;
  if (configPath && configPath !== defaultConfigPath()) cmd += ` --config "${configPath}"`;
  return cmd;
}
