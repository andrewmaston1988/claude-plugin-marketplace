import { loadManifest as realLoadManifest } from "../../src/manifest.mjs";

// Each test's own dir stands in as its repo; an `io` the test passes still wins.
export function loadManifest(path, cfg, cwd = process.cwd(), opts = {}) {
  return realLoadManifest(path, cfg, cwd, { ...opts, io: { repoToplevel: () => cwd, checkoutToplevel: () => cwd, ...opts.io } });
}
