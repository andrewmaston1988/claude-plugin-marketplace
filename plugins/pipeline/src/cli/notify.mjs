import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishNotification } from "../../scripts/publisher.mjs";
import { getFlag } from "./helpers.mjs";

const FOOTER = "\n" + ":black_small_square:".repeat(14) + "\n";

export async function run(cmd, argv) {
  if (cmd !== "notify") return null;

  const title       = getFlag("--title",        argv);
  const message     = getFlag("--message",      argv);
  const messageFile = getFlag("--message-file", argv);
  const priority    = getFlag("--priority",     argv) || "default";
  const dryRun      = argv.includes("--dry-run");

  if (!title) {
    process.stderr.write("--title is required\n");
    return 1;
  }
  if (!message && !messageFile) {
    process.stderr.write("--message or --message-file required\n");
    return 1;
  }

  // Footer kept for historical readability; integrations that forward the
  // envelope body preserve it verbatim.
  let tmpPath = null;
  try {
    const body = messageFile ? readFileSync(messageFile, "utf8") : (message || "");
    tmpPath = join(tmpdir(), `pipeline-notify-${process.pid}.txt`);
    writeFileSync(tmpPath, body.trimEnd() + FOOTER, "utf8");
    const ok = await publishNotification(
      { title, messageFile: tmpPath, priority },
      { dryRun }
    );
    if (ok) process.stdout.write("OK\n");
    return ok ? 0 : 1;
  } finally {
    if (tmpPath) try { unlinkSync(tmpPath); } catch {}
  }
}
