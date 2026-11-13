"""Tabulate the ui-probe measurement round: RQ1 vs the scripted reference, RQ10 vs ground truth."""
import json
import sys
from pathlib import Path

R = Path(sys.argv[1]) / "results"   # the swarm run dir, e.g. ~/.swarm/runs/<repo>/ui-probe-bakeoff-measure-1
ART = Path(__file__).resolve().parents[1] / "results/artifacts"


def load(name):
    d = json.loads((R / f"{name}.json").read_text(encoding="utf-8"))
    o = d.get("outputJson")
    if o is None:
        try:
            o = json.loads(d["output"])
        except Exception:
            o = None
    t = d.get("tokens") or {}
    return d, o, t


def num(x):
    return round(float(x), 1) if isinstance(x, (int, float)) else x


# ---- RQ1
REF = {"phone": ([111.3, 111.3, 111.3], (358.0, 201.3)), "desktop": ([90.3, 91.2, 116.1], (1016.0, 171.0))}
print("## RQ1")
print("leaf | s | turns | in/out tok | phone widths ok | phone close | desk widths ok | desk close | footer(desk) | hover d/t | media d/t | t3")
for key in ("cli", "mcp", "agent-browser", "null"):
    for rep in (1, 2, 3):
        d, o, t = load(f"measure-web-{key}-{rep}")
        row = [f"{key}-{rep}", round(d["durationMs"] / 1000), d.get("numTurns"),
               f"{t.get('input', 0)//1000}k/{t.get('output', 0)//1000}k"]
        if not o:
            print(" | ".join(map(str, row + ["NO OUTPUT"]))); continue
        t1 = o.get("t1") or {}
        for vp in ("phone", "desktop"):
            v = t1.get(vp) or {}
            w = next((v[k] for k in v if "width" in k.lower() and isinstance(v[k], list)), None)
            c = next((v[k] for k in v if "close" in k.lower() and "centre" in k.lower() or k.lower() in ("closecenter", "close_centre", "close")), None)
            ref_w, ref_c = REF[vp]
            wok = None if w is None else all(abs(float(a) - b) <= 1 for a, b in zip(w, ref_w)) and len(w) == 3
            cc = None
            if isinstance(c, dict):
                cc = (num(c.get("x")), num(c.get("y")))
            elif isinstance(c, list):
                cc = tuple(num(x) for x in c)
            row += [wok, cc]
        dv = t1.get("desktop") or {}
        row.append(next((dv[k] for k in dv if "footer" in k.lower()), None))
        t2 = o.get("t2") or {}
        row.append(f"{t2.get('desktop_hover_visible')}/{t2.get('touch_hover_visible')}")
        row.append(f"{t2.get('desktop_hover_media')}/{t2.get('touch_hover_media')}")
        row.append((o.get("t3") or {}).get("value"))
        print(" | ".join(map(str, row)))

# ---- RQ10
print("\n## RQ10")
gt = json.loads((ART / "rq10.json").read_text(encoding="utf-8"))
truth = {}
for j in gt["journeys"]:
    jid = j["journey"].split()[0].lower()
    last = j["steps"][-1]["state"]
    badge = next(x["badge"] for x in last["tiles"] if x["title"] == "Harbour Lights")
    opened = [s["state"] for s in j["steps"] if s["state"].get("open")]
    pressed = sorted(a["label"] for a in (opened[-1] if opened else last)["acts"] if a["pressed"] == "true")
    truth[(j["contender"], jid)] = (badge, pressed)
print("leaf | truth | answer | badge ok | pressed ok | unknown")
tally = {}
for (cont, jid), (badge, pressed) in sorted(truth.items()):
    for arm in ("full", "delta"):
        d, o, t = load(f"answer-{cont}-{jid}-{arm}")
        ab = (o or {}).get("badge"); ap = sorted((o or {}).get("pressed") or [])
        bok = (ab or "") == badge; pok = [p.lower() for p in ap] == [p.lower() for p in pressed]
        tally.setdefault(arm, [0, 0])
        tally[arm][0] += bok; tally[arm][1] += pok
        print(f"{cont}-{jid}-{arm} | {badge!r} {pressed} | {ab!r} {ap} | {bok} | {pok} | {(o or {}).get('unknown')}")
print("tally (badge ok, pressed ok) of 6 per arm:", tally)
