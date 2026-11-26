// The output check: one argv command a manifest names, run without a shell against
// the text a leaf produced. Exit 0 passes, exit 1 rejects (its own output is the
// correction), and anything else means the checker is broken, not the answer.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Fixed, never manifest-settable: a hung checker must not hold a run open.
export const CHECK_DEADLINE_MS = 120_000;
// A killed tree can keep its pipes open through a grandchild, so a kill settles here.
const KILL_GRACE_MS = 5000;
// A tree kill can lose its race — taskkill gives up under load — so it is retried.
const KILL_RETRY_MS = 1000;
const KILL_RETRIES = 3;
const STOP_POLL_MS = 100;

export const CHECK_PASS = "pass";
export const CHECK_REJECT = "reject";
export const CHECK_BROKEN = "broken";

const OUTPUT_TOKEN = "{output}";

export function checkOutputPath(resultsDir, taskId) {
  return join(resultsDir, "results", `${taskId}.check.txt`);
}

// Substituted per element, so a path with spaces stays one argument — the reason
// a check is argv and not a command line.
export function checkArgv(check, outputPath) {
  return check.map((arg) => (arg.includes(OUTPUT_TOKEN) ? arg.replaceAll(OUTPUT_TOKEN, outputPath) : arg));
}

function killTree(child, io) {
  // POSIX: the child is detached, so its own group covers whatever it started.
  if (process.platform !== "win32" && child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
  }
  try { (io.killTree ?? ((c) => c.kill()))(child); } catch { /* already gone */ }
}

// Returns { outcome, text }: text is the checker's capped output on a rejection,
// and the diagnostic on a broken run.
export async function runCheck(task, output, { cwd, resultsDir, cfg, io, deadlineMs = CHECK_DEADLINE_MS, isCancelled }) {
  const outputPath = checkOutputPath(resultsDir, task.id);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, String(output ?? ""));
  const argv = checkArgv(task.check, outputPath);
  const cap = cfg?.resultInlineCap ?? 4000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopReason = null;
    let timer = null;
    let poll = null;
    let grace = null;
    let retries = null;
    const text = () => [stdout, stderr].filter(Boolean).join("\n").trim().slice(0, cap);
    const finish = (outcome, message) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (grace) clearTimeout(grace);
      if (retries) clearInterval(retries);
      // A straggler holding our pipes must never keep the engine alive.
      try { child?.stdout?.destroy(); } catch { /* gone */ }
      try { child?.stderr?.destroy(); } catch { /* gone */ }
      try { child?.unref?.(); } catch { /* gone */ }
      resolve({ outcome, text: message });
    };
    const killed = () => finish(CHECK_BROKEN, `${stopReason}\n${text()}`.trim());
    let child;
    try {
      child = io.spawn(argv[0], argv.slice(1), {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: io.env || process.env,
      });
    } catch (e) {
      finish(CHECK_BROKEN, `output check could not start: ${e.message}`);
      return;
    }
    const stop = (message) => {
      if (settled || stopReason) return;
      stopReason = message;
      killTree(child, io);
      // Keep killing while it lives: a taskkill that timed out under load leaves the
      // tree running, and an orphaned checker is worse than a slow one.
      let attempts = 0;
      retries = setInterval(() => {
        attempts += 1;
        if (settled || child.exitCode !== null || child.signalCode !== null || attempts > KILL_RETRIES) {
          clearInterval(retries);
          return;
        }
        killTree(child, io);
      }, KILL_RETRY_MS);
      // A surviving grandchild holds the pipes open, so `close` may never arrive.
      grace = setTimeout(killed, KILL_GRACE_MS);
    };
    // Attach separately from setEncoding: a pipe that cannot be decoded must still
    // deliver its bytes, and a child without stdio must not throw here.
    if (child.stdout?.setEncoding) child.stdout.setEncoding("utf8");
    child.stdout?.on("data", (d) => { stdout += d; });
    if (child.stderr?.setEncoding) child.stderr.setEncoding("utf8");
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish(CHECK_BROKEN, `output check could not start: ${e.message}`));
    child.on("close", (code) => {
      if (settled) return;
      if (stopReason) return killed();
      if (code === 0) return finish(CHECK_PASS, "");
      if (code === 1) return finish(CHECK_REJECT, text() || "the check rejected the output with no message");
      finish(CHECK_BROKEN, `output check exited ${code}: ${text()}`.trim());
    });
    timer = setTimeout(() => stop(`output check timed out after ${deadlineMs} ms and was killed`), deadlineMs);
    if (isCancelled) poll = setInterval(() => { if (isCancelled()) stop("output check stopped: the run was stopped"); }, STOP_POLL_MS);
  });
}
