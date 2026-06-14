import { test } from "node:test";
import { equal, match } from "node:assert/strict";
import { mergePsProfile, mergeUnixRc, MARKER } from "../src/setup/wizard-profile.mjs";

const RESOLVER_FN = `function pipeline { & "node.exe" "C:\\Users\\u\\.local\\bin\\pipeline-resolver.mjs" @args }`;
const STALE_FN    = `function pipeline { & "node.exe" "C:\\Users\\u\\.claude\\plugins\\cache\\x\\pipeline\\0.1.0\\bin\\pipeline.mjs" @args }`;
const RESOLVER_AL = `alias pipeline='node /home/u/.local/bin/pipeline-resolver.mjs'`;
const STALE_AL    = `alias pipeline='node /home/u/.claude/plugins/cache/x/pipeline/0.1.0/bin/pipeline.mjs'`;

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
