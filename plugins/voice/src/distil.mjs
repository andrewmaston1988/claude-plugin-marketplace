// Turn the sample into an operator profile with one model call (claude -p).
import { spawnSync } from "node:child_process";

export const PROMPT_HEADER = `Below is a stratified sample of messages one person typed to a coding assistant while working. Write a reader's guide to that person for a model that will meet them cold at the start of every session: how they write, what their phrasing actually means, what they value, what annoys them, and how to respond. Use only what is in the sample. Write it in the language the sample is written in, under 700 words, starting with the heading "# Operator profile" verbatim. No preamble, no closing remarks.

---

`;

export function buildPrompt(sampleMarkdown) {
  return PROMPT_HEADER + sampleMarkdown;
}

// Runs `claude -p` with the prompt on stdin. Injectable for tests.
export function distil(sampleMarkdown, { model = "sonnet", _spawn = spawnSync, claudeBin } = {}) {
  const prompt = buildPrompt(sampleMarkdown);
  // npm ships claude as a .cmd shim on Windows; naming it avoids shell:true and its escaping hazards.
  const bin = claudeBin || (process.platform === "win32" ? "claude.cmd" : "claude");
  const r = _spawn(bin, ["-p", "--model", model, "--output-format", "text"], {
    input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`claude -p failed to start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude -p exited ${r.status}: ${(r.stderr || "").trim().slice(0, 500)}`);
  const out = String(r.stdout || "").trim();
  if (!/^# Operator profile/m.test(out)) throw new Error("claude -p returned something that is not an operator profile:\n" + out.slice(0, 300));
  return out;
}
