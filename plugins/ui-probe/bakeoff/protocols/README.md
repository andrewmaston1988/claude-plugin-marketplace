# Protocols + TV bake-off (RQ7, RQ6)

Re-run guide for this lane. The measured numbers and findings live in
`../results/protocols-tv.md`; this file is only how to reproduce them.

## Run

```bash
# offline smoke test: every egress point faked at call time, no socket opened
node --test plugins/ui-probe/bakeoff/protocols/tests/smoke.test.mjs

# RQ7 — fetch, node:net, ssh.exe, Hurl, qBittorrent; 5 repeats each
node plugins/ui-probe/bakeoff/protocols/run.mjs --repeats 5
node plugins/ui-probe/bakeoff/protocols/run.mjs --only http,tcp   # one family

# RQ6 — the TV (requires developer mode on; the app must be closed first)
node plugins/ui-probe/bakeoff/tv/probe.mjs
node plugins/ui-probe/bakeoff/tv/probe.mjs --attach-port <port>   # inspector half only
```

Artifacts land in `../results/artifacts/`:
`protocols.json`, `tv.json`, `tv-inspector.json`.

## Shapes

- `harness.mjs` — the only place tasks are driven, timed, counted and shaped. Add a contender by
  writing an adapter, not by touching the harness.
- `tasks.mjs` — task definitions and their reference values. Every contender is verified by the same
  `verify()`.
- `allow.mjs` — one allowlist predicate per transport (`httpPolicy`, `tcpPolicy`, `sshPolicy`,
  `sdbPolicy`) plus `guarded()`. Modelled on `rts-mobile/tools/frame-witness.mjs:29`.
- `redact.mjs` — Cookie / Set-Cookie / Authorization / Proxy-Authorization / X-Api-Key values are
  replaced before a transcript string exists.
- `adapters/` — thin contenders: `http-fetch`, `tcp-net`, `ssh-batch`, `hurl`, `qbittorrent`.
- `fixtures/` — the local `node:http` hub stand-in, the TCP echo server, and the `:8001` detector.
  The HTTP probe uses a hub already listening on `:8001` if there is one, otherwise this fixture.
  It never contacts `:8000`.

## Adding a contender

Implement `{ id, label, tasks, guard: { mechanism, describe, bite }, probe(task) }` and add it to the
array in `run.mjs`. `probe` returns `{ transcript, meta }`, or `{ open: { reason, probe } }` when the
environment cannot run it. Do not add a default dependency inside a factory — pass it in, so the
offline test can drive the new adapter with fakes.
