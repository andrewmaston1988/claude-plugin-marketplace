import { readFileSync } from "node:fs";
import { notify } from "./index.mjs";

/**
 * Parse notify flags and post a one-shot Slack message.
 * Exits 0 on success, 1 on error.
 *
 * Flags: --title, --message, --message-file, --channel, --priority (unused; reserved)
 *
 * @param {{ web, log, config, argv: string[] }} opts
 */
export async function runNotifyCli({ web, log, config, argv }) {
  const title    = getFlag("--title",        argv) ?? "Notification";
  const message  = getFlag("--message",      argv);
  const msgFile  = getFlag("--message-file", argv);
  let   channel  = getFlag("--channel",      argv);
  // --priority is accepted but not yet used

  // Positional fallback: first non-flag arg is channel, remainder is message
  const positional = argv.filter(a => !a.startsWith("-"));
  if (!channel && positional.length > 0) channel = positional[0];
  if (!channel) channel = config.slack?.notifyChannel ?? null;

  const body = message
    ?? (msgFile ? readFileSync(msgFile, "utf8").trim() : null)
    ?? positional.slice(1).join(" ")
    ?? null;

  if (!channel) {
    process.stderr.write("notify: --channel or positional <channel> is required\n");
    return 1;
  }
  if (!body) {
    process.stderr.write("notify: --message, --message-file, or positional <message> is required\n");
    return 1;
  }

  try {
    await notify({ web, channel, title, message: body, log });
    return 0;
  } catch (e) {
    process.stderr.write(`notify: ${e.message}\n`);
    return 1;
  }
}

function getFlag(name, argv) {
  const idx = argv.indexOf(name);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
