---
name: model-selection
description: >-
  Use when pinning a Claude model — `claude -p` call sites, or pipeline row
  model columns at `/queue` time. Triggers — editing a file containing
  `claude -p`; the `/queue` command (loads this explicitly); "which model for
  X"; about to write model ID to a pipeline column. SKIP for: `/model` session
  switcher; reading the model table.
---

<HARD-GATE>
**When a plan has no model annotation and you're queuing it, YOU MUST recommend a specific model and get the user to confirm before proceeding.** Do not queue silently with defaults. Read the plan, reason about scope/complexity, recommend (Haiku/Sonnet/Opus), prompt the user to confirm or override, then return the choice to the queue skill.
</HARD-GATE>

# Model selection

Two contexts need explicit model decisions: `claude -p` callers (scripts spawning Claude subprocesses) and pipeline rows (per-stage model pins read by the orchestrator). Both must pin a model — no implicit defaults — and both default toward the cheapest tier that can do the job.

## Tier guide

Use this for both `claude -p` and pipeline-row decisions. Model IDs are config-driven — run `pipeline doctor` to see the live values for this install.

- **Haiku tier** (whatever `cfg.tiers.haiku` resolves to) — micro-summarisation, JSON extraction from deterministic prompts, one-liner annotations, commit-message bodies, plan Current-Status line rewrites, pattern-fill. Fast, cheap, weak at independent reasoning. Avoid when the task asks for synthesis or skeptical analysis — Haiku will pattern-match the prompt's examples instead of doing the work.
- **Sonnet tier** (whatever `cfg.tiers.sonnet` resolves to) — single-file judgement, most dev sessions, single-row pipeline reasoning, governor cache analysis. The default for any task that needs real reasoning.
- **Opus tier** (whatever `cfg.tiers.opus` resolves to) — cross-file architectural reasoning, multi-branch doc-impact assessment, cross-row priority ranking, research sessions, dev sessions with behavioural-equivalence constraints. Reserved; high cost.

## Choosing effort given model

Once you've picked a model, effort fine-tunes the reasoning depth. The same model+effort combo is often cheaper and more effective than upgrading the model tier:

- **Sonnet+max** (deeper thinking on Sonnet) often costs less and reasons better than **Opus+low** for tasks where reasoning depth, not raw capability, is the bottleneck.
- **Haiku+max** often matches **Sonnet+low** in cost and quality for mechanical-with-judgment tasks.

**Key principle:** escalate effort first within a model tier before jumping tiers. Cheaper, cleaner, and avoids the cost penalty of model jumps.

### Effort levels (low→max)

- **low** — quick mechanical work (formatting, linting, status queries, proof-of-work runs)
- **medium** — default for most work; balanced reasoning
- **high** — cross-file invariants, interface design, multi-step debugging
- **xhigh** — for hard cases; between high and max; rare
- **max** — depth-bound reasoning; you've tried shallower and it didn't work

### Per-tier supported effort levels

Not every effort level is valid for every model tier. Pinning an unsupported level causes a runtime API rejection.

| Tier | Supported levels | Notes |
|---|---|---|
| Haiku | `low`, `medium`, `high` | No `xhigh`, no `max` |
| Sonnet | `low`, `medium`, `high`, `max` | No `xhigh` |
| Opus / Fable | `low`, `medium`, `high`, `xhigh`, `max` | Full scale |

The pipeline's escalation logic (`src/orchestrator/spawn.mjs`) honours this asymmetry. The queue command currently does not — a (model, effort) pair that passes the queue form will fail at spawn time if the combination is unsupported. The live matrix is `cfg.tier_efforts` — run `pipeline doctor` to see supported levels for each tier on this install.

## `claude -p` call sites

**No `claude -p` call may rely on the CLI's implicit default.** Every caller pins a model explicitly via `--model <id>`.

When a `claude -p` call site needs a new pin, inline it at the call site (no central config). The pin is part of the script's intent — keep it adjacent to the prompt, not split across files.

## Pipeline-row models

Model selection for pipeline rows is a **human decision made at `/queue` time**. Three stage-specific columns (`R-Model`, `D-Model`, `Q-Model`) must be pinned for each row before the orchestrator can spawn any session.

- `R-Model` — model for research session (use `—` if research stage is skipped).
- `D-Model` — model for development session.
- `Q-Model` — model for QA/test session.
- `Rvw-Model` — model for the autonomous review session (between dev and test). **Default Sonnet** (judgement-heavy design review on a fresh diff; Haiku rubber-stamps, Opus is overkill for most diffs). **Elevate to Opus** when `D-Model` is Opus, OR when the diff has cross-module / security / concurrency / architectural implications (same Opus gate below). **Drop to Haiku** only for mechanical / prose-only diffs (CLAUDE.md edits, docs, single-line config).

The orchestrator reads these columns mechanically: if a stage's model column is `—` or empty, the row is skipped with an ERROR log (no silent defaults, no escalation). Don't try to be clever; if a stage isn't running, the column is `—`.

### Effort columns (r_effort, d_effort, q_effort, rvw_effort)

Per-role effort pins to support fine-tuning within model tiers.

- `R-Effort` — effort for research session. **Default high.**
  - Research benefits from deeper reasoning to surface non-obvious sources and connections.
  - Rarely downgraded; only when the research scope is well-bounded and mechanical.

- `D-Effort` — effort for development session. **Default medium.**
  - Downgrade to low only for provably mechanical work.
  - Elevate to high/xhigh/max for plans with cross-file invariants or complex interface design.
  - See `/pipeline:queue` Step 2a for operator decision guidance.

- `Q-Effort` — effort for QA/test session. **Default low.**
  - Most test automation is mechanical (run suite, check outcomes).
  - Elevate to medium/high only if test interpretation or edge-case reasoning is required.

- `Rvw-Effort` — effort for the autonomous review session. **Default high.**
  - Review sessions are judgement-heavy; depth matters for catching real blockers.
  - Auto-escalation does NOT walk `rvw_effort` on review retries — review effort is queue-time-pinned. A stuck review is more likely a stuck dev path than an under-powered reviewer.
  - Elevate to max when the diff has security, concurrency, or cross-module implications.
  - Drop to medium only for mechanical / prose-only diffs.

When paired with model, effort allows cost-conscious tuning: `(model, effort)` is a 2D grid, not a 1D tier list.

## Opus gate

**Opus requires explicit human confirmation** in the interactive `/queue` session before writing to a pipeline-row column. Never write the Opus model ID to a model column without receiving a clear "yes" from the user. The same applies to bumping a `claude -p` call site to Opus — surface the cost increase and the reasoning, get confirmation, then edit.

If the user says "Sonnet" when you proposed Opus, that's a Sonnet decision — don't argue. The whole reason for the gate is that Opus is the default-no model.

## Anti-patterns to refuse

- **Implicit default.** Any `claude -p` invocation without `--model <id>` is a bug — pin it before merging.
- **Silent escalation.** Bumping a script from Haiku → Sonnet → Opus without surfacing the cost change. Always say what tier and why.
- **Defaulting Opus.** "Just use Opus to be safe" — Opus is rarely the right answer. Sonnet is the floor for reasoning tasks; Opus is the ceiling for cross-cutting ones.
- **Defaulting Haiku for analysis.** Haiku is for mechanical work. Asking it to "be skeptical" or "synthesise" produces template-imitation, not analysis — learned the hard way on the governor-cache-calibration work.
- **Pipeline-row model written without `/queue`.** Manually setting model columns via DB writes bypasses the human-decision gate — use `/queue`.
- **Pinning an effort level the model doesn't support.** For example, `--effort xhigh` on Haiku or `--effort xhigh` on Sonnet. The API rejects this at runtime; see per-tier supported effort table above. Doctor check pending.

## Why this skill exists

Model choice has high leverage on both cost and quality. Without explicit guidance, scripts default to whatever model name was at the top of the model docs at the time of writing, which drifts, gets stale, and silently degrades when a new model lands. Pinning every call site keeps the system inspectable; the tier guide here is the canonical reference for which tier is right for what kind of task.

## Non-Anthropic models (Ollama / gemma / MiniMax / open model)

The pipeline is not Anthropic-only. Any model the local proxy can serve — Ollama-served models, cloud endpoints fronted by an Anthropic-format proxy, anything reachable through `cfg.proxy.url` — is a valid row model. The Anthropic path (`model.startsWith("claude-")`) is unaffected; this is **additive**, not a replacement.

### Routing rule

`proxyEnvFor(model)` in `src/orchestrator/spawn.mjs` returns `{}` for `claude-*` models (no env override — they go straight to `api.anthropic.com`). For any other model name, it returns:

```js
{
  ANTHROPIC_BASE_URL: cfg.proxy.url,        // default "http://localhost:18081"
  ANTHROPIC_API_KEY:  cfg.proxy.auth_token, // default "dummy-local-key"
  ANTHROPIC_MODEL:    model,                // passed through verbatim
}
```

`ANTHROPIC_BASE_URL` redirects the SDK's outbound calls; the proxy then translates Anthropic Messages format to whatever upstream it knows about (Ollama, OpenAI-compatible, etc.). The proxy's `OPENAI_BASE_URL` is its own concern — the pipeline just hands it the model name.

### Operator setup

Non-Anthropic models route through `cfg.proxy.url` in `~/.pipeline/config.json`. Ensure the proxy is running before queueing a row with a non-Anthropic model.

Model names are **lowercase only** (e.g., `minimax-m3:cloud`, `gemma4:31b-cloud`, `qwen2.5-coder:32b`).

### Auto-escalation — effort only

Non-Anthropic models escalate **effort only** on dev retry (no tier jump). `tierFromModel` returns `null` for anything that doesn't match `/haiku|sonnet|opus/i`, so auto-escalation uses Opus-shaped effort defaults: `low` → `medium` → `high` → `xhigh` → `max` (+2 per retry, clamped to max). Many non-Anthropic models (e.g., minimax-m3) respond meaningfully to effort changes; escalation can improve results even though the scale is Anthropic-tuned. If a non-Anthropic row bounces through review, pin a new model in the row's `notes_extra` (`model=…`) or in `*Dev-Model:*` and re-queue.

### When the operator asks to queue via non-Anthropic model

When the user's request contains phrases like "via ollama", "via open model", "local model", or names a specific non-Anthropic model (e.g., `minimax-m3:cloud`, `gemma4:31b-cloud`, `qwen2.5-coder:32b`), confirm the model name and collect it for the queue command:

1. **Confirm intent + collect model name** — "You asked to queue this with a non-Anthropic model. What's the exact model name? (e.g., `minimax-m3:cloud`, `gemma4:31b-cloud`, `qwen2.5-coder:32b`). The row will route through the proxy configured in `~/.pipeline/config.json`. Auto-escalation is a no-op for non-Anthropic models."

Then construct the `pipeline queue-plan` command with `--d-model <name>` (and the corresponding R/Q/Rvw columns if the row uses non-Anthropic models for those stages too). Proxy setup and verification belong in the `/queue` skill.
