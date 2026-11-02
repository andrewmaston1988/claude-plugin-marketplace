// PostToolBatch entry. Not a bin/claude-slack.mjs subcommand: that graph costs a
// few hundred ms to load, and this blocks every tool batch in every session.
import { runInboxHook } from "../src/remote/inbox-hook.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const touched = await runInboxHook({ raw });
if (touched) setTimeout(() => process.exit(0), 150);
