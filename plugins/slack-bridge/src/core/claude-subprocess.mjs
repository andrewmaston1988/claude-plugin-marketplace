import { spawn } from "node:child_process";

const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

function isClaudeModel(model) {
  return model.startsWith("claude-") || CLAUDE_ALIASES.has(model.toLowerCase());
}

// Windows NT status codes (0xC0000000+) arrive as large positive exit numbers.
// Name the common loader/exec failures so a crash like 0xC0000135 isn't an
// opaque "3221225786" in the Slack error reply — the operator can act on
// "STATUS_DLL_NOT_FOUND" where a bare number is meaningless.
const NT_STATUS_NAMES = {
  0xc0000005: "STATUS_ACCESS_VIOLATION",
  0xc00000fd: "STATUS_STACK_OVERFLOW",
  0xc0000135: "STATUS_DLL_NOT_FOUND",
  0xc0000139: "STATUS_ENTRYPOINT_NOT_FOUND",
  0xc0000142: "STATUS_DLL_INIT_FAILED",
  0xc000041d: "STATUS_FATAL_APP_EXIT",
};
function formatExitCode(code) {
  if (code == null) return "null (terminated without exit code)";
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`;
  const named = NT_STATUS_NAMES[code >>> 0];
  if (named) return `${code} (${hex} ${named})`;
  if ((code >>> 0) >= 0x80000000) return `${code} (${hex} NT status)`;
  return String(code);
}

// Pure invocation builder so model/proxy routing is unit-testable.
// Non-Claude models route through the Anthropic-format proxy endpoint
// (ollama direct in the reference setup) via env overrides on the child only.
export function buildClaudeInvocation({ prompt, sessionId, addDir, model, proxy }) {
  // --print (not -p <prompt>): the prompt is delivered via stdin below. A literal
  // newline inside a -p argv element makes cmd.exe /d /s /c terminate the /c
  // command at that newline, silently dropping every arg after it (--output-format,
  // --model, --resume). --print reads the prompt from stdin so argv stays newline-free.
  const args = ["--print", "--output-format", "json"];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  if (addDir) args.push("--add-dir", addDir);

  const envOverrides = {};
  if (model && !isClaudeModel(model)) {
    envOverrides.ANTHROPIC_BASE_URL = proxy?.url ?? "http://localhost:11434";
    envOverrides.ANTHROPIC_API_KEY  = proxy?.authToken ?? "ollama";
    envOverrides.ANTHROPIC_MODEL    = model;
  }
  return { args, envOverrides };
}

export function runClaude({ cwd, addDir, prompt, sessionId, model, proxy, timeoutMs = 180_000, onStarted, env = {} }) {
  return new Promise((resolve, reject) => {
    const { args, envOverrides } = buildClaudeInvocation({ prompt, sessionId, addDir, model, proxy });

    // Copy process.env but strip Slack tokens — they must not leak into the claude subprocess.
    const childEnv = { ...process.env };
    delete childEnv.SLACK_BOT_TOKEN;
    delete childEnv.SLACK_APP_TOKEN;
    Object.assign(childEnv, env, envOverrides, { CLAUDE_VIA_SLACK: "1" });

    // On Windows, `claude` is installed as `claude.cmd` (npm convention).
    // spawn() without shell:true can't resolve .cmd files from PATH, so we
    // use cmd.exe explicitly with properly separated arguments.
    // stdio[0] is a pipe so the prompt can be written to stdin (--print mode).
    const [spawnCmd, spawnArgs, spawnOpts] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "claude", ...args], { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }]
      : ["claude",  args,                                   { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }];
    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    onStarted?.(child);

    // Deliver the prompt via stdin once the child has spawned. Writing on the
    // 'spawn' event (rather than synchronously after spawn()) avoids any race
    // with pipe setup; .end() closes stdin so claude's --print reader sees EOF.
    // Errors here must never crash the bridge — stdin may already be destroyed
    // if the child died at startup (e.g. a Windows loader crash).
    child.stdin?.on?.("error", () => { /* pipe closed; exit handler will report the real code */ });
    child.once("spawn", () => {
      try { child.stdin?.end(prompt); }
      catch { /* stdin already torn down; the exit/JSON-parse path surfaces the failure */ }
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("exit", code => {
      clearTimeout(timer);
      if (code !== 0) {
        // --resume targeted a session that no longer exists (cleaned up / expired).
        // Retry once as a fresh session; the caller persists the returned sessionId,
        // so the store self-heals and subsequent turns resume the fresh one.
        if (sessionId && /No conversation found with session ID/.test(stderr)) {
          return resolve(runClaude({ cwd, addDir, prompt, sessionId: undefined, model, proxy, timeoutMs, onStarted, env }));
        }
        return reject(new Error(`claude exited ${formatExitCode(code)}: ${stderr.slice(-300)}`));
      }
      try {
        const data = JSON.parse(stdout);
        resolve({
          result: data.result ?? "",
          sessionId: data.session_id ?? null,
          costUsd: data.total_cost_usd ?? 0,
        });
      } catch (e) {
        reject(new Error(`claude output not JSON: ${e.message}\nOutput: ${stdout.slice(0, 200)}`));
      }
    });

    child.on("error", e => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude: ${e.message}`));
    });
  });
}
