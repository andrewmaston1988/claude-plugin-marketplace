import { pathToFileURL } from "node:url";

export async function loadExtensions({ paths, log, hookTimeoutMs = 250 }) {
  const loaded = [];

  for (const p of (paths ?? [])) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const ext = mod.default;
      if (!ext || typeof ext !== "object") throw new Error("default export must be an object");
      loaded.push(ext);
      log.info("loaded extension", { name: ext.name ?? p });
    } catch (e) {
      log.warn("extension failed to load", { path: p, error: e.message });
    }
  }

  if (loaded.length) {
    for (const ext of loaded) {
      if (typeof ext.selfCheck === "function") {
        try { await ext.selfCheck(); }
        catch (e) { log.warn("extension selfCheck failed", { name: ext.name, error: e.message }); }
      }
    }
  }

  return {
    async runHeartbeatAugment(ctx) { return callAll(loaded, "heartbeatAugment", ctx, log, "concat", hookTimeoutMs); },
    async runPromptInject(ctx)     { return callAll(loaded, "promptInject",     ctx, log, "concat", hookTimeoutMs); },
    async runToolVerb(ctx)         { return callAll(loaded, "toolVerb",         ctx, log, "first",  hookTimeoutMs); },
    async runResponseAugment(ctx)  { return callAll(loaded, "responseAugment",  ctx, log, "concat", hookTimeoutMs); },
    list() { return loaded.map(e => e.name ?? "(unnamed)"); },
  };
}

async function callAll(loaded, method, ctx, log, mode, timeoutMs) {
  const results = [];
  const frozenCtx = Object.freeze({ ...ctx });

  for (const ext of loaded) {
    if (typeof ext[method] !== "function") continue;
    try {
      const r = await Promise.race([
        ext[method](frozenCtx),
        new Promise((_, rej) => setTimeout(() => rej(new Error("hook timeout")), timeoutMs)),
      ]);
      if (r == null) continue;
      if (typeof r !== "string") {
        log.warn("extension hook returned non-string", { name: ext.name, method });
        continue;
      }
      if (mode === "first") return r;
      results.push(r);
    } catch (e) {
      log.warn("extension hook failed", { name: ext.name, method, error: e.message });
    }
  }

  return mode === "first" ? null : (results.length ? results.join("\n") : null);
}
