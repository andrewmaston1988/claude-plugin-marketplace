import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { logosScript } from "../src/serve/logos.mjs";

const dir = new URL("../src/serve/logos/", import.meta.url);
const hashes = { ollama: "4305f4ae1db553f1cc7d5bf19ab4e2cb1a074b65082ba9749275e2b884f5fb3b", claude: "1845ffc14c53430ac091f29d96be240b0b92e7510db5174cd713e6b2c1ac05e1", codex: "f7fa9205c0b3d0e5dfb9d09496a917d0b3ea543acd3fb3b5499ef48cfe6775ce" };
const originals = Object.fromEntries(Object.keys(hashes).map((name) => [name, readFileSync(new URL(`${name}.svg`, dir), "utf8")]));
function loadLogos() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(logosScript(), context);
  return context.window.swarmLogos;
}

test("provider logo files match the pinned artwork hashes", () => {
  for (const [name, expected] of Object.entries(hashes)) assert.equal(createHash("sha256").update(originals[name], "utf8").digest("hex"), expected, name);
});

test("logos script runs in a VM and embeds only the three stored marks", () => {
  const script = logosScript();
  assert.ok(loadLogos().providerLogo);
  assert.ok(script.includes(JSON.stringify({ claude: originals.claude, codex: originals.codex, ollama: originals.ollama })));
});

test("providerLogo recolours black marks and keeps Claude's brand colour", () => {
  const logos = loadLogos();
  assert.match(logos.providerLogo("ollama"), /fill="currentColor"/);
  assert.match(logos.providerLogo("codex"), /fill="currentColor"/);
  assert.match(logos.providerLogo("claude"), /fill="#D97757"/);
});

test("providerLogo strips title elements and marks decorative SVGs hidden", () => {
  const logo = loadLogos().providerLogo("ollama");
  assert.doesNotMatch(logo, /<title>/);
  assert.match(logo, /class="plogo"/);
  assert.match(logo, /aria-hidden="true"/);
});

test("anthropic, uppercase ANTHROPIC, and claude resolve to the same logo", () => {
  const { providerLogo } = loadLogos();
  assert.equal(providerLogo("anthropic"), providerLogo("claude"));
  assert.equal(providerLogo("ANTHROPIC"), providerLogo("claude"));
});

test("unknown providers have no logo", () => {
  assert.equal(loadLogos().providerLogo("custom-provider"), "");
});

test("an explicit provider label makes the logo accessible and escapes its value", () => {
  const logo = loadLogos().providerLogo("ollama", { label: 'x"><script>' });
  assert.match(logo, /role="img"/);
  assert.match(logo, /aria-label="x&quot;&gt;&lt;script&gt;"/);
  assert.doesNotMatch(logo, /aria-hidden/);
});

// The chip disc's colours per provider. The stored SVGs are never edited, so the
// disc, its ring and the mark's colour are all render-time.
const DISCS = {
  ollama: { disc: "#fff", ring: "#d4d4d4", mark: "#000" },
  codex: { disc: "#10A37F", ring: "#087f64", mark: "#fff" },
  claude: { disc: "#D97757", ring: "#b75e42", mark: "#fff" },
};

test("a chip draws the provider's disc and ring, and recolours the mark to the chip's colour", () => {
  const { providerLogo } = loadLogos();
  for (const [name, c] of Object.entries(DISCS)) {
    const chip = providerLogo(name, { chip: true });
    assert.match(chip, new RegExp(`<circle[^>]*fill="${c.disc}"[^>]*stroke="${c.ring}"`), `${name}: disc fill and ring`);
    const fills = [...chip.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(fills)].sort(), [c.disc, c.mark].sort(), `${name}: only the disc and the mark are filled`);
    // The mark fills 48/64 (75%) of the disc's diameter.
    assert.match(chip, /translate\(8 8\) scale\(0\.1875\)/, `${name}: the mark sits at 75% of the disc`);
  }
});

test("a chip has no per-chip SVG filter — the shadow and pulse are CSS", () => {
  for (const name of Object.keys(DISCS)) {
    const chip = loadLogos().providerLogo(name, { chip: true });
    assert.doesNotMatch(chip, /<filter|url\(#/, `${name}: a filter def per chip would duplicate ids in the page`);
    assert.doesNotMatch(chip, /<title>/);
  }
});

test("a chip takes the same label rules as a free-standing logo", () => {
  const { providerLogo } = loadLogos();
  assert.match(providerLogo("codex", { chip: true, label: "codex" }), /role="img" aria-label="codex"/);
  const unlabelled = providerLogo("codex", { chip: true });
  assert.match(unlabelled, /aria-hidden="true"/);
  assert.doesNotMatch(unlabelled, /role="img"/);
});

test("dashboard declares a dark-only colour scheme so forced dark mode leaves the chip marks alone", () => {
  // Brave/Chrome auto-dark repaints the black Ollama mark white on its white disc unless the page opts out.
  const page = readFileSync(new URL("../src/serve/page.html", import.meta.url), "utf8");
  assert.ok(page.includes(`<meta name="color-scheme" content="dark">`), "page.html must declare <meta name=\"color-scheme\" content=\"dark\">");
});
