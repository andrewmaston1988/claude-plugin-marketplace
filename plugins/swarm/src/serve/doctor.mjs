// The `serve doctor` verb, whole: the daemon's own checks plus a probe row per
// provider the config has switched ON, so the evidence setup asks its enable
// question from is available outside setup too.
//
// Apart from daemon.mjs so that module stays out of the provider graph (config,
// quota, network) — it is the plumbing every serve verb and the daemon itself
// import, and none of them runs a probe.
import { doctorChecks, doctorExit, defaultStartupDir, readPid, isAlive } from "./daemon.mjs";
import { defaultProviderRegistry } from "../default-providers.mjs";
import { probeProvider } from "../providers.mjs";

// `home`, `installed`, `port` and `cfg` are the daemon's, already resolved by the
// caller — this only decides what a doctor run reports.
export async function runDoctor({ home, installed, port, cfg, shimPath, out, startupDir = defaultStartupDir() }) {
  const rec = readPid(home);
  const registry = defaultProviderRegistry();
  const checks = await doctorChecks({
    record: rec, alive: isAlive(rec?.pid), installed, port,
    bind: cfg.dashboard?.bind ?? "0.0.0.0", startupDir, shimPath,
    // Switched ON only: a provider that is on and cannot dispatch is the thing worth
    // reporting, and one that is off is not making a claim anyone needs checked.
    providers: registry.list().filter((a) => a.enabled(cfg)).map((a) => a.id),
    config: cfg,
    _probeProvider: (id, opts) => probeProvider(id, { ...opts, registry, env: process.env }),
  });
  for (const c of checks) out(`${c.status === "pass" ? "✓" : c.status === "unknown" ? "⚠" : "✗"} ${c.name}: ${c.detail}`);
  const code = doctorExit(checks);
  out(code ? `${checks.filter((c) => c.status === "fail").length} check(s) failed` : "all checks passed");
  return code;
}
