"""pywinauto UIA adapter for the ui-probe bake-off (RQ4 contender d).

Per call:   python pywinauto_cli.py '<json command>'
Warm:       python pywinauto_cli.py --serve        (one JSON command per stdin line)

Same command vocabulary as uia-script.ps1 / uia-worker.ps1:
  find | tree | get | click | set | list | ping | quit
pywinauto has no UIA CacheRequest equivalent; `tree_cached` is reported unsupported.
"""
import json
import sys
import time

START = time.perf_counter()
from pywinauto import Desktop  # noqa: E402

IMPORT_MS = int((time.perf_counter() - START) * 1000)

WINDOW_CACHE = {}


def reply(payload):
    payload.setdefault("ms", int((time.perf_counter() - START) * 1000))
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def desktop():
    return Desktop(backend="uia")


def find_window(cmd, fresh=False):
    key = ("pid", cmd["pid"]) if cmd.get("pid") else ("title", cmd.get("title"))
    if not fresh and key in WINDOW_CACHE:
        return WINDOW_CACHE[key]
    d = desktop()
    if cmd.get("pid"):
        w = d.window(process=cmd["pid"])
    else:
        w = d.window(title=cmd["title"])
    if not w.exists(timeout=0):
        raise RuntimeError("window not found")
    WINDOW_CACHE[key] = w
    return w


def rect_of(w):
    r = w.element_info.rectangle
    return {"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top}


def find_element(w, cmd):
    name = cmd["name"]
    for kw in ({"title": name}, {"auto_id": name}):
        el = w.child_window(**kw)
        if el.exists(timeout=0):
            return el
    # WORKAROUND: child_window() does not reach elements under WPF's nested panes, so fall
    # back to a full descendant scan. Costs a whole-tree walk on every miss.
    for el in w.descendants():
        info = el.element_info
        if info.name == name or info.automation_id == name:
            return el
    raise RuntimeError("element not found")


def type_of(el):
    return el.element_info.control_type or ""


def tree_nodes(w, limit=400):
    nodes = []

    def walk(el, depth):
        info = el.element_info
        r = info.rectangle
        nodes.append({
            "depth": depth,
            "type": info.control_type or "",
            "name": info.name or "",
            "id": info.automation_id or "",
            "x": r.left, "y": r.top,
            "w": r.right - r.left, "h": r.bottom - r.top,
            "off": False,
        })
        if depth >= 40:
            return
        for child in el.children():
            walk(child, depth + 1)
            if len(nodes) >= limit:
                return

    walk(w, 0)
    return nodes


def handle(cmd):
    op = cmd["op"]
    if op == "ping":
        return {"ok": True, "op": "ping", "import_ms": IMPORT_MS}
    if op == "find":
        w = find_window(cmd)
        out = {"ok": True, "op": "find", "name": w.element_info.name,
               "pid": w.element_info.process_id,
               "cls": w.element_info.class_name}
        out.update(rect_of(w))
        return out
    if op in ("tree", "tree_uncached"):
        w = find_window(cmd)
        nodes = tree_nodes(w)
        return {"ok": True, "op": op, "count": len(nodes), "nodes": nodes}
    if op == "tree_cached":
        return {"ok": False, "op": op, "error": "pywinauto has no CacheRequest API",
                "unsupported": True}
    if op == "get":
        el = find_element(find_window(cmd), cmd)
        try:
            value = el.get_value()
        except Exception:
            value = ""
        if not value:
            try:
                state = el.get_toggle_state()
                value = {0: "Off", 1: "On", 2: "Indeterminate"}.get(state, str(state))
            except Exception:
                value = el.element_info.name
        return {"ok": True, "op": "get", "value": value, "type": type_of(el)}
    if op == "click":
        el = find_element(find_window(cmd), cmd)
        used = "invoke"
        try:
            el.invoke()
        except Exception:
            try:
                used = "toggle"
                el.toggle()
            except Exception:
                used = "click_input"
                el.click_input()
        return {"ok": True, "op": "click", "used": used}
    if op == "set":
        el = find_element(find_window(cmd), cmd)
        el.set_edit_text(cmd["value"])
        return {"ok": True, "op": "set", "value": cmd["value"]}
    if op == "list":
        el = find_element(find_window(cmd), cmd)
        items = [c.element_info.name for c in el.children()
                 if (c.element_info.control_type or "") == "ListItem"]
        return {"ok": True, "op": "list", "count": len(items), "items": items}
    raise RuntimeError("unknown op: " + op)


def serve():
    reply({"ok": True, "op": "hello", "import_ms": IMPORT_MS})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        start = time.perf_counter()
        try:
            cmd = json.loads(line)
            if cmd.get("op") == "quit":
                reply({"ok": True, "op": "quit", "ms": 0})
                return
            out = handle(cmd)
        except Exception as exc:  # surfaced to the harness as a typed failure row
            out = {"ok": False, "op": "error", "error": str(exc)}
        out["ms"] = int((time.perf_counter() - start) * 1000)
        sys.stdout.write(json.dumps(out, default=str) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        serve()
    else:
        try:
            cmd = json.loads(sys.argv[1])
            START = time.perf_counter()
            out = handle(cmd)
        except Exception as exc:
            out = {"ok": False, "op": "error", "error": str(exc)}
        reply(out)
