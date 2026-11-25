// A git process killed mid-write leaves a zero-byte `<x>.lock` behind, and every later ref
// write in that repo refuses. Prune only DIAGNOSES such a lock: removing one a live process
// holds corrupts the ref store, so the reader is told what it is and decides.

// A lock older than this with no bytes written cannot belong to a live writer: git creates
// and fills a lock within milliseconds.
const STALE_AFTER_MS = 60_000;
const EMPTY_BYTES = 0;

// git's own refusal carries the path — `error: could not delete reference ...: Unable to
// create '<path>': File exists.` Both quote styles appear: git C-quotes paths that need it.
const REFUSAL = /Unable to create ['"](.+?)['"]: File exists/;

export function lockPath(reason) {
  const found = REFUSAL.exec(reason ?? "");
  return found ? found[1] : null;
}

// `stale` / `held` / `gone`, with the lock's size and age when it was read. A probe that
// answers anything but a definite "no git running" reads as held: a wrong "safe to remove"
// costs a corrupt ref store, a wrong "wait" costs one more prune.
export function classifyLock(path, { fs, now = Date.now(), gitRunning } = {}) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch (e) {
    if (e?.code === "ENOENT") return { state: "gone", path };
    return { state: "held", path, cause: "unreadable" };
  }
  const ageMs = Math.max(0, now - stat.mtimeMs);
  const found = { path, size: stat.size, ageMs };
  if (stat.size > EMPTY_BYTES) return { state: "held", cause: "content", ...found };
  if (ageMs < STALE_AFTER_MS) return { state: "held", cause: "young", ...found };
  let running;
  try { running = gitRunning ? gitRunning() : null; } catch { running = null; }
  if (running === false) return { state: "stale", ...found };
  return { state: "held", cause: running === true ? "process" : "unknown", ...found };
}

// Is a git process running? win32 answers with tasklist because MSYS `pgrep` sees only MSYS
// processes, never a native git. Null means the check could not be made — never "idle".
export function gitRunning(spawnSync, platform = process.platform) {
  const windows = platform === "win32";
  const [command, args] = windows
    ? ["tasklist", ["/FI", "IMAGENAME eq git.exe", "/NH"]]
    : ["pgrep", ["-x", "git"]];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (!result || result.error || result.status == null) return null;
  if (windows) {
    // tasklist exits 0 either way; its no-match line says so in prose.
    if (result.status !== 0) return null;
    return /^git\.exe\b/im.test(result.stdout || "");
  }
  if (result.status === 0) return true;
  // pgrep's "no process matched" is exit 1; every other failure proves nothing.
  return result.status === 1 ? false : null;
}
