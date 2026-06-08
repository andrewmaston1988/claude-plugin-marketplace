import { spawn } from "node:child_process";

const HAIKU_TIMEOUT_MS = 45_000;
const CTX_KEYS = ["file_path", "command", "pattern", "path", "prompt", "description", "query"];

/**
 * Fire-and-forget: spawn claude -p to fetch a single whimsical verb for the
 * current tool. Calls onVerb(word) asynchronously if successful.
 *
 * @param {{ tool: string|undefined, input: object|undefined, onVerb: (v: string) => void, log: object, model: string|undefined }} opts
 */
export function fetchHaikuVerb({ tool, input, onVerb, log, model = "claude-haiku-4-5" }) {
  let ctxStr = "";
  for (const k of CTX_KEYS) {
    if (typeof input?.[k] === "string") { ctxStr = ` on ${input[k].slice(0, 80)}`; break; }
  }

  const toolName = tool || "thinking";
  const prompt =
    `Give one single-word present-participle verb (ending in -ing) describing an AI ` +
    `assistant currently using the '${toolName}' tool${ctxStr}. ` +
    `Prefer surreal, whimsical, or quirky words — evocative of transformation, discovery, or momentum. ` +
    `Be playful and unexpected. Avoid generic words like Processing, Computing, Analyzing, Running. ` +
    `Return only the single word, nothing else.`;

  const args = ["-p", prompt, "--model", model, "--output-format", "text"];
  // On Windows, `claude` is installed as `claude.cmd`; spawn() without shell:true
  // cannot resolve .cmd files from PATH, so use cmd.exe explicitly.
  const [spawnCmd, spawnArgs, spawnOpts] = process.platform === "win32"
    ? ["cmd.exe", ["/d", "/s", "/c", "claude", ...args], { stdio: ["ignore", "pipe", "pipe"] }]
    : ["claude",  args,                                   { stdio: ["ignore", "pipe", "pipe"] }];
  const child = spawn(spawnCmd, spawnArgs, spawnOpts);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.on("data", c => { stderr += c; });

  const killTimer = setTimeout(() => child.kill("SIGTERM"), HAIKU_TIMEOUT_MS);

  child.on("exit", code => {
    clearTimeout(killTimer);
    if (code !== 0) {
      log?.info("haiku verb fetch non-zero exit", { code, stderr: stderr.slice(0, 100) });
      return;
    }
    const word = stdout
      .split("\n")
      .map(s => s.trim().replace(/[.,;:'"!?]$/g, ""))
      .find(s => /^[A-Za-z]+$/.test(s));
    if (word) {
      onVerb(word.charAt(0).toUpperCase() + word.slice(1));
    }
  });

  child.on("error", e => {
    clearTimeout(killTimer);
    log?.info("haiku verb fetch error", { error: e.message });
  });
}
