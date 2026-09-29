// Preloaded into a CLI child (NODE_OPTIONS --import): every fetch is appended to
// $SWARM_FETCH_LOG and answered 599, so a test reads exactly which URLs the command
// tried to reach without any of them leaving the machine.
import { appendFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  appendFileSync(process.env.SWARM_FETCH_LOG, `${input?.url ?? input}\n`);
  return { ok: false, status: 599, text: async () => "" };
};
