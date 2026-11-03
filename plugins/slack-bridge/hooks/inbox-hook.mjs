// PostToolBatch entry. Not a bin/claude-slack.mjs subcommand: that graph costs a
// few hundred ms to load, and this blocks every tool batch in every session.
import { runInboxHook } from "../src/remote/inbox-hook.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
// No exit timer: it would hold every batch for its length. The write and the ack
// are awaited, so the natural exit loses neither.
await runInboxHook({ raw });
