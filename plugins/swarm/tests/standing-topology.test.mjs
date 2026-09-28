// Standing mode drops the offer question, never the topology derivation. These
// phrases once told a `swarm.always` session to keep its partition, three legs and
// graph off the page — the decision the orchestrating-agents Iron Law says exists
// only on the page.
import { test } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { standingBlock, MODE_ARMED, MODE_UNARMED } from "../hooks/ultraswarm.mjs";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const CARVE_OUTS = [
  "Emit none of the reasoning",
  "Emit nothing",
  "no grouping block",
  "stops applying where",
  "the manifest's shape records",
  "recorded in the manifest's shape",
  "never narrated",
  "nothing is printed or narrated",
  "nothing is printed or stated",
];

function markdownUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownUnder(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []);
}

// The hook's block is an array of lines, so a phrase can straddle two literals —
// only the rendered text is checked, never the source file.
const rendered = () => [standingBlock(MODE_ARMED), standingBlock(MODE_UNARMED)].map((t) => t.replace(/\s+/g, " "));

test("no swarm skill tells a standing-mode session to keep the derivation off the page", () => {
  const hits = [];
  for (const file of markdownUnder(SKILLS)) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const phrase of CARVE_OUTS) if (text.includes(phrase)) hits.push(`${file.slice(SKILLS.length + 1)}: "${phrase}"`);
  }
  ok(hits.length === 0, `carve-out wording is back:\n  ${hits.join("\n  ")}`);
});

test("the standing-mode hook block carries no carve-out phrase", () => {
  for (const text of rendered()) {
    for (const phrase of CARVE_OUTS) ok(!text.includes(phrase), `hook block says "${phrase}"`);
  }
});

// All three legs of orchestrating-agents: §2 partition, §2a block, §3 graph.
const namesDerivation = (t) => [/§2(?!a)/, /§2a/, /§3/, /partition/, /graph/].every((re) => re.test(t));

test("the standing branch and the hook both name the derivation", () => {
  const branch = readFileSync(join(SKILLS, "swarm", "SKILL.md"), "utf8")
    .split("\n").find((l) => l.startsWith("**`swarm.always` is set"));
  ok(branch, "standing branch line present");
  ok(namesDerivation(branch), `standing branch names the derivation:\n${branch}`);
  for (const text of rendered()) ok(namesDerivation(text), `hook names the derivation:\n${text}`);
});
