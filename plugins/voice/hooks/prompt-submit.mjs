#!/usr/bin/env node
// UserPromptSubmit hook: run the operator's mined cues over the prompt; inject notes only on a concrete match.
// Silent until `voice setup` has written cues.json. Never blocks: every failure path exits 0.
import fs from "node:fs";
import { getPaths, filesFor } from "../src/paths.mjs";
import { runCues } from "../src/cues.mjs";

function main() {
  if ((process.env.CLAUDE_VOICE || "").toLowerCase() === "off") return;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { return; }
  const prompt = String(payload && payload.prompt || "").trim();
  if (!prompt || prompt.startsWith("Cache keepalive tick") || prompt.startsWith("<")) return;
  const { cues } = filesFor(getPaths());
  let list;
  try { list = JSON.parse(fs.readFileSync(cues, "utf8")).cues; } catch { return; }
  if (!Array.isArray(list)) return;
  const fired = runCues(prompt, list);
  if (!fired.length) return;
  process.stdout.write(`<operator-cues v="1">\n${fired.map(f => `- ${f.id}: ${f.note}`).join("\n")}\n</operator-cues>\n`);
}

try { main(); } catch { /* a broken hook must never block a prompt */ }
process.exit(0);
