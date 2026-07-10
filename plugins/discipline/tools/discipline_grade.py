#!/usr/bin/env python3
"""discipline_grade — blind judge adjudication of discipline candidates.

Takes the candidates JSONL produced by tools/discipline_scan.py, strips any
injected <discipline-pack> spans (blindness to experiment arm), batches
excerpts to a judge model via `claude -p`, and writes verdicts JSONL.

Judge model policy (skills/model-selection): the pin is explicit — --model is
REQUIRED, there is no default. Recommended judge per the design record
(repos/claude-plugin-marketplace/plans/sonnet5-discipline.md (CLAUDE repo)): claude-fable-5 — a same-family
(Sonnet-tier) judge grading Sonnet transcripts risks affinity bias. Grading
this baseline's full candidate set on Fable is roughly $20-30; sample with
--limit first.

Usage:
  python discipline_grade.py --candidates c.jsonl --model claude-fable-5 \
      [--effort high] [--batch-size 12] [--limit 0] [--metric UDC] \
      [--out verdicts.jsonl] [--dry-run]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

PACK_RE = re.compile(r"<discipline-pack\b.*?</discipline-pack>", re.DOTALL)
RUBRIC_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "disciplines", "grading-rubric.md"
)


def strip_pack(text):
    return PACK_RE.sub("[injected-context removed]", text or "")


def load_candidates(path, metric_filter, limit):
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                cand = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if metric_filter and cand.get("metric") != metric_filter:
                continue
            cand["excerpt"] = strip_pack(cand.get("excerpt"))
            cand["context"] = [strip_pack(c) for c in (cand.get("context") or [])]
            out.append(cand)
            if limit and len(out) >= limit:
                break
    return out


def build_prompt(rubric, batch):
    lines = [rubric, "\n---\n\nCandidates to grade:\n"]
    for cand in batch:
        lines.append(
            json.dumps(
                {
                    "id": cand["id"],
                    "metric": cand["metric"],
                    "excerpt": cand["excerpt"],
                    "context": cand.get("context") or [],
                },
                ensure_ascii=False,
            )
        )
    lines.append(
        "\nReturn ONLY the JSON array of verdict objects — one per candidate id above."
    )
    return "\n".join(lines)


def parse_verdicts(stdout_text):
    start = stdout_text.find("[")
    end = stdout_text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no JSON array in judge output")
    verdicts = json.loads(stdout_text[start : end + 1])
    if not isinstance(verdicts, list):
        raise ValueError("judge output is not a list")
    return verdicts


# Judge sessions inherit the user's hook/skill environment; without these
# flags a keepalive hook or skill nudge can consume the headless turn and the
# final text comes back empty (observed on claude-fable-5: rc=0, result "").
JUDGE_ISOLATION_FLAGS = [
    "--output-format", "json",
    "--settings", '{"checkpoint":{"keepalive":false}}',
    "--disallowedTools", "ToolSearch,ScheduleWakeup,Skill,TaskCreate,TaskUpdate,TaskList",
]


def call_judge(prompt, model, effort, debug_dir="judge-raw"):
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError("claude CLI not found on PATH")
    cmd = [exe, "-p", "--model", model, *JUDGE_ISOLATION_FLAGS]
    if effort:
        cmd += ["--effort", effort]
    result = subprocess.run(
        cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=1800
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude -p failed rc={result.returncode}: {result.stderr[:500]}")
    try:
        text = json.loads(result.stdout).get("result") or ""
    except (json.JSONDecodeError, ValueError):
        text = result.stdout
    if "[" not in text:
        os.makedirs(debug_dir, exist_ok=True)
        dump = os.path.join(debug_dir, f"judge-fail-{int(time.time())}.out")
        with open(dump, "w", encoding="utf-8") as f:
            f.write(result.stdout + "\n--- STDERR ---\n" + result.stderr[:3000])
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--model", required=True, help="judge model id — no default by policy")
    ap.add_argument("--effort", default="", help="optional effort pin (must be supported by the judge tier)")
    ap.add_argument("--batch-size", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="grade at most N candidates (0 = all)")
    ap.add_argument("--metric", default="", help="grade only this metric (UDC|UCA|RWV|RSV)")
    ap.add_argument("--out", default="verdicts.jsonl")
    ap.add_argument("--dry-run", action="store_true", help="print the first assembled prompt; no API calls")
    args = ap.parse_args()

    with open(RUBRIC_PATH, "r", encoding="utf-8") as f:
        rubric = f.read()
    candidates = load_candidates(args.candidates, args.metric, args.limit)
    if not candidates:
        print("no candidates to grade")
        return 0
    by_id = {c["id"]: c for c in candidates}
    batches = [
        candidates[i : i + args.batch_size]
        for i in range(0, len(candidates), args.batch_size)
    ]
    print(f"{len(candidates)} candidates in {len(batches)} batches (judge: {args.model})")

    if args.dry_run:
        print("\n--- dry run: first batch prompt ---\n")
        print(build_prompt(rubric, batches[0]))
        return 0

    graded = 0
    with open(args.out, "w", encoding="utf-8") as out_f:
        for i, batch in enumerate(batches, 1):
            prompt = build_prompt(rubric, batch)
            verdicts = None
            for attempt in (1, 2):
                try:
                    verdicts = parse_verdicts(call_judge(prompt, args.model, args.effort))
                    break
                except Exception as exc:  # retry once per batch, then skip
                    print(f"batch {i} attempt {attempt} failed: {exc}")
            if verdicts is None:
                continue
            for v in verdicts:
                cand = by_id.get(v.get("id"))
                if not cand:
                    continue
                record = dict(cand)
                record["verdict"] = v.get("verdict")
                record["severity"] = v.get("severity")
                record["note"] = v.get("note")
                out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
                graded += 1
            print(f"batch {i}/{len(batches)} done ({graded} graded)")
    print(f"\nverdicts written: {args.out} ({graded}/{len(candidates)} graded)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
