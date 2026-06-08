---
name: pipeline-demo
description: Use when the user is new to the plugin and wants a narrated, hands-on walkthrough — Claude spins up a self-contained sandbox in the background (no real Claude install, no risk to real projects) and narrates each pipeline transition in near-real-time while the user watches the dashboard. Triggers — "/pipeline-demo", "show me how the pipeline works", "demo mode". SKIP for — real project workflow (use /queue), debugging an existing pipeline (use /pipeline).
argument-hint: (no arguments)
---

Drive a narrated walkthrough of the pipeline. Claude engineers all the commands in the background — the user never has to type a `pipeline …` line. Claude tails a structured event stream from the demo process and posts one short paragraph in the conversation for each event, in a light first-person voice ("I'm queueing X now since it has no deps…"). The user watches the dashboard for the visual; the conversation supplies the *why*.

**Tone**: warm, conversational, a touch of roleplay — Claude narrates as if Claude were the one driving the queue. Avoid condescension; the user is a peer who just wants to understand what's moving and why.

**Verbosity**: middle-ground. One short paragraph per event. Mention what's happening AND what to look for in the UI (which panel, which spinner, which note). Skip pure animation events.

## Step 0 — Precondition

Confirm `pipeline` resolves:

```bash
pipeline --version
```

If it errors with command-not-found: hand off to `/pipeline-setup` and resume here once setup reports success.

## Step 1 — Start the dashboard (background, hidden from the user)

```bash
pipeline dashboard web
```

Background bash task. Wait for the line `pipeline dashboard web: http://localhost:8765/pipeline` in its output, then continue.

## Step 2 — Start the demo (background, hidden from the user)

```bash
pipeline demo
```

Background bash task. The demo:
- provisions a throwaway git project + 4 plan files
- creates the main row + 3 dependent rows in the pipeline DB
- walks the rows through their stages on a deterministic ~10-minute timeline
- emits structured `[event]` lines to stdout at every transition

**Do not** show the user the `pipeline demo` invocation. The user invoked `/pipeline-demo` — that's the only command they need to know.

## Step 3 — Tell the user to open a dashboard

Once both background tasks are alive, post a single short message:

> "Sandbox is up. Open **http://localhost:8765/pipeline** in your browser, or run `pipeline dashboard tui` in another terminal if you'd rather have the in-terminal view. Pick `pipeline-demo` from the project picker. I'll narrate as the rows move — you watch the dashboard."

Both TUI and web hit the same DB, so either works; the web has marquee notes, the TUI has full keyboard shortcuts.

## Step 4 — Tail the demo's event stream

Start a `Monitor` watching the demo's stdout file, filtering for `[event]` lines:

```
tail -F <demo_output_file> | grep --line-buffered '^\[event\]'
```

Where `<demo_output_file>` is the path returned by the Step 2 Bash invocation. The monitor is `persistent: true` — it runs for the rest of the demo. Each `[event]` line arrives as a notification; narrate per event.

## Step 5 — Narrate each event

Event format: `[event] <kind> key=value key=value …`. Spaces in values are encoded as `_`.

For each event, post ONE short paragraph using the templates below. **Always include one sentence about the UI** — which panel will change, which spinner will appear, where to look. Use first-person where the action is something a real Claude orchestrator would do.

### Event → narration

- **`ready`** (`dashboard`, `project`, `main_feature`, `deps`)
  > "OK — sandbox is ready. I've registered project `pipeline-demo` with one main feature (`<main_feature>`) plus three dependent plans (`<deps>`). The deps are all sitting in `backlog` with a `depends_on=<main_feature>` constraint because they can't merge until that lands. **In a moment you'll see the main row in `queued` and the three deps with the ⊘ blocked-glyph in the pipeline panel.**"

- **`queued`** with `stage=queued` and no `from` (this is the initial main-feature queue)
  > "I'm queueing `<feature>` first — it has no upstream deps so it's free to run. **You should see it land in the pipeline panel at `queued` with the dim queue spinner.**"

- **`queued`** with `stage=backlog` and `depends_on=…` (this is a dep being seeded at backlog)
  > "Adding `<feature>` to the backlog — I'm setting `depends_on=<depends_on>` so the orchestrator knows not to pick it up until that one merges. **You'll see it appear with a `⊘` blocked icon and an italic `backlog` stage pill.**"

- **`queued`** with `from=backlog` (the +60s transition)
  > "60s in — the orchestrator has noticed the 3 backlog rows and pulled them into `queued`. They're still blocked on `<reason>`; this is just the orchestrator saying 'I see you, I'll start when your dep clears'. **Watch the three rows change from italic `backlog` to plain `queued` with the dim queue spinner.**"

- **`stage`** (`feature`, `stage`, `note`)
  Use a stage-specific line, with the `note` woven in. Examples:
  - `stage=research`: "Now `<feature>` is at `research`. **In the agents panel a research session lights up with a step counter (4 steps over a minute) and a green braille spinner; the activity panel starts tailing tool calls — Grep, Read, WebSearch.** The note `<note>` summarises what Claude is doing in this stage."
  - `stage=dev` (first time): "Research finished, plan in hand — now I'm at `dev`. **Agents panel switches to a dev session, 6 steps, you'll see Edit/Write/Bash tool calls in the activity tail.**"
  - `stage=review`: "Dev session done. I'm handing it to review. **Agents panel: review session, scanning the diff, checking edge cases.**"
  - `stage=dev` with `note` containing `[BLOCKER]`: "Uh — review came back with a blocker. `<note>`. I'm dropping it back to `dev` to fix. **Watch the row's stage badge flip back to `dev`, with the BLOCKER + ADVISORY notes scrolling in the notes column.**"
  - `stage=review` with `note` containing `Fixed`: "Back at review — the fix landed and the advisory's been addressed too. **The notes column updates to 'Fixed it!'.**"
  - `stage=merge`: "Approved — moving to `merge`. **The stage pill turns yellow/merge-coloured; no spinner because merge is a waiting state, not an active session.**"

- **`session_start`** / **`session_end`** — skip narration; they fire alongside `stage` events. Use them to know when activity quiets down.

- **`merge_idle`** (`feature`)
  > "`<feature>` is sitting at merge for 60s — this is the post-approval idle window. **The row holds at the merge stage with no spinner; in a real pipeline this is where you'd hit the merge button or wait for CI to land.**"

- **`pop`** (`feature`, `commit_hash`, `commit_msg`)
  > "And there it is — `<feature>` just popped off. Commit `<commit_hash> <commit_msg>` landed in the git log. **Watch the gitLog panel at the bottom of the dashboard — the commit appears at the top of the list, and the row drops out of the pipeline panel (it's `done` now, hidden by default).**"

- **`unblock`** (`features`, `because`)
  > "Now that `<MAIN_FEATURE>` is merged, the deps unblock. I'm releasing all three at once — they run in parallel, each starting at a different stage to show that pipeline rows don't all enter at the same point: one new investigation (research), one with a pre-baked plan (straight to dev), and one ready PR (just needs review). **Watch the agents panel: three sessions running concurrently. The activity panel shows whichever one wrote most recently.**"

- **`complete`**
  > "All four merged. The pipeline is empty. **The gitLog panel should have your 6 starting commits plus 4 new merge commits at the top.** Tell me when you want to tear it down."

## Step 6 — Tear down

When the user is done (or says "stop", "tear down", "clean up"):

1. `TaskStop` the demo background task — its SIGTERM handler purges rows, sessions, progress, the project itself, and the tmp dir.
2. `TaskStop` the dashboard background task — releases port 8765.
3. Confirm with one line: "Sandbox gone. Pipeline-demo project removed. Dashboard down. Anything else?"

## Anti-patterns

- **Don't show the user `pipeline demo` or `pipeline dashboard web`.** They invoked `/pipeline-demo` — that's the only command surface they should see. Engineer the rest in the background.
- **Don't narrate animation-only events** (`session_start`/`session_end` are signals for you, not the user — they fire alongside `stage` events which carry the real story).
- **Don't ask the user to wait between events.** Just narrate as the events arrive; the user reads the conversation while watching the dashboard.
- **Don't drone.** One short paragraph per event, light first-person voice, always one sentence about the UI. No "let me explain how the pipeline works in general" — show, don't lecture.
- **Don't auto-tear-down.** Wait for the user to say they're done.
