import { isCodexPayload } from "./dispatch-gate.mjs";
// Claude renders Stop output to the operator; UserPromptSubmit additionalContext reaches only the model.
export const nudgeEventFor = (p) => (isCodexPayload(p) ? "Stop" : "UserPromptSubmit");
export function nudgeOutput(p, reason) {
  return isCodexPayload(p)
    ? { decision: "block", reason }
    : { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: reason } };
}