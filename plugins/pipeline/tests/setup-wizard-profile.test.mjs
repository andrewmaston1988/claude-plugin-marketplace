import { test } from "node:test";
import { equal, match } from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergePsProfile, mergeUnixRc, applyPsProfiles, MARKER } from "../src/setup/wizard-profile.mjs";

const RESOLVER_FN = `function pipeline { & "node.exe" "C:\\Users\\u\\.local\\bin\\pipeline-resolver.mjs" @args }`;
const STALE_FN    = `function pipeline { & "node.exe" "C:\\Users\\u\\.claude\\plugins\\cache\\x\\pipeline\\0.1.0\\bin\\pipeline.mjs" @args }`;
const RESOLVER_AL = `alias pipeline='node /home/u/.local/bin/pipeline-resolver.mjs'`;
const STALE_AL    = `alias pipeline='node /home/u/.claude/plugins/cache/x/pipeline/0.1.0/bin/pipeline.mjs'`;

// ── mergePsProfile ────────────────────────────────────────────────────────────

test("mergePsProfile: empty profile gets marker + new fn", () => {
  const out = mergePsProfile("", RESOLVER_FN);
  equal(out, `${MARKER}\n${RESOLVER_FN}\n`);
});

test("mergePsProfile: stale marker block is replaced, not duplicated", () => {
  const start = `Set-PSReadlineOption -EditMode Vi\n\n${MARKER}\n${STALE_FN}\n`;
  const out = mergePsProfile(start, RESOLVER_FN);
  match(out, /Set-PSReadlineOption -EditMode Vi/);
  equal((out.match(/function pipeline/g) || []).length, 1, "exactly one function pipeline definition");
  match(out, /pipeline-resolver\.mjs/);
  equal(out.includes("0.1.0"), false, "stale path stripped");
});

test("mergePsProfile: orphan function (no marker) is also stripped", () => {
  const start = `Set-Location ~\n${STALE_FN}\n# user comment\n`;
  const out = mergePsProfile(start, RESOLVER_FN);
  match(out, /Set-Location ~/);
  match(out, /# user comment/);
  equal((out.match(/function pipeline/g) || []).length, 1);
  equal(out.includes("0.1.0"), false);
});

test("mergePsProfile: idempotent — second merge yields same content", () => {
  const once  = mergePsProfile("Some-Cmdlet\n", RESOLVER_FN);
  const twice = mergePsProfile(once, RESOLVER_FN);
  equal(twice, once);
});

test("mergePsProfile: CRLF input normalised to LF in output", () => {
  const out = mergePsProfile("first\r\nsecond\r\n", RESOLVER_FN);
  equal(out.includes("\r"), false);
  match(out, /first\nsecond/);
});

test("mergePsProfile: variant marker (e.g. PS 5.1 suffix) is stripped on merge", () => {
  const variantMarker = "# pipeline (added by setup — PS 5.1)";
  const start = `Set-Location ~\n\n${variantMarker}\n${STALE_FN}\n`;
  const out = mergePsProfile(start, RESOLVER_FN);
  match(out, /Set-Location ~/);
  equal((out.match(/function pipeline/g) || []).length, 1, "exactly one function pipeline");
  match(out, /pipeline-resolver\.mjs/);
  equal(out.includes("0.1.0"), false, "stale path stripped");
  equal(out.includes(variantMarker), false, "variant marker stripped");
  match(out, new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "canonical marker present");
});

// ── mergeUnixRc ───────────────────────────────────────────────────────────────

test("mergeUnixRc: empty rc gets marker + alias", () => {
  const out = mergeUnixRc("", RESOLVER_AL);
  equal(out, `${MARKER}\n${RESOLVER_AL}\n`);
});

test("mergeUnixRc: stale marker block replaced", () => {
  const start = `export PATH=$PATH:~/.local/bin\n\n${MARKER}\n${STALE_AL}\n`;
  const out = mergeUnixRc(start, RESOLVER_AL);
  match(out, /export PATH=/);
  equal((out.match(/alias pipeline=/g) || []).length, 1);
  equal(out.includes("0.1.0"), false);
});

test("mergeUnixRc: orphan alias (no marker) stripped", () => {
  const start = `# user shell\n${STALE_AL}\nexport FOO=1\n`;
  const out = mergeUnixRc(start, RESOLVER_AL);
  match(out, /# user shell/);
  match(out, /export FOO=1/);
  equal((out.match(/alias pipeline=/g) || []).length, 1);
  equal(out.includes("0.1.0"), false);
});

test("mergeUnixRc: idempotent", () => {
  const once  = mergeUnixRc("export FOO=1\n", RESOLVER_AL);
  const twice = mergeUnixRc(once, RESOLVER_AL);
  equal(twice, once);
});

// ── applyPsProfiles ───────────────────────────────────────────────────────────

const TMP_BASE = join(tmpdir(), "pipeline-test-ps-profiles");

test("applyPsProfiles: writes to both profiles when both shells present", () => {
  const p1 = join(TMP_BASE, "ps7-both", "Microsoft.PowerShell_profile.ps1");
  const p2 = join(TMP_BASE, "ps51-both", "Microsoft.PowerShell_profile.ps1");
  mkdirSync(join(TMP_BASE, "ps7-both"),  { recursive: true });
  mkdirSync(join(TMP_BASE, "ps51-both"), { recursive: true });

  const messages = [];
  applyPsProfiles(
    [{ exe: "pwsh", path: p1 }, { exe: "powershell", path: p2 }],
    RESOLVER_FN,
    msg => messages.push(msg),
  );

  match(readFileSync(p1, "utf8"), /pipeline-resolver\.mjs/);
  match(readFileSync(p2, "utf8"), /pipeline-resolver\.mjs/);
  equal(messages.filter(m => m.startsWith("✓")).length, 2, "two success messages");
});

test("applyPsProfiles: writes only to the one profile when one shell present", () => {
  const p = join(TMP_BASE, "ps7-only", "Microsoft.PowerShell_profile.ps1");
  mkdirSync(join(TMP_BASE, "ps7-only"), { recursive: true });

  const messages = [];
  applyPsProfiles([{ exe: "pwsh", path: p }], RESOLVER_FN, msg => messages.push(msg));

  match(readFileSync(p, "utf8"), /pipeline-resolver\.mjs/);
  equal(messages.filter(m => m.startsWith("✓")).length, 1, "one success message");
});

test("applyPsProfiles: surfaces manual fallback when no shells present", () => {
  const messages = [];
  applyPsProfiles([], RESOLVER_FN, msg => messages.push(msg));

  equal(messages.length, 1);
  match(messages[0], /No PowerShell found/);
  match(messages[0], /Add this to your shell profile manually/);
  match(messages[0], /pipeline-resolver\.mjs/);
});

test("applyPsProfiles: idempotent — second run yields exactly one definition per profile", () => {
  const p = join(TMP_BASE, "idempotent", "Microsoft.PowerShell_profile.ps1");
  mkdirSync(join(TMP_BASE, "idempotent"), { recursive: true });
  const profiles = [{ exe: "pwsh", path: p }];

  applyPsProfiles(profiles, RESOLVER_FN);
  applyPsProfiles(profiles, RESOLVER_FN);

  const c = readFileSync(p, "utf8");
  equal((c.match(/function pipeline/g) || []).length, 1, "exactly one definition after two runs");
  equal((c.match(/# pipeline \(added by setup\)/g) || []).length, 1, "exactly one marker");
});
