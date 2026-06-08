// Pipeline event emitter — fan-out to a chain of handlers with per-handler isolation.
// Event wire shape (matches Phase 1 audit §6 — 4 caller fields):
//   { title, message | message_file, priority, channel }
// Emitter adds `timestamp` at emit time so callers never have to.
//
// Handler contract: each handler in the array exposes an async `handle(event)`.
// One handler throwing must NOT prevent subsequent handlers from being called.

export function createEmitter({ handlers = [] } = {}) {
  return {
    async emit(event) {
      const stamped = { ...event, timestamp: new Date().toISOString() };
      for (const h of handlers) {
        try {
          await h.handle(stamped);
        } catch (err) {
          process.stderr.write(`[pipeline emitter] handler threw: ${err?.message ?? String(err)}\n`);
        }
      }
    }
  };
}
