import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached;

export function logosScript() {
  if (cached !== undefined) return cached;
  const marks = Object.fromEntries(["claude", "codex", "ollama"].map((name) => [
    name,
    readFileSync(fileURLToPath(new URL(`./logos/${name}.svg`, import.meta.url)), "utf8"),
  ]));
  const template = readFileSync(fileURLToPath(new URL("./logos.js", import.meta.url)), "utf8");
  cached = template.replace("__SWARM_LOGO_SVGS__", JSON.stringify(marks));
  return cached;
}
