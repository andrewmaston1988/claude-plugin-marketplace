// A shipped plugin must not carry one operator's network. Fixtures address documentation ranges
// (192.0.2.0/24) or loopback; this walk is what keeps that true.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const TEXT = /\.(mjs|js|json|md|html|ya?ml|txt)$/i;

// RFC 1918 private ranges: 10/8, 172.16/12 and 192.168/16.
const LAN_ADDRESS = /(?<![\d.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}(?![\d.])/;

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(full));
    } else if (TEXT.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("no private LAN address ships in the plugin", () => {
  const offences = [];
  for (const file of walk(ROOT)) {
    if (file === SELF) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = LAN_ADDRESS.exec(line);
      if (match) offences.push(`${file}:${index + 1}: ${match[0]}`);
    });
  }
  assert.deepEqual(offences, [], "use 192.0.2.x or 127.0.0.1 in fixtures");
});

test("the LAN pattern catches the private ranges and leaves the documentation range alone", () => {
  for (const address of ["192.168.1.110", "10.0.0.5", "172.16.4.4", "172.31.255.1"]) {
    assert.match(address, LAN_ADDRESS, address);
  }
  for (const address of ["192.0.2.10", "127.0.0.1", "8.8.8.8", "172.32.0.1", "10.0.3497.128"]) {
    assert.doesNotMatch(address, LAN_ADDRESS, address);
  }
});
