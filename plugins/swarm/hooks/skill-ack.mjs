#!/usr/bin/env node
// PostToolUse hook on Skill: writes the per-session markers that dispatch-gate.mjs
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
import { markerPath, groupingMarkerPath, shapeMarkerPath } from "./dispatch-gate.mjs";

// A plugin skill may arrive namespaced ("swarm:swarm") or bare ("swarm"), so accept
// both rather than betting on one and silently never arming the gate.
export function shouldAck(payload) {
  if (payload?.tool_name !== "Skill") return false;
  const skill = payload?.tool_input?.skill;
  return (
    skill === "swarm:swarm" || skill === "swarm" ||
    skill === "swarm:orchestrating-agents" || skill === "orchestrating-agents" ||
    skill === "swarm:executing-swarms" || skill === "executing-swarms"
  );
}

// Returns the marker path(s) to write for the invoked skill — empty for anything
// else, or when no session id is present to key the marker on.
export function ackTargets(payload) {
  if (!shouldAck(payload)) return [];
  const sessionId = String(payload.session_id || "");
  if (!sessionId) return [];

  const skill = payload.tool_input.skill;
  if (skill === "swarm:swarm" || skill === "swarm") return [markerPath(sessionId)];
  if (skill === "swarm:orchestrating-agents" || skill === "orchestrating-agents") return [groupingMarkerPath(sessionId)];
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
