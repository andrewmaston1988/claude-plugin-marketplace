// Codex exec-event transcripts in the REAL shape, shared by the codex coverage tests.
import { parseReadCalls } from "../../src/coverage.mjs";

// A parsed command carries a quoted absolute exe path with DOUBLED separators
// (`C:\\Users\\…` — cmd tolerates them). Build that by doubling a real path rather
// than hand-escaping it per case.
let _uid = 0;
export const dbl = (p) => p.replace(/\\/g, "\\\\");
export const cmdRun = (payload) => `"${dbl("C:\\WINDOWS\\system32\\cmd.exe")}" /c "${payload}"`;
export const bashRun = (payload) => `"${dbl("C:\\Program Files\\Git\\usr\\bin\\bash.exe")}" -c '${payload}'`;

// Every completed exec event in the real transcript has an `item.started` twin
// (exit_code null) and a non-JSON line ahead of the stream.
export function event(command, { exit = 0, output = "", started = true } = {}) {
  const item = { id: `item_${_uid++}`, type: "command_execution", command, aggregated_output: output, exit_code: exit, status: exit === 0 ? "completed" : "failed" };
  const lines = [];
  if (started) lines.push(JSON.stringify({ type: "item.started", item: { ...item, aggregated_output: "", exit_code: null, status: "in_progress" } }));
  lines.push(JSON.stringify({ type: "item.completed", item }));
  return lines;
}
export const transcript = (...events) => [
  "Reading additional input from stdin...",
  JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  JSON.stringify({ type: "turn.started" }),
  ...events.flat(),
].join("\n") + "\n";
export const readsOf = (text, cwd) => parseReadCalls(text, "codex", { cwd });

// The PowerShell wrapper, as codex really emits it: the exe as a quoted absolute
// path with doubled separators, then the payload. A payload holding `"` arrives
// escaped (`\"`), as codex re-serialises it.
export const PS_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
export const pwshRun = (payload, ...switches) => `"${dbl(PS_EXE)}"${switches.map((s) => ` ${s}`).join("")} -Command "${payload.replace(/"/g, '\\"')}"`;
export const psRun = (payload, ...switches) => `"${dbl("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")}"${switches.map((s) => ` ${s}`).join("")} -Command "${payload.replace(/"/g, '\\"')}"`;
