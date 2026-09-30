import { isCodexPayload } from "./dispatch-gate.mjs";
// Claude shows Stop hook output on the operator's terminal; UserPromptSubmit additionalContext reaches only the model.
// Headless Claude has no terminal and no later prompt turn, so it stays on Stop.
const usesStop = (p, env) => isCodexPayload(p) || String(env.CLAUDE_CODE_ENTRYPOINT || "").startsWith("sdk");
export const nudgeEventFor = (p, env) => (usesStop(p, env) ? "Stop" : "UserPromptSubmit");
export function nudgeOutput(p, env, reason) {
  return usesStop(p, env)
    ? { decision: "block", reason }
    : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reason } };
}