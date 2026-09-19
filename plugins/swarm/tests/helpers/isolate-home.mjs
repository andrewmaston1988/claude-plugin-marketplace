// Preloaded by `npm test` (--import): points SWARM_HOME at a throwaway dir so no
// test that forgets to isolate can write runs, scores or caches into the real
// ~/.swarm. Child processes (node --test workers, CLI spawns) inherit it.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!process.env.SWARM_HOME) process.env.SWARM_HOME = mkdtempSync(join(tmpdir(), "swarm-test-home-"));
