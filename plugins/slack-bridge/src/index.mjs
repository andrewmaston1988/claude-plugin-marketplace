import { loadExtensions } from "./extensions/loader.mjs";

// Set restart-note env at daemon startup — cleared after first message per session.
process.env.CLAUDE_BRIDGE_RESTARTED = new Date().toTimeString().slice(0, 8);

export async function startBridge({ config, log, web, socket, store, queue }) {
  const extensions = await loadExtensions({
    paths: config.extensions ?? [],
    log,
    hookTimeoutMs: config.extensionHookTimeoutMs,
  });
  const { startBridge: _start } = await import("./core/handler.mjs");
  return _start({ config, log, web, socket, store, queue, extensions });
}
