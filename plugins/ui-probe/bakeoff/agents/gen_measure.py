"""Generate the ui-probe bake-off measurement manifest (RQ1 b-d + null, RQ8 authoring, RQ10 answers)."""
import json
import os
from pathlib import Path

BK = Path(__file__).resolve().parents[4]   # the marketplace checkout
BO = BK / "plugins/ui-probe/bakeoff"
FMT = BO / "formats"
ART = BO / "results/artifacts"
LA = Path(os.environ["LOCALAPPDATA"]).as_posix()
STATE = f"{LA}/ui-probe/hub-fixture/storage-state.json"
BROWSERS = f"{LA}/ui-probe/ms-playwright"
OUT = Path(__file__).parent / "ui-probe-bakeoff-measure.json"
# Operator, 2026-11-13: "All deepseek / Apples to apples" - every leaf on one model.
PROV, MODEL = "ollama", "deepseek-v4.1-flash:1017-cloud"

BASH_LINES = (
    "Never call Bash with `run_in_background`, and never end your turn waiting for a background task. "
    "You are a headless session: there is no next turn, the notification never arrives, and your work is lost. "
    "For a command that takes minutes, pass `timeout: 600000` on the Bash call and wait for it.\n"
    "Write files and commit as you go rather than holding everything to one long final turn."
)

tasks = []

# ---------------------------------------------------------------- RQ1 b-d + null
TOOLS = {
    "cli": ("Bash,Read",
            "Your only browser tool is the `playwright-cli` command (npm @playwright/cli 0.1.24, on PATH), run "
            "through Bash. Learn it from `playwright-cli --help` and its subcommand help. Set "
            f"`PLAYWRIGHT_BROWSERS_PATH={BROWSERS}` in the environment of every call; run headless. The session "
            f"cookie is in a Playwright storage-state file at `{STATE}` - load it with the tool's own option. "
            "Do not write your own Playwright/CDP scripts and do not use any other browser tool."),
    "mcp": ("mcp__playwright,Read",
            "Your only browser tool is the Playwright MCP server (tools named `mcp__playwright__*`). It is already "
            "configured headless with the session cookie preloaded. Do not use any other browser tool."),
    "agent-browser": ("Bash,Read",
            "Your only browser tool is the `agent-browser` command (0.43.0, on PATH), run through Bash. Learn it "
            "from `agent-browser --help`. Run headless. The session cookie is in a Playwright storage-state file "
            f"at `{STATE}` - load it with the tool's own option (or set the cookie it holds on 127.0.0.1:8001). "
            "Do not write your own Playwright/CDP scripts and do not use any other browser tool."),
}

RQ1_FRAME = """You are measuring one web automation tool on a local test app. Report only what you observed.

App: a local copy of a media dashboard at http://127.0.0.1:8001 (already running; it needs the session cookie
described below, otherwise it redirects to a PIN page). Its recommendations page is /recommend, a grid of poster
tiles (`.rec-tile`). Clicking a tile's poster opens a detail sheet (a `<dialog id="detail-sheet">`).

READ-ONLY. Never click "My list", "Seen it", "Not for me", any star, any Find/Upload/Add button, or submit any
form. Opening and closing the sheet, hovering and reading are fine.

{tool}

Do these three tasks on the FIRST tile of /recommend:

T1 layout - at a 390x844 touch viewport AND at a 1280x900 desktop viewport: open the detail sheet and report
the rendered width in CSS px of each of the three action tiles (My list / Seen it / Not for me, in order), the
close button's centre (x, y) in CSS px, and the labels of the footer buttons.
T2 hover - at 1280x900 with a mouse, hover the first tile (do not click) and report whether its hover action bar
(`.rec-hover`) becomes visible; then at a 390x844 touch viewport report whether it is visible without a hover.
Report what `matchMedia('(hover: hover)').matches` returns in each viewport if your tool can read it, else null.
T3 explore - knowing only "find the rating control for this title and report its current value", reach the
rating control in the detail sheet and report its current value (stars out of 5; null if unrated).

Return your answer as structured output. Use null for anything you could not measure, and say why in `notes`.
{bash}"""

NULL_FRAME = """You are a control run for a tool measurement. Do not use any tools. Return structured output with
every measurement field null, `t2.desktop_hover_visible` and `t2.touch_hover_visible` null, `t3.value` null and
`notes` set to "null control". The task the measured runs receive is described below so this run carries the same
prompt frame; do not attempt it.

---
""" + RQ1_FRAME.replace("{bash}", "")

RQ1_RETURNS = {
    "type": "object",
    "required": ["t1", "t2", "t3", "notes"],
    "properties": {
        "t1": {"type": "object", "properties": {
            "phone": {"type": ["object", "null"]}, "desktop": {"type": ["object", "null"]}}},
        "t2": {"type": "object", "properties": {
            "desktop_hover_visible": {"type": ["boolean", "null"]},
            "touch_hover_visible": {"type": ["boolean", "null"]},
            "desktop_hover_media": {"type": ["boolean", "null"]},
            "touch_hover_media": {"type": ["boolean", "null"]}}},
        "t3": {"type": "object", "properties": {"control": {"type": ["string", "null"]},
                                                 "value": {"type": ["number", "null"]}}},
        "notes": {"type": "string"},
    },
}

for rep in (1, 2, 3):
    for key, (tools, text) in TOOLS.items():
        tasks.append({
            "id": f"measure-web-{key}-{rep}", "provider": PROV, "model": MODEL,
            "allowedTools": tools, "cwd": str(BO.as_posix()), "timeoutMs": 2700000,
            "prompt": RQ1_FRAME.format(tool=text, bash=BASH_LINES if "Bash" in tools else ""),
            "returns": RQ1_RETURNS,
        })
    tasks.append({
        "id": f"measure-web-null-{rep}", "provider": PROV, "model": MODEL,
        "allowedTools": "Read", "cwd": str(BO.as_posix()), "timeoutMs": 600000,
        "prompt": NULL_FRAME.format(tool="(the measured run's tool description appears here)"),
        "returns": RQ1_RETURNS,
    })

# ---------------------------------------------------------------- RQ8 authoring
doc = json.loads((FMT / "tasks.json").read_text(encoding="utf-8"))
ftasks = doc["tasks"]
prompt_md = (FMT / "authoring-prompt.md").read_text(encoding="utf-8")
body = prompt_md.split("\n---\n", 1)[1].split("## Appendix", 1)[0].rstrip().rstrip("-").rstrip()
briefs = {}
for part in prompt_md.split("### Format brief: `")[1:]:
    name, rest = part.split("`", 1)
    briefs[name] = rest.strip()
FORMATS = {"playwright-test": ("spec.ts", "ts"), "flat-yaml": ("yaml", "yaml"), "gherkin": ("feature", "gherkin")}
MODELS = {"deepseek": (PROV, MODEL)}
ATT = FMT / "attempts"
ATT.mkdir(exist_ok=True)

for fmt, (ext, lang) in FORMATS.items():
    for i, t in enumerate(ftasks):
        ex_task = ftasks[(i + 1) % len(ftasks)]["id"]
        example = (FMT / f"scenarios/{fmt}/examples/{ex_task}.{ext}").read_text(encoding="utf-8")
        refs = json.dumps([{k: v for k, v in c.items() if k not in ("markers", "id")} for c in t["checks"]], indent=1)
        for mkey, (prov, model) in MODELS.items():
            for n in (1, 2):
                out_path = f"plugins/ui-probe/bakeoff/formats/attempts/{fmt}/{mkey}/{t['id']}/attempt-{n}.{ext}"
                p = (body.replace("{{TASK_TITLE}}", t["title"]).replace("{{TASK_ASK}}", t["ask"])
                     .replace("{{REFERENCE_VALUES}}", refs).replace("{{OUTPUT_PATH}}", out_path)
                     .replace("{{FORMAT_BRIEF}}", briefs[fmt]).replace("{{EXAMPLE_LANGUAGE}}", lang)
                     .replace("{{EXAMPLE}}", example.rstrip()))
                p += ("\n\n## How to hand it in\n\nDo not use any tools and do not write any file. Return the "
                      "complete file contents as `scenario` in your structured output, and the path above as "
                      "`path`. If (gherkin only) you also need a `.steps.mjs`, return it as `steps`; else null.")
                tasks.append({
                    "id": f"author-{fmt}-{t['id']}-{mkey}-{n}", "provider": prov, "model": model,
                    "allowedTools": "Read", "cwd": str(ATT.as_posix()), "timeoutMs": 900000,
                    "prompt": p,
                    "returns": {"type": "object", "required": ["scenario", "path"],
                                "properties": {"scenario": {"type": "string"}, "path": {"type": "string"},
                                               "steps": {"type": ["string", "null"]}}},
                })

# ---------------------------------------------------------------- RQ10 answers
obs = json.loads((ART / "rq10-observations.json").read_text(encoding="utf-8"))
INP = BO / "results/rq10-inputs"
INP.mkdir(exist_ok=True)
Q = ("Using ONLY the observations in the file below (each is what an automation tool reported after one step of "
     "a journey on a media app), answer: (1) at the end of the journey, what badge text does the tile titled "
     "\"Harbour Lights\" show on the recommendations grid (empty string if none)? (2) the last time the detail "
     "sheet's action block was observed, which of the three actions were pressed/on? Use the labels as the "
     "observations show them. If the observations do not contain the answer, say so in `unknown` rather than "
     "guessing.")
for o in obs:
    jid = o["journey"].split()[0]
    for arm, field in (("full", "fullText"), ("delta", "deltaText")):
        f = INP / f"{o['contender']}-{jid}-{arm}.md"
        f.write_text("\n\n".join(f"### Step {k + 1}: {s['name']}\n\n```\n{s[field]}\n```"
                                 for k, s in enumerate(o["steps"])), encoding="utf-8")
        tasks.append({
            "id": f"answer-{o['contender']}-{jid.lower()}-{arm}", "provider": PROV, "model": MODEL,
            "allowedTools": "Read", "cwd": str(BO.as_posix()), "timeoutMs": 900000,
            "mustRead": [str(f.as_posix())],
            "prompt": f"{Q}\n\nObservations: read `{f.as_posix()}` with the Read tool. Read no other file.",
            "returns": {"type": "object", "required": ["badge", "pressed", "unknown"],
                        "properties": {"badge": {"type": ["string", "null"]},
                                       "pressed": {"type": "array", "items": {"type": "string"}},
                                       "unknown": {"type": ["string", "null"]}}},
        })

def _single_type(schema):
    """swarm's schema subset takes one type name; an unrequired property may already come back null."""
    if isinstance(schema, dict):
        if isinstance(schema.get("type"), list):
            schema["type"] = next(t for t in schema["type"] if t != "null")
        for v in schema.values():
            _single_type(v)
    return schema


for t in tasks:
    r = t.get("returns")
    if r:
        t["returns"] = _single_type(json.loads(json.dumps(r)))
        if t["id"].startswith("answer-"):
            t["returns"]["required"] = ["pressed"]   # badge / unknown may be null


OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps({"cwd": str(BK.as_posix()), "concurrency": 6, "tasks": tasks}, indent=1), encoding="utf-8")
print(OUT, len(tasks), "tasks")
