#!/usr/bin/env node
// SessionStart hook: inject the operator profile once per session.
// Silent until `voice setup` has written a profile. Never blocks: every failure path exits 0.
import fs from "node:fs";
import { getPaths, filesFor } from "../src/paths.mjs";

function main() {
  if ((process.env.CLAUDE_VOICE || "").toLowerCase() === "off") return;
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { /* no payload — still fine */ }
  // Resume/compact carry the earlier injection in the transcript already.
  const source = payload && payload.source;
  if (source && source !== "startup" && source !== "clear") return;
  const { profile } = filesFor(getPaths());
  let body;
  try { body = fs.readFileSync(profile, "utf8").trim(); } catch { return; }
  if (!body) return;
  process.stdout.write(`<operator-profile v="1">\n${body}\n</operator-profile>\n`);
}

try { main(); } catch { /* a broken hook must never block a session */ }
process.exit(0);
