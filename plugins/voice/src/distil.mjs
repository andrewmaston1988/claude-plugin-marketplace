// Turn the sample into an operator profile with one model call (claude -p).
import { spawnSync } from "node:child_process";

export const PROMPT_HEADER = `Below is a stratified sample of messages one person typed to a coding assistant while working. Write a reader's guide to that person for a model that will meet them cold at the start of every session: how they write, what their phrasing actually means, what they value, what annoys them, and how to respond. Use only what is in the sample. The sample is dominated by the fastest register — short directives typed mid-work; give the considered and neutral registers equal weight, and treat frustration as one mode among several rather than the baseline. Skip project and domain facts (the model gets those elsewhere); this is about the person. Write it in the language the sample is written in, under 700 words, starting with the heading "# Operator profile" verbatim. No preamble, no closing remarks.

---

`;

export function buildPrompt(sampleMarkdown) {
  return PROMPT_HEADER + sampleMarkdown;
}

// One `claude -p` call with the prompt on stdin; returns stdout text. Injectable for tests.
export function runClaude(prompt, { model = "sonnet", _spawn = spawnSync, claudeBin } = {}) {
  const args = ["-p", "--model", model, "--output-format", "text"];
  const opts = { input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  let r = _spawn(claudeBin || "claude", args, opts);
  // Native claude.exe resolves directly; npm's claude.cmd shim needs cmd.exe (spawn can't run .cmd without a shell).
  if (r.error && process.platform === "win32" && !claudeBin) {
    r = _spawn("cmd.exe", ["/d", "/s", "/c", "claude", ...args], opts);
  }
  if (r.error) throw new Error(`claude -p failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude -p exited ${r.status}: ${(r.stderr || "").trim().slice(0, 500)}`);
  return String(r.stdout || "").trim();
}

export function distil(sampleMarkdown, opts = {}) {
  const out = runClaude(buildPrompt(sampleMarkdown), opts);
  if (!/^# Operator profile/m.test(out)) throw new Error("claude -p returned something that is not an operator profile:\n" + out.slice(0, 300));
  return out;
}
