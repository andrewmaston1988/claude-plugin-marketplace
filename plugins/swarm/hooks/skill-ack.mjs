#!/usr/bin/env node
// PostToolUse hook on Skill: writes the per-session marker that dispatch-gate.mjs
// requires before `swarm.mjs run` may proceed.
//
// Written by the harness pipeline rather than by the model, so nothing in the
// documented workflow points at it — the same contract the commit skill uses.
// Hardening, not airtight enforcement: the model could write the file directly,
// but it would have to go looking for this hook to learn how.
//
// Exit 0 always. This hook must never block anything.
import fs from "node:fs";
import path from "node:path";
import { markerPath } from "./dispatch-gate.mjs";

// A plugin skill may arrive namespaced ("swarm:swarm") or bare ("swarm"), so accept
// both rather than betting on one and silently never arming the gate.
export function shouldAck(payload) {
  if (payload?.tool_name !== "Skill") return false;
  const skill = payload?.tool_input?.skill;
  return skill === "swarm:swarm" || skill === "swarm";
}

async function main() {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) stdin += c;

  let payload;
  try { payload = JSON.parse(stdin); } catch { return; }
  if (!shouldAck(payload)) return;

  const sessionId = String(payload.session_id || "");
  if (!sessionId) return;

  try {
    const marker = markerPath(sessionId);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()), "utf8");
  } catch { /* a marker we cannot write is a dispatch that gets blocked — never a crash */ }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
