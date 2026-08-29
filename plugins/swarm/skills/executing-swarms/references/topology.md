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
it depends on. The named task must be a declared dependency, worktree-isolated, and able to
WRITE — `validate` says so if not.

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
