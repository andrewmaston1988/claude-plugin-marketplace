# Topology field semantics — `after`, `isolation.from`, `integrate`

Read this when a manifest's width changes more than once: a fan-out feeding a shared step,
private trees seeded from another task's branch, or branches folded back together. The shapes
themselves are in `SKILL.md`; what follows is the field-by-field detail those shapes depend on.

## `{{result:}}` / `{{resultPath:}}` reach only a DIRECT dependency

In a wide graph the task you want is often a grandparent — `migrate-x` needs the survey, but
its `after` names only `helper`. Referencing it anyway fails validation; add the upstream id to
`after` too (`["helper", "survey-a"]`). The extra edge changes no ordering, it declares what the
prompt reads.

## A private tree branches from repo HEAD unless you say otherwise

`"from": "<task id>"` bases it on that task's branch instead, so the leaf starts with the code
it depends on. `validate` rejects a source that can end without ever committing — a branch that
was never created cannot be based on. `isolation.from` must name a task that:

- **is a declared dependency** — in this leaf's `after`, so its branch is guaranteed to exist by
  the time this leaf starts;
- **has an `isolation` block** — a task with none runs in the shared checkout, never gets a
  worktree, and so never gets a branch;
- **is not `when`-gated** — a false gate skips the task before its worktree is created, so the
  branch may never exist; and
- **holds write tools** — see "A task only owns a branch if it COMMITS" below; the same
  reasoning `integrate.from` uses applies here.

**A `skipped` source is the live failure this guard catches.** A skipped task never runs its
body, so even one with an `isolation` block leaves no branch behind if its gate — or an
upstream failure — skipped it. Before this guard existed, tasks naming a skipped source as
`from` did not fail at `validate`: `prepareIsolation` resolved `baseRef` however its fallback
happened to work out, and leaves reported success built on the wrong code. The run-time
backstop closes the gap `validate` cannot: if `baseRef` is ever handed to `prepareIsolation` and
does not resolve — the source's branch never existed, or existed and was later cleaned up — it
throws instead of falling back, and the leaf fails loudly rather than quietly building on the
wrong base.

## `from` names a TASK that commits, not the STAGE this leaf follows

Ordering is what `after` expresses; `from` answers a narrower question — whose branch carries
the code. In a fan-out → review → fan-out shape those are different tasks by construction: the
last task in a stage is usually a reviewer, and a reviewer owns no branch, so `from` must reach
*past* it to the last writer. Pass the reviewer's findings as information instead:

```json
{ "after": ["review", "extract"],
  "isolation": { "worktree": "impl", "from": "extract" },
  "prompt": "The reviewer reported: {{result:review}} …" }
```

`from` is where the CODE comes from; `{{result:X}}` is where the INFORMATION comes from.

## A task only owns a branch if it COMMITS

A leaf that changes no files has its worktree reaped, and `from` naming it fails at runtime with
`cannot resolve base`. `validate` rejects the provable case — a source with no write tools at
all. It cannot catch a reviewer holding `Bash` to run a test suite: that reads as write-capable
but still commits nothing. **Judge by what the task DOES, not by its tool list.** If a task
exists to report rather than to change code, it is never a `from` target — and a consolidator
that only reads result files needs no worktree at all.

**An `integrate.from` source is the exception, and needs no care from you.** A leaf you told
"leave it untouched and report it" is allowed to change nothing and still be merged: its branch
survives the sweep even carrying nothing, because a merge needs the REF, not its contents —
`git merge` on an empty branch reports `Already up to date`. So a survey wave where only some
leaves find work to do is a legitimate shape, and the integrate over all of them completes.

Note the asymmetry with `isolation.from` above: `from` needs the source's *commits*, so a
source that commits nothing genuinely has nothing to offer. `integrate.from` needs only the
ref. Same word, different requirement.

## Sibling trees do not see each other

Two private trees each carry their common ancestor's work but not each other's. Fold them back
with an **`integrate`** node — agentless like `compute`, so it spends nothing — which merges each
named task's branch into `into`:

```json
{ "id": "join", "after": ["migrate-x", "migrate-y"],
  "integrate": { "into": "feat", "from": ["migrate-x", "migrate-y"] } }
```

Every id in `from` must be a task that WRITES, for the same reason `isolation.from` must be: a
read-only task has no branch to merge.

**A conflict is not a failure.** The merge stops with markers in the tree, the node stays `ok`,
and the conflicting paths land in its result — pass `{{result:join}}` to the next leaf and tell
it to resolve them. Without an integrate node that merge is the next leaf's job.

## Worktree names do not carry across manifests

The tree lives under the run's `resultsDir`, so a later manifest naming the same worktree gets a
*new* tree — and its branch `swarm/<name>` already exists, which fails. To put a tree on a
specific branch, name it: `"isolation": { "worktree": "p3", "branch": "swarm/eco-p3" }`. The
engine refuses to reset a branch carrying commits HEAD does not have, so a previous run's phases
cannot be silently discarded.

## How a verifier link works

A reviewer with no write tools still does its whole job, because its findings do not travel
through files:

- **Its output is its return value.** The engine writes every leaf's result to
  `results/<id>.json`; the next link reads it via `{{result:<reviewer-id>}}`. A reviewer never
  needs `Write` to report — it needs `Write` only to *change* things, which is the one thing it
  must not do.
- **It sees more than a fresh checkout.** Same working directory as the link before it, so it
  reads that link's commits *and* anything left uncommitted. `git log`, `git diff`, and the files
  themselves all work.
- **It never ends the chain's tree.** Collection is deferred to the group's last link, so a
  reviewer changing nothing cannot trigger the empty-tree cleanup that would delete the work its
  successor needs.
- **Giving a reviewer write tools breaks the contract silently.** It will fix things instead of
  reporting them, and `{{result:}}` then describes work the next link cannot see the reasoning
  for. Nothing in the engine prevents this — `allowedTools` is tool-name-only and a leaf holding
  `Write` can write anywhere — so the tool list is the whole mechanism.
