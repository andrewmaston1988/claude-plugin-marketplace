// The manifest's seats and what the graded record says about them: the block
// `swarm validate` prints, and the refusals that make it exit 1. One store read
// feeds both, so the line a reader sees and the verdict that stops the run can
// never name different dominators.

import { identityOf, identityKey } from "./contracts.mjs";
import { isAgentless } from "./manifest-task-policy.mjs";
import { matchDenylist } from "./manifest-model-gates.mjs";
import { modelRoster, providerEnabled, visibleProviderModels } from "./roster.mjs";
import { collapseRoster } from "./discovery.mjs";
import { defaultProviderRegistry } from "./default-providers.mjs";
import { providerConfig } from "./providers.mjs";
import { costSettings, meterCostRows } from "./cost-settings.mjs";
import { readRows, scoresPath } from "./scores.mjs";
import { seatRefusals, seatReport, seatableFrontier } from "./seats.mjs";

// Distinct seats in manifest order, each with its leaf ids — the walk
// leafCounts uses (agentless skipped, childPlan descended), ids instead of
// counts. A forEach lane names its template id: the per-item instances do not
// exist yet at validate time. `models` feeds the block (one row per model);
// `seats` is one entry per task, because a seatReason belongs to a task.
export function seatedModels(plan) {
  const byModel = new Map();
  const seats = [];
  const add = (value, leaf, extra = {}) => {
    const identity = identityOf(value);
    if (!identity.model) return;
    const reason = typeof value.seatReason === "string" && value.seatReason.trim()
      ? value.seatReason.trim() : undefined;
    seats.push({ identity, leaf, seatReason: reason, ...extra });
    const key = identityKey(identity);
    if (!byModel.has(key)) byModel.set(key, { identity, leaves: [], reason: undefined });
    const model = byModel.get(key);
    model.leaves.push(leaf);
    if (model.reason === undefined) model.reason = reason;
  };
  const addTask = (t) => {
    if (isAgentless(t)) return;
    add(t, t.id);
    // A fallback is a real seat when quota forces it, and the task's own reason
    // covers both seats.
    if (typeof t.fallbackModel === "string") {
      add({ provider: t.fallbackProvider, model: t.fallbackModel, seatReason: t.seatReason }, `${t.id} fallback`);
    }
  };
  for (const t of plan.tasks) {
    if (t.childPlan) {
      for (const c of t.childPlan.tasks) addTask(c);
      continue;
    }
    addTask(t);
  }
  if (plan.digest?.model) add(plan.digest, "digest", { digest: true });
  return {
    models: [...byModel.values()].map(({ identity, leaves, reason }) => ({
      ...(identity.provider ? { provider: identity.provider } : {}),
      model: identity.model,
      leaves,
      ...(reason ? { seatReason: reason } : {}),
    })),
    seats,
  };
}

// The launchable roster `swarm models` prints, from the roster the one reader
// serves — never a fresh probe: validate must not gain a network call.
export async function launchableRoster(cfg, { env = process.env, registry = defaultProviderRegistry() } = {}) {
  const isDenylisted = (name) => !!matchDenylist(name, cfg);
  const cached = modelRoster({ config: cfg, env, registry }).models;
  const enabled = collapseRoster(cached.filter((m) => providerEnabled(registry, cfg, m)),
    { cloudSuffix: providerConfig(cfg, "ollama")?.cloudSuffix });
  const visible = new Set(visibleProviderModels(enabled, { isDenylisted }).map(identityKey));
  const offered = enabled.filter((m) => !isDenylisted(m.model));
  return offered.filter((m) => visible.has(identityKey(m)));
}

// Silent when grading is off or the store is empty — a user who has never
// graded meets nothing — and the store read is skipped in both cases, not just
// the print.
export async function seatCheck(plan, cfg) {
  if (cfg.grading?.enabled !== true) return { lines: [], refusals: [] };
  const { models, seats } = seatedModels(plan);
  if (!models.length) return { lines: [], refusals: [] };
  const rows = readRows(scoresPath());
  if (!rows.length) return { lines: [], refusals: [] };
  const costRows = await meterCostRows();
  const roster = await launchableRoster(cfg);
  const settings = await costSettings(cfg);
  const seatable = seatableFrontier({ seats, rows, costRows, roster, ...settings });
  return {
    lines: seatReport({ models, seatable, rows, costRows, roster, ...settings }),
    refusals: seatRefusals({ seats, seatable }),
  };
}
