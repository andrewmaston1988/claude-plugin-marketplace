// Load hook for the store-read count (row 9). Appends a wrapper to scores.mjs's
// own source that re-points its readRows export (a function declaration's
// binding is mutable from inside the module) to emit one SWARM_STORE_READ
// marker on stderr per call that actually opens the store. The existsSync
// guard — the same check readRows itself makes — keeps a missing store file at
// zero, so the silent cases stay zero-read.
const TAIL = ";{const __raw = readRows; readRows = (...a) => { if (existsSync(a[0])) globalThis.process.stderr.write('SWARM_STORE_READ' + String.fromCharCode(10)); return __raw(...a); };}";

export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.endsWith("/swarm/src/scores.mjs")) {
    const src = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
    return { ...result, source: src + TAIL };
  }
  return result;
}