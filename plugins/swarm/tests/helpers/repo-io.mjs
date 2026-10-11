import { loadManifest as realLoadManifest } from "../../src/manifest.mjs";

// Each test's own dir stands in as its repo; an `io` the test passes still wins.
// `mcpTools` is stubbed for the same reason: the real reader opens ~/.claude.json,
// which isolate-home does not hide.
export function loadManifest(path, cfg, cwd = process.cwd(), opts = {}) {
  const repoToplevel = opts.io?.repoToplevel || (() => cwd);
  const repoLookup = opts.io?.repoLookup || ((dir) => {
    const repo = repoToplevel(dir);
    return repo ? { repo } : { none: "not-a-repo" };
  });
  return realLoadManifest(path, cfg, cwd, {
    ...opts,
    io: { repoToplevel, repoLookup, checkoutToplevel: () => cwd, mcpTools: () => [], ...opts.io },
  });
}
