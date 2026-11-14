#!/usr/bin/env python
"""Launch torrent-hub against a scratch database for the ui-probe bake-off.

Never `start_torrent_hub.py --test`: that script copies every `HKCU\\Environment` credential into
the process (overwriting any env override) and defaults `DB_PATH` to `./torrent-hub.db`, which from
a checkout is the production database. This launcher builds an explicit, allowlisted environment
instead, so a credential cannot reach the server even if one is added to the machine later.

    python hub_fixture.py --check                 # env NAMES only; exit 1 on any leak or non-scratch path
    python hub_fixture.py --seed-only             # seed the scratch DB + rows.json, write the session file
    python hub_fixture.py                         # seed (idempotent) then serve on 127.0.0.1:8001
    python hub_fixture.py --tmdb                  # live TMDB metadata (read-only), for /media/<id>

Scratch defaults to `%LOCALAPPDATA%\\ui-probe\\hub-fixture`; pass `--scratch` to relocate it.

The session cookie is written to `<scratch>/session.json` and only its PATH is printed — the value
never reaches stdout, a log, or a committed file.
"""
import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_HUB = Path("C:/code/.worktrees/torrent-hub/ui-probe-fixture")
DEFAULT_SCRATCH = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "ui-probe" / "hub-fixture"
DEFAULT_PORT = 8001

# The only inherited names the server needs. Everything else is dropped: an allowlist, not a
# denylist, so a credential variable nobody thought of still cannot get in.
ENV_ALLOW = (
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
    "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE", "OS", "LANG",
)
# Reported by --check as a hard failure. `torrent-hub`'s Settings reads all of these.
FORBIDDEN_PREFIXES = ("PLEX_", "QB_", "IPT_", "NAS_", "PUSHOVER_")
# The two host pointers the fixture sets itself. They are not credentials: they are pinned to a
# dead loopback port so an accidental call cannot reach the real NAS or qBittorrent, and --check
# fails unless they hold exactly this value.
Pinned = {k: "http://127.0.0.1:1" for k in ("PLEX_HOST", "QB_HOST", "RECOMMEND_LLM_URL")}
FORBIDDEN_ALLOW = frozenset(Pinned)
# Scrubbed for the same reason but not part of the named families -- reported, not failed.
ALSO_SCRUBBED = ("TOR_PROXY", "TMDB_API_KEY", "SECRET_KEY")

SCRATCH_SECRET = "ui-probe-bakeoff-scratch-secret-not-a-real-key"
FAKE_PLEX_USER_ID = 987654321   # never a real Plex Home id; proves the link without one


def scratch_paths(scratch: Path) -> dict:
    scratch = scratch.resolve()
    return {
        "root": scratch,
        "db": scratch / "torrent-hub.db",
        "recommend": scratch / "recommend",
        "access_log": scratch / "access.log",
        "session": scratch / "session.json",
        "server_log": scratch / "server.log",
    }


def build_env(paths: dict, *, tmdb: bool) -> dict:
    """The server's whole environment. `--check` inspects exactly this, so it cannot drift."""
    env = {name: os.environ[name] for name in ENV_ALLOW if name in os.environ}
    env.update({
        "DB_PATH": str(paths["db"]),
        "RECOMMEND_DATA_DIR": str(paths["recommend"]),
        "SECRET_KEY": SCRATCH_SECRET,
        "RECOMMEND_SYNC": "0",
        "STUFFING_ENABLED": "0",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
    })
    env.update(Pinned)
    if tmdb:
        env["TMDB_API_KEY"] = read_user_env("TMDB_API_KEY")
    return env


def read_user_env(name: str) -> str:
    """One value from `HKCU\\Environment`, read inside this process. Never printed."""
    if sys.platform != "win32":
        raise SystemExit(f"{name}: not on Windows; pass it in the environment instead")
    import winreg  # noqa: PLC0415 — Windows-only, and only when --tmdb asks for it

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value)
    except OSError:
        raise SystemExit(f"{name} is not set in HKCU\\Environment; run without --tmdb")


def check(paths: dict, env: dict, *, tmdb: bool) -> int:
    """Print effective variable NAMES and fail on a leak or a non-scratch path."""
    names = sorted(env)
    print("hub_fixture --check: effective environment (names only)")
    for name in names:
        print(f"  {name}")
    problems = []
    for name in names:
        if name.startswith(FORBIDDEN_PREFIXES) and name not in FORBIDDEN_ALLOW:
            problems.append(f"credential-family variable present: {name}")
    for name, want in Pinned.items():
        if env.get(name) != want:
            problems.append(f"{name} is {env.get(name)!r}, not the dead-loopback {want}")
    if env.get("DB_PATH") and Path(env["DB_PATH"]).resolve().parent != paths["root"]:
        problems.append(f"DB_PATH is not under the scratch dir: {env['DB_PATH']}")
    if env.get("RECOMMEND_DATA_DIR") and Path(env["RECOMMEND_DATA_DIR"]).resolve().parent != paths["root"]:
        problems.append(f"RECOMMEND_DATA_DIR is not under the scratch dir: {env['RECOMMEND_DATA_DIR']}")
    if env.get("SECRET_KEY") != SCRATCH_SECRET:
        problems.append("SECRET_KEY is not the scratch key")
    for name in ("RECOMMEND_SYNC", "STUFFING_ENABLED"):
        if env.get(name) != "0":
            problems.append(f"{name} is {env.get(name)!r}, not '0'")
    for name in ALSO_SCRUBBED:
        if name == "TMDB_API_KEY" and tmdb:
            continue          # --tmdb asks for it, read from HKCU\Environment, never inherited
        if name in env and name != "SECRET_KEY":
            problems.append(f"inherited variable should not be present: {name}")
    print(f"\nscratch root {paths['root']}")
    if problems:
        print(f"FAIL — {len(problems)} problem(s):")
        for p in problems:
            print(f"  {p}")
        return 1
    print("PASS — no Plex/qBittorrent/IPT/NAS/Pushover variable, scratch DB and data dir, sync and stuffing off")
    return 0


ROWS = [
    {"key": "row-quiet-drama", "title": "Quiet drama", "sub": "Synthetic fixture row",
     "ids": ["movie:900001", "movie:900002", "movie:900003"]},
    {"key": "row-coastal", "title": "Coastal", "sub": "Synthetic fixture row",
     "ids": ["movie:900004", "tv:900005", "movie:900006"]},
]
TITLES = {
    "movie:900001": {"t": "Harbour Lights", "y": 2019, "k": "movie",
                     "why": ["Quiet drama", "Slow burn", "Coastal"]},
    "movie:900002": {"t": "The Long Static", "y": 2021, "k": "movie",
                     "why": ["Slow burn", "Radio"]},
    "movie:900003": {"t": "Winter Ferry", "y": 2017, "k": "movie",
                     "why": ["Coastal", "Quiet drama"]},
    "movie:900004": {"t": "Salt Marsh", "y": 2020, "k": "movie", "why": ["Coastal"]},
    "tv:900005": {"t": "Signal House", "y": 2022, "k": "tv", "why": ["Radio", "Slow burn"]},
    "movie:900006": {"t": "Low Tide", "y": 2018, "k": "movie", "why": ["Quiet drama"]},
}
ROWS_META = {"positives": 4, "rated": 4, "watched": False, "negatives": 1, "candidates": 6}


def seed(paths: dict) -> dict:
    """One linked profile (fake Plex id), its engine rows.json, and a session cookie file."""
    from src import auth, db  # noqa: PLC0415 — imported after the env is applied
    from src.recommend import paths as rec_paths  # noqa: PLC0415

    # Every run starts from the same state: a leftover scratch DB carries the previous run's
    # rec_feedback rows, and RQ9 measures the change in that table.
    for suffix in ("", "-wal", "-shm"):
        leftover = Path(str(paths["db"]) + suffix)
        if leftover.exists():
            leftover.unlink()

    db.init_db()
    profile = db.get_profile_by_name("Bakeoff")
    if profile is None:
        # `pin_hash` is NOT NULL. Hash a random PIN nobody is told, so the profile is reachable
        # only through the session cookie the runners read from the scratch file.
        import secrets  # noqa: PLC0415

        pid = db.create_profile(
            "Bakeoff", auth.hash_pin(secrets.token_hex(16)), None, None, True,
            plex_user_id=FAKE_PLEX_USER_ID, plex_is_admin=True, rec_signal="ratings",
        )
        profile = db.get_profile(pid)
    pid = int(profile["id"])

    engine_key = f"p{pid}"
    profile_dir = rec_paths.profile(engine_key)
    profile_dir.mkdir(parents=True, exist_ok=True)
    (profile_dir / "rows.json").write_text(
        json.dumps({"meta": ROWS_META, "rows": ROWS, "titles": TITLES}, indent=2), encoding="utf-8")
    # The engine's own artefact directory: absent posters fall back to the no-image branch, so the
    # page never fetches from TMDB for a tile.
    (profile_dir / "artifact").mkdir(exist_ok=True)

    token = auth.generate_token()
    db.create_device_token(token, pid)
    paths["session"].write_text(json.dumps({
        "cookie_name": "profile_session",
        "cookie_value": auth.make_cookie_value(token),
        "profile_id": pid,
        "engine_key": engine_key,
    }), encoding="utf-8")
    try:                                  # best effort: this is a local scratch file
        os.chmod(paths["session"], 0o600)
    except OSError:
        pass
    return {"profile_id": pid, "engine_key": engine_key, "linked": profile.get("plex_user_id") is not None}


def serve(paths: dict, port: int) -> None:
    import logging  # noqa: PLC0415

    handler = logging.FileHandler(paths["access_log"], encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logging.getLogger("uvicorn.access").addHandler(handler)
    logging.getLogger("uvicorn.access").setLevel(logging.INFO)
    # log_config=None below means uvicorn installs no handlers of its own; without this the
    # traceback behind a 500 goes nowhere, which is exactly the evidence a probe needs.
    errors = logging.StreamHandler()
    errors.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).addHandler(errors)
        logging.getLogger(name).setLevel(logging.INFO)

    import uvicorn  # noqa: PLC0415

    # log_config=None keeps uvicorn from reconfiguring the access logger, which would otherwise
    # reset the level to WARNING (log_level="warning") and silently drop every request line.
    uvicorn.run("src.main:app", host="127.0.0.1", port=port, log_config=None, access_log=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default=str(DEFAULT_HUB))
    ap.add_argument("--scratch", default=str(DEFAULT_SCRATCH))
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--tmdb", action="store_true", help="pass TMDB_API_KEY through (read-only metadata)")
    ap.add_argument("--check", action="store_true", help="print effective env NAMES, exit 1 on a leak")
    ap.add_argument("--seed-only", action="store_true")
    args = ap.parse_args()

    if args.port == 8000:
        sys.exit("hub_fixture: 8000 is production; the fixture never binds it")
    hub = Path(args.hub).resolve()
    if not (hub / "src" / "main.py").is_file():
        sys.exit(f"hub_fixture: no torrent-hub checkout at {hub}")
    paths = scratch_paths(Path(args.scratch))
    paths["root"].mkdir(parents=True, exist_ok=True)
    env = build_env(paths, tmdb=args.tmdb)

    if args.check:
        return check(paths, env, tmdb=args.tmdb)

    os.environ.clear()
    os.environ.update(env)
    os.chdir(hub)
    sys.path.insert(0, str(hub))

    info = seed(paths)
    print(f"profile p{info['profile_id']} linked={info['linked']} engine_key={info['engine_key']}")
    print(f"scratch     {paths['root']}")
    print(f"session     {paths['session']}")
    print(f"access log  {paths['access_log']}")
    if args.seed_only:
        return 0
    print(f"serving     http://127.0.0.1:{args.port}", flush=True)
    serve(paths, args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
