# Results fragment — RQ7 (protocols) and RQ6 (TV)

*Lane: `swarm/d70a4826efa1/build-protocols-tv` · built by `deepseek-v4.1-flash:1017-cloud` · 2026-11-13.*

Everything under `plugins/ui-probe/bakeoff/{protocols,tv}/` is measurement scaffolding; none of it ships
as plugin behaviour. Every number below was produced by one harness, on this machine, in this worktree.

## Harness (the fairness contract)

One harness drives every contender: `protocols/harness.mjs` owns the task loop, the repeat count, the
clock, the byte/token measurement and the row schema; each contender is a thin adapter exposing
`probe(task)` and `guard` behind the same interface. `measureOne()` is the only place a timing is taken
and `measure()` is the only place a transcript is counted, so no contender can be measured differently
from another. The same loop drives the TV steps.

- Offline smoke test: `node --test plugins/ui-probe/bakeoff/protocols/tests/smoke.test.mjs` — **7/7 pass**,
  with every egress point (fetch, `node:net`, `child_process`) injected as a call-time fake and
  `globalThis.fetch` replaced by a throwing stub. No socket opened; 0.1–0.2 s across runs.
- Repeats: **5** per task (the first HTTP sample carries connection setup; the median is the reported
  number, min–max alongside).
- Tokens: `chars/4` on the serialised UTF-8 transcript — the plan's RQ10 meter, model-free.

```
node plugins/ui-probe/bakeoff/protocols/run.mjs --repeats 5
node plugins/ui-probe/bakeoff/tv/probe.mjs [--attach-port <port>]
```

---

## RQ7 — what each protocol transcript looks like, and how read-only is enforced

Artifact: `plugins/ui-probe/bakeoff/results/artifacts/protocols.json`
(HTTP target in that run: the local `node:http` fixture at `127.0.0.1:53871` — **no hub fixture was
listening on :8001**, so the fallback the plan prescribes was used. `"fixtureWrites": 0`.)

| Task | Contender | Verified | Median ms (min–max) | Transcript bytes | Est. tokens | Read-only layer | Exact command | Artifact |
|---|---|---|---|---|---|---|---|---|
| HTTP GET `/api/scan-status` (authenticated) | fetch (Node 24 global) | PASS | 1.54 (1.39–20.44) | 453 | 114 | method/host/port/path allowlist, enforced before `fetch()`; `redirect: manual` | `node plugins/ui-probe/bakeoff/protocols/run.mjs --only http --repeats 5` | `results/artifacts/protocols.json` |
| HTTP GET `/api/scan-status` (no cookie) | fetch | PASS | 1.01 (0.92–1.27) | 192 | 48 | same | same | same |
| HTTP GET `/api/does-not-exist` | fetch | PASS | 0.91 (0.59–1.40) | 186 | 47 | same | same | same |
| TCP connect + banner read | node:net | PASS | 0.59 (0.56–1.49) | 86 | 22 | exact write-allowlist (`""` only), enforced before `connect()` | `node plugins/ui-probe/bakeoff/protocols/run.mjs --only tcp --repeats 5` | same |
| TCP allowlisted write + echo read | node:net | PASS | 0.70 (0.62–0.95) | 124 | 31 | same, writes `""` or `"HELLO ui-probe\r\n"` | same | same |
| SSH BatchMode `df -h` on localhost | ssh.exe (in-box OpenSSH 9.5p2) | **OPEN** | — | — | — | argv allowlist: BatchMode forced, localhost only, exact remote command, no forwards | `node plugins/ui-probe/bakeoff/protocols/run.mjs --only ssh` | same |
| Hurl GET (3 tasks) | Hurl | **OPEN** | — | — | — | not exercised | — | same |
| qBittorrent `/api/v2/app/version` | qBittorrent Web API | **OPEN** | — | — | — | not exercised | — | same |

The 20.44 ms max on the authenticated read is the first request's connection setup; it is the only
outlier and it is included rather than trimmed.

### The transcripts themselves (agent-facing text, verbatim from the artifact)

```
GET http://127.0.0.1:53871/api/scan-status
> cookie: <redacted>
< HTTP 200 OK
< cache-control: no-store
< content-length: 204
< content-type: application/json
< date: Fri, 13 Nov 2026 02:53:34 GMT
< set-cookie: <redacted>
< body 204 chars:
{"tv_running":false,"movies_running":false,"any_running":false,"recommend_running":false,"recommend_profile":null,"recommend_stage":null,"recommend_done":null,"recommend_total":null,"recommend_queued":[]}
# 1.4 ms
```

```
GET http://127.0.0.1:53871/api/scan-status
< HTTP 302 Found
< content-type: text/plain
< location: /pin
< set-cookie: <redacted>
< body 0 chars:
# 1.1 ms
```

```
GET http://127.0.0.1:53871/api/does-not-exist
< HTTP 404 Not Found
< content-type: application/json
< body 22 chars:
{"detail":"Not Found"}
# 0.5 ms
```

```
CONNECT 127.0.0.1:53872
< 220 ui-probe-bakeoff fixture ready
# closed by probe, 0.5 ms
```

```
CONNECT 127.0.0.1:53872
< 220 ui-probe-bakeoff fixture ready
> HELLO ui-probe
< 250 HELLO ui-probe
# closed by probe, 0.8 ms
```

Cookie, Set-Cookie and Authorization values are replaced **before the transcript string exists**
(`protocols/redact.mjs`), so a transcript is safe to hand to an agent or commit as an artifact. A
regression assertion pins that the fixture's session value never appears in any transcript.

### Read-only enforcement per layer — attempt, refused, evidence

Artifact: `protocols.json` → `guards[]`. Same bite for every contender: one call that is off its
allowlist, attempted through the same guarded path the probe uses.

| Contender | Allowlist | Off-list attempt | Refused | Evidence |
|---|---|---|---|---|
| http-fetch | `GET http://127.0.0.1:{port}` `/api/scan-status, /api/does-not-exist` | `POST /api/scan-status` | **yes** | `http: POST … is off the allowlist`; fixture request log shows **0 non-GET requests** (`target.fixtureWrites: 0`) |
| tcp-net | connect `127.0.0.1:{port}`; write `""` or `"HELLO ui-probe\r\n"` | `QUIT\r\n` | **yes** | `tcp: write "QUIT\r\n" is off the allowlist`; fixture received no such bytes |
| ssh-batch | `ssh -o BatchMode=yes {localhost,127.0.0.1} df -h` | `localhost rm -rf /` | **yes** | `ssh: … is off the allowlist`; ssh was **not spawned** (spy count unchanged) |
| hurl | n/a | — | not attempted | Hurl not installed and not approved |
| qbittorrent | n/a | — | not attempted | credentials out of scope by instruction |

The shape is `rts-mobile/tools/frame-witness.mjs:29`: a string-matched predicate per layer
(`httpPolicy`, `tcpPolicy`, `sshPolicy`, `sdbPolicy` in `protocols/allow.mjs`) and a `guarded()` wrapper
that throws `InputError` before the call is made. `redirect: "manual"` is part of the HTTP layer: a 30x
is recorded as evidence and never followed to a host the policy did not approve.

**What the bake-off says about the boundary:** all three layers can enforce read-only, and cheaply —
the guard costs nothing measurable (the allowlist check is string/URL matching, and the measured
latencies are dominated by connection setup). What differs is what each layer can *see*: HTTP can
allowlist a method, TCP a byte string, SSH a remote command. None of them can stop a GET with a side
effect, which is why the design plan still needs RQ9's scenario-level layer on top.

### OPEN rows — RQ7

| Item | Why OPEN | Exact probe still to run |
|---|---|---|
| qBittorrent `/api/v2/app/version` | Not contacted. The probe needs `QB_*` credentials and no credential value may enter the bake-off. | `POST /api/v2/auth/login` with `QB_USER`/`QB_PASS` from the environment → `GET http://127.0.0.1:<qb-port>/api/v2/app/version` with `Cookie: SID=<redacted>` |
| Hurl GET | Hurl is **not installed** and was **not on the operator's approved install list** (plan Current Status, 2026-11-13). | `hurl --version && hurl --test --variable host=http://127.0.0.1:<fixture-port> plugins/ui-probe/bakeoff/protocols/hurl/http.scan-status.hurl` (the `.hurl` file still has to be written) |
| SSH `df -h` | **No sshd is listening on 127.0.0.1:22.** The adapter ran one BatchMode attempt to capture the real refusal: exit 255 after 2082.8 ms, `stderr: banner exchange: Connection to UNKNOWN port -1: Connection refused`. No key, agent or NAS credential is supplied by the probe. | `ssh -F NUL -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=5 -o NumberOfPasswordPrompts=0 localhost df -h` — run once a local sshd exists; the guard also accepts `127.0.0.1` |

`-F NUL` and `UserKnownHostsFile=NUL` are deliberate: they stop ssh.exe reading `~/.ssh/config` (where
a NAS Host alias could redirect the probe) and stop it writing `known_hosts`. This is a workaround, not
a neutral choice — recorded here per the fairness rule.

---

## RQ6 — the TV

Artifacts: `results/artifacts/tv-inspector.json` (inspector half, **verdict PASS**, reproducible now) and
`results/artifacts/tv.json` (full chain, **FAIL on re-run** — see the failure mode below).

The TV **was** reachable and in developer mode: `UE50TU7020KXXU` at `192.168.1.110:26101`.

| Step | Status | Evidence | Exact command | Artifact |
|---|---|---|---|---|
| locate sdb | PASS | `C:/Users/Andrew/.tizen-extension-platform/server/sdktools/data/tools/sdb.exe` (sdb 4.2.36) | `where sdb` | `tv-inspector.json` |
| `sdb devices` | PASS | `192.168.1.110:26101  device  UE50TU7020KXXU` | `sdb devices` | `tv.json` |
| `sdb shell 0 debug torrenthub.tizen` | PASS (first run) | `... successfully launched pid = 3574 with debug 1 port: 43411` → **dynamic port, not 9222** | `sdb shell 0 debug torrenthub.tizen` | see note |
| `sdb forward` | PASS | `forwarded 43411` | `sdb forward tcp:43411 tcp:43411` | `tv-inspector.json` |
| `GET /json/version` | PASS | `Chrome/69.0.3497.128`, `Protocol-Version 1.3`, V8 `7.0.276.40`, UA `… Tizen 5.5 …` | `curl http://127.0.0.1:43411/json/version` | `tv-inspector.json` (50.0 ms) |
| `GET /json/list` | PASS | 1 target, `http://192.168.1.135:8000/tv?tizen=1` | `curl http://127.0.0.1:43411/json/list` | `tv-inspector.json` (14.4 ms) |
| `GET /json/protocol` | PASS | 39 domains; **Accessibility present, DOMSnapshot present, Input present**, Runtime, Page present | `curl http://127.0.0.1:43411/json/protocol` | `tv-inspector.json` (132.7 ms) |
| `Accessibility` methods | PASS | commands: **`getPartialAXTree` only** — **`getFullAXTree` is ABSENT on M69** | same protocol fetch | `tv-inspector.json` (168.9 ms, incl. the two calls below) |
| `getPartialAXTree(document)` | PASS | **1 node** — no usable tree at the document root | CDP `DOM.getDocument` → `Accessibility.getPartialAXTree` | `tv-inspector.json` |
| DOM walk fallback | PASS | `{"title":"torrent-hub · TV","elements":282,"chars":1517}` | CDP `Runtime.evaluate` | `tv-inspector.json` |
| `cdp.mjs` attach + evaluate | PASS | `Runtime.evaluate('1+1') = 2` | `cdpConnect(ws://127.0.0.1:43411/devtools/page/0C767827…)` | `tv-inspector.json` (29.6 ms) |

### What this settles

1. **`Accessibility.getFullAXTree` does not exist on Tizen 5.5 / Chromium M69.** The digest carried this
   as OPEN ("must probe `/json/protocol` on the device"). The domain is present but exposes only
   `getPartialAXTree`, and calling it on the document root returns **one** node. The sweep's proposed TV
   observation path — raw CDP `Accessibility.getFullAXTree` — **cannot be built as written**; the TV text
   observation has to be a `Runtime.evaluate` DOM walk (measured working: 282 elements, 1517 chars of
   innerText in a single call).
2. **`DOMSnapshot` and `Input` are present**, so a snapshot- or input-based path is available on M69.
3. **`cdp.mjs` attaches and evaluates on the TV unchanged** (`1+1 = 2`, 29.6 ms) — the zero-dep client
   works against the shipped M69 inspector with no version shim.
4. **The debug port is dynamic** (43411 here), confirming `debug.md:30`; hard-coding 9222 would fail.

### Failure mode measured (and why `tv.json` is a FAIL)

`sdb shell 0 debug` **only works while the app is closed** (`debug.md:13`). The probe launched the app on
its first run; a second full run then hung for **30007 ms** and printed no port
(`tv.json` → `sdb.debug: FAIL`). The app was not closed afterwards (it is still on screen), so the launch
step could not be repeated headlessly. `tv-inspector.json` re-measures the *whole inspector half* against
the same forward (port 43411) and passes; that is the reproducible artifact for every CDP fact above.
To re-run the launch half: press EXIT on the TV remote, then
`node plugins/ui-probe/bakeoff/tv/probe.mjs`.

### Side effects on the TV

- The probe launched `torrenthub.tizen` under the inspector; **it is still running** (nobody closed it).
- One `sdb forward tcp:43411 tcp:43411` remains registered; remove with `sdb forward --remove tcp:43411`.
- The app loads its own `content src` (`http://192.168.1.135:8000/tv?tizen=1`) as normal; the bake-off
  sent it no input and no remote key events.

---

## Fairness notes (workarounds, not handicaps)

| Contender | Workaround | Why it does not privilege it |
|---|---|---|
| ssh-batch | `-F NUL`, `UserKnownHostsFile=NUL`, `StrictHostKeyChecking=no` | avoids the NAS config and avoids writing `known_hosts`; the probe still could not authenticate because no sshd exists |
| http-fetch | authenticated task sends the fixture's synthetic cookie | the real hub needs a real session; the fixture mimics `require_profile` (302 → `/pin`) so the unauthenticated transcript is real evidence, not a stub |
| tcp-net | the fixture protocol (banner + echo) is synthetic | all TCP numbers come from the same fixture, started by the harness |
| hurl / qbittorrent | not run | OPEN rows, per instruction — no number was invented for them |
| TV inspector | `--attach-port` skips the sdb half | used only because a second `sdb shell 0 debug` is impossible while the app runs; the CDP measurements are identical to a full run |

## Reproduce

```bash
node --test plugins/ui-probe/bakeoff/protocols/tests/smoke.test.mjs   # offline, 7/7
node plugins/ui-probe/bakeoff/protocols/run.mjs --repeats 5          # RQ7 table + protocols.json
node plugins/ui-probe/bakeoff/tv/probe.mjs                           # RQ6, TV app closed
node plugins/ui-probe/bakeoff/tv/probe.mjs --attach-port 43411       # RQ6 inspector half only
```
