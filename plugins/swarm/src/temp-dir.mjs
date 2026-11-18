// Every temp dir swarm's tests and probes mint sits under one `<tmpdir>/swarm` parent,
// so leftovers are findable and sweepable in one place. The parent is never removed.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function swarmTempDir(prefix, { _tmpdir = tmpdir } = {}) {
  const parent = join(_tmpdir(), "swarm");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
}
