#!/usr/bin/env node
// PostToolUse hook on Skill (Claude) and Bash (Codex): writes the per-session markers that dispatch-gate.mjs
// requires before `swarm.mjs run` may proceed — one for the swarm skill (spend
// consent, consumed per dispatch), one each for the two grouping skills
// (`orchestrating-agents`, `executing-swarms` — reading, not consent, so never
// consumed).
//
// Written by the harness pipeline rather than by the model, so nothing in the
// documented workflow points at it — the same contract the commit skill uses.
// Hardening, not airtight enforcement: the model could write the file directly,
// but it would have to go looking for this hook to learn how.
//
// Exit 0 always. This hook must never block anything.
import fs from "node:fs";
import path from "node:path";
import { markerPath, groupingMarkerPath, shapeMarkerPath, isCodexPayload } from "./dispatch-gate.mjs";

// A plugin skill may arrive namespaced ("swarm:swarm") or bare ("swarm"), so accept
// both rather than betting on one and silently never arming the gate. Codex has no
// Skill tool: it loads a skill by reading its SKILL.md through the shell, so that
// read is the invocation there — a read verb (alone or after `cd …;`/`&&`), so `git add`
// or `rg` naming the file arms nothing.
const SKILLS = ["swarm", "orchestrating-agents", "executing-swarms"];
const CODEX_SKILL_READ_RE = new RegExp(
  `(?:^|[;&|])\\s*(?:get-content|gc|cat|head|type|sed|less|more)\\b.*skills[\\\\/]+(${SKILLS.join("|")})[\\\\/]+SKILL\\.md`,
  "i",
);

function ackedSkill(payload) {
  if (payload?.tool_name === "Skill") {
    const skill = String(payload?.tool_input?.skill || "").replace(/^swarm:/, "");
    return SKILLS.includes(skill) ? skill : null;
  }
  if (payload?.tool_name === "Bash" && isCodexPayload(payload)) {
    const m = CODEX_SKILL_READ_RE.exec(String(payload?.tool_input?.command || ""));
    return m ? m[1].toLowerCase() : null;
  }
  return null;
}

export function shouldAck(payload) {
  return ackedSkill(payload) !== null;
}

// Returns the marker path(s) to write for the invoked skill — empty for anything
// else, or when no session id is present to key the marker on.
export function ackTargets(payload) {
  const skill = ackedSkill(payload);
  if (!skill) return [];
  const sessionId = String(payload.session_id || "");
  if (!sessionId) return [];
  if (skill === "swarm") return [markerPath(sessionId)];
  if (skill === "orchestrating-agents") return [groupingMarkerPath(sessionId)];
  return [shapeMarkerPath(sessionId)];
}

async function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;

  let payload;
  try { payload = JSON.parse(stdin); } catch { return; }

  const targets = ackTargets(payload);
  for (const marker of targets) {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, String(Date.now()), "utf8");
    } catch { /* a marker we cannot write is a dispatch that gets blocked — never a crash */ }
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
