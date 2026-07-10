# discipline — per-model discipline deltas

Injects a short behavioral addendum ("discipline pack") into every user prompt,
**keyed on the running model**. Ships with a Sonnet 5 pack targeting its four
measured failure modes; other models run untouched. Includes the measurement
tooling: a mechanical baseline scanner over session transcripts and a blind
judge grader, so the pack's effect is benchmarked rather than assumed.

Design record: `repos/claude-plugin-marketplace/plans/sonnet5-discipline.md`
(CLAUDE repo).

## Why a hook, not a skill

Discipline behaviors are dispositions, not workflows. A skill must be invoked
at the right moment — and the model that most needs the discipline is the least
likely to recognize that moment (trigger recursion). The `UserPromptSubmit`
hook injects unconditionally, so compliance never depends on the model's own
judgment. Plugins auto-wire their hooks: enabling the plugin is the entire
installation.

## What gets injected (Sonnet 5 pack)

`disciplines/sonnet-5.md`, ~150 tokens, five rules:

1. **Verify before claiming** — "fixed/done/works/passing" only after running it this session.
2. **Provenance tagging** — distinguish executed / read / assumed when stating behavior.
3. **Evidence-gated pushback** — corrections answered with a fresh check, not restated reasoning.
4. **Redundancy brake** — don't re-check what can't have changed.
5. **Coverage-first review reporting** (review contexts only).

## How model keying works

`hooks/inject.mjs` on every prompt:

1. Model = last assistant `message.model` in the session transcript; falls back
   to the settings.json `model` alias on a session's first prompt.
2. Ordered substring map (`FAMILY_FILES`) picks a file from `disciplines/`
   (e.g. `claude-sonnet-5*` → `sonnet-5.md`). **No matching file → no output** —
   that is how Fable/Opus/unlisted models run clean.
3. Output is wrapped in `<discipline-pack model="..." v="1">…</discipline-pack>`.
   The wrapper is load-bearing: the grader strips it (blind adjudication) and
   the scanner reads it (arm detection in A/B comparisons).

Never blocks a prompt: every failure path exits 0 silently.

**Kill switch / control arm:** set `CLAUDE_DISCIPLINE=off` in the environment
to disable injection for that process (per-row A/B assignment in pipelines).

## Measuring whether it works

Baseline first, then compare — historical sessions without the pack are the
control arm; the scanner splits by arm automatically via the wrapper marker.

```sh
# candidate extraction (mechanical, stdlib Python; upper bounds by design)
python tools/discipline_scan.py --days 60 --out candidates.jsonl

# blind judge adjudication (judge pin is REQUIRED — no default; Fable recommended,
# a same-family judge grading Sonnet transcripts risks affinity bias)
python tools/discipline_grade.py --candidates candidates.jsonl \
    --model claude-fable-5 --limit 50 --out verdicts.jsonl
```

Metrics: UDC (unverified done-claim), UCA (unverified confident assertion),
RWV (rebuttal-without-verification), RSV (redundant self-verification).
Definitions live in `disciplines/grading-rubric.md`.

2026-07-10 baseline (60 days, 555 sonnet sessions, candidates per 100 assistant
messages): UDC 3.51 on Sonnet 5 vs 3.04 on Sonnet 4.6; RSV 10.52 vs 8.27.

## Adding a model

Add `disciplines/<family>.md` and a matching substring entry to `FAMILY_FILES`
in `hooks/inject.mjs`. Choose substrings that can't collide across version
families (`sonnet-5` deliberately does not match `claude-sonnet-4-5`). Keep
packs under ~200 tokens — they are re-injected on every prompt.

## Tests

```sh
cd hooks && node --test
```

Covers: injection on sonnet-5, clean pass-through for fable / sonnet-4-5,
kill switch, keepalive-tick skip, missing transcript, garbage stdin.
