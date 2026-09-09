import { test } from "node:test";
import { equal, ok, fail } from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const readme = join(root, "plugins", "swarm", "README.md");
const skillsDir = join(root, "plugins", "swarm", "skills");

function* walkMd(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      yield join(entry.parentPath, entry.name);
    }
  }
}

const scopeFiles = [readme, ...walkMd(skillsDir)]
  .map((p) => relative(root, p))
  .sort();

const marker = "<!-- swarm-bootstrap-exception: the only sanctioned engine-path instruction in the tree -->";
const patterns = [
  { name: "plugins/cache", re: /plugins\/cache/ },
  { name: "scripts/swarm.mjs", re: /scripts\/swarm\.mjs/ },
  // Bare form only: exclude the same line that already carries the scripts/ prefix.
  { name: "bare swarm.mjs", re: /(?<!scripts\/)\bswarm\.mjs\b/ },
];

test("docs teaching surface has no hand-resolved engine-path instructions", () => {
  const markerHits = [];
  const violations = [];

  for (const rel of scopeFiles) {
    const abs = join(root, rel);
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    let skipNext = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (line.includes(marker)) {
        markerHits.push({ file: rel, line: i + 1 });
        skipNext = true;
        continue;
      }
      for (const { name, re } of patterns) {
        if (re.test(line)) {
          violations.push({
            pattern: name,
            file: rel,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }
  }

  equal(
    markerHits.length,
    1,
    `bootstrap marker must appear exactly once in scope, found ${markerHits.length}: ${JSON.stringify(markerHits)}`,
  );

  const { file: markerFile, line: markerLine } = markerHits[0];
  const markerFileLines = readFileSync(join(root, markerFile), "utf8").split(/\r?\n/);
  const bootstrapLine = markerFileLines[markerLine]; // markerLine is 1-based, so this is the next line
  ok(
    bootstrapLine && bootstrapLine.includes("node ") && bootstrapLine.includes("scripts/swarm.mjs"),
    `line after marker must be the one-off bootstrap invocation, got: ${bootstrapLine}`,
  );

  if (violations.length > 0) {
    const summary = violations
      .map((v) => `${v.pattern} in ${v.file}:${v.line}: ${v.text}`)
      .join("\n");
    fail(`found ${violations.length} hand-resolution instruction(s):\n${summary}`);
  }
});
