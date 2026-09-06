import path from "node:path";
import os from "node:os";

// VOICE_HOME overrides everything (tests, alternate profiles).
export function getPaths(env = process.env, platform = process.platform) {
  if (env.VOICE_HOME) {
    const h = env.VOICE_HOME;
    return { configDir: h, dataDir: h, transcriptsDir: transcriptsDir(env) };
  }
  const home = os.homedir();
  let configDir, dataDir;
  if (platform === "win32") {
    configDir = path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "voice");
    dataDir = configDir;
  } else if (platform === "darwin") {
    configDir = path.join(home, "Library", "Application Support", "voice");
    dataDir = configDir;
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "voice");
    dataDir = path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "voice");
  }
  return { configDir, dataDir, transcriptsDir: transcriptsDir(env) };
}

function transcriptsDir(env) {
  return env.VOICE_TRANSCRIPTS || path.join(os.homedir(), ".claude", "projects");
}

export function filesFor(p) {
  return {
    profile: path.join(p.configDir, "profile.md"),
    cues: path.join(p.configDir, "cues.json"),
    turns: path.join(p.dataDir, "turns.jsonl"),
    stats: path.join(p.dataDir, "stats.json"),
    sample: path.join(p.dataDir, "sample.md"),
  };
}
