// File event handler — append-only JSONL log at ~/.pipeline/events.log by default.
// Used as the always-present durable fallback in the handler chain (Phase 5 wires this).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function createFileHandler({ logPath } = {}) {
  const resolved = logPath ?? join(homedir(), ".pipeline", "events.log");
  return {
    async handle(event) {
      mkdirSync(dirname(resolved), { recursive: true });
      appendFileSync(resolved, JSON.stringify(event) + "\n");
    }
  };
}
