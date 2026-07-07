import { spawn } from "node:child_process";

const CLAUDE_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

function isClaudeModel(model) {
  return model.startsWith("claude-") || CLAUDE_ALIASES.has(model.toLowerCase());
}

// Pure invocation builder so model/proxy routing is unit-testable.
// Non-Claude models route through the Anthropic-format proxy endpoint
// (ollama direct in the reference setup) via env overrides on the child only.
export function buildClaudeInvocation({ prompt, sessionId, addDir, model, proxy }) {
  const args = ["-p", prompt, "--output-format", "json"];
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
    const [spawnCmd, spawnArgs, spawnOpts] = process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", "claude", ...args], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }]
      : ["claude",  args,                                   { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }];
    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    onStarted?.(child);

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
        return reject(new Error(`claude exited ${code}: ${stderr.slice(-300)}`));
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
