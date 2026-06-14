---
name: subagent-investigation
description: Use when a background subagent's reported result doesn't match observed reality — committed code missing, branches deleted, files absent, tests not run. Triggers — "what did the agent actually do", "the agent said X but Y", "check the subagent transcript", "investigate <agent-id>". Also explicit /investigate invocation.
---

# Subagent investigation

When a background subagent reports a result, you may need to verify what actually happened by examining the transcript. This skill provides a recipe for locating and investigating subagent JSONL transcripts without overwhelming context.

## When to investigate

Most subagent results match reality. Investigate the transcript when you observe:

- **Agent reported PASS** but expected artifacts are missing (commits, files, branches).
- **Agent reported a numeric result** (e.g., "10 tests passed") that doesn't match a subsequent check.
- **Agent's summary contradicts** the visible repo/system state (e.g., "merged successfully" but branch still exists).
- **Agent claimed to run X** but signs suggest it didn't (log file missing, no output, no side effects).

Do NOT investigate by default — most agent results match reality, and a transcript read wastes context.

## Where the transcript lives

The task-notification from a subagent includes two file paths; only one is useful:

- **`output_file` field**: Usually 0 bytes (the in-session JSON event stream, not the persisted transcript). Skip this — don't bother reading it.
- **Real transcript** (use this):

  | Agent type | Path |
  |---|---|
  | Standard subagent (`Agent` tool dispatch) | `~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl` |
  | Workflow subagent (inside a `Workflow` run) | `~/.claude/projects/<project-slug>/<session-id>/subagents/workflows/<wf-id>/agent-<agent-id>.jsonl` |

Each `agent-<id>.jsonl` is accompanied by an `agent-<id>.meta.json` containing `{"agentType": ...}` — useful to confirm what kind of agent ran.

To construct the path:

- `<project-slug>`: Directory name of your project (e.g., `CLAUDE`, `torrent-hub`). Derived from your current working directory.
- `<session-id>`: Session ID from the parent session. Provided in the task-notification.
- `<agent-id>`: Agent ID from the task-notification (`agent-id` field).
- `<wf-id>`: For workflow agents, the workflow run ID (e.g., `wf_7770f48d-ac6`). Provided in the workflow launch result.

Example:
```
~/.claude/projects/CLAUDE/dev-2026-06-08-subagent-investigation-skill/subagents/agent-a82ef702ac2117506.jsonl
~/.claude/projects/C--code-claude-plugin-marketplace/<session>/subagents/workflows/wf_7770f48d-ac6/agent-a3a4e064401835fe3.jsonl
```

## How to read it (without blowing context)

The JSONL is structured Anthropic message events. Use the `/investigate` slash command or `claude-investigate` CLI — both ship with the agent-investigation plugin. Falls back to manual grep+python only if the tool is unavailable.

### Primary: /investigate slash command

**Quick investigation (~1 KB output):**

```
/investigate <agent-id>
```

Returns: size, event count, tool freq, top tool trigrams, error count, retry count, first 5 errors. **If `errored tool calls > 0` or `suspected retries > 0`, drill into the matching subcommand:**

```bash
claude-investigate errors <agent-id>    # full tool_use + error pair for each failure
claude-investigate retries <agent-id>   # tool calls retried with similar input (loops / stuck patterns)
claude-investigate pivots <agent-id>    # long assistant texts — planning / reflection / final summary
```

These are surgical reads — each returns just the relevant slice, not the whole transcript.

### Full report (only if quick drill-down doesn't surface the failure)

```bash
claude-investigate report <agent-id>
```

~39× compression vs raw JSONL (1 MB → ~30 KB). Bundles summary + tools + ngrams + agents + skills + errors + retries + pivots + phases + patterns.

### Fallback: manual grep + python (use only if plugin is absent)

If the `claude-investigate` CLI isn't available, use the legacy recipe with `transcript_mine.py`:

```bash
python <path-to-transcript-mine.py> summary <agent-jsonl>
python <path-to-transcript-mine.py> errors <agent-jsonl>
python <path-to-transcript-mine.py> retries <agent-jsonl>
```

If even `transcript_mine.py` isn't available, use grep:

```text
Grep(
  pattern="error|fatal|BLOCKER|exit code|Traceback|AssertionError|Exception",
  path="<agent-jsonl>",
  output_mode="content",
  -n=true,
  head_limit=20
)
```

If empty, extract `message.content[].text` via a one-off Python loop:

```python
import json
with open('<transcript-path>', 'r') as f:
    for i, line in enumerate(f, 1):
        try:
            event = json.loads(line)
            msg = event.get('message') or {}
            content = msg.get('content') or []
            # Subagent JSONLs have content as either a list of blocks OR a plain string
            if isinstance(content, str):
                print(f"L{i}: {content[:500]}")
                continue
            for block in content:
                if block.get('type') == 'text':
                    text = block.get('text', '')
                    if text:
                        print(f"L{i}: {text[:500]}")
        except json.JSONDecodeError:
            pass
```

Note the `content` may be a string (workflow subagents' initial user message) or a list of blocks (mid-conversation events) — the fallback handles both.

## Anti-patterns

- **Tailing with `cat` or `head`**: JSONL lines are long and context-heavy. Use `/investigate` first.
- **Reading the whole JSONL with Read**: even a 2MB transcript will flood context.
- **Skipping straight to `report` instead of quick summary**: `report` is 30KB; summary is ~1KB. Read the rollup first, drill in only when warranted.
- **Trusting the summary when operationally verifiable**: If the agent claimed it committed, created a file, or deleted a branch, check first with `git` / `ls` / `git branch`. Only investigate the transcript if the check contradicts the claim.

## Why this skill exists

On 2026-05-18, a subagent merge handler reported "PASS" on a branch squash-merge, but the actual merge silently destroyed a feature branch with uncommitted work. The parent (Claude Opus) spent 6+ turns locating the transcript and extracting the failure reason (a silent `git` merge conflict that the agent didn't handle). This skill turns that investigation into 1–2 tool calls and documents the path that should have been auto-loaded.

See the post-mortem in `repos/CLAUDE/plans/complete/dev-reviewer-stage.md` for the full incident timeline.
