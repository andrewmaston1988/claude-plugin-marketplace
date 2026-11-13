---
name: /ui-probe
description: Capture a screen, run a UI probe scenario, or check the probe setup
entry: shell
---

## Run ui-probe

```
${CLAUDE_PLUGIN_ROOT}/bin/ui-probe.mjs $ARGUMENTS
```

For a TV-backend journey, `--device desktop` (the default) runs it in desktop Chromium with TV-sized dimensions and remote-key events. Use `--device tv` to attach to the configured Tizen set. Set `tv.host` and `tv.appid` in `.ui-probe.json`; run `/ui-probe doctor` first. For example, a journey with `open: { url: "http://127.0.0.1:8001/tv" }` can run on the set with `/ui-probe run tv-nav.yaml --device tv`.

`/ui-probe tv probe --navigate http://127.0.0.1:8001` measures the loaded page's Tizen APIs, video support, remote keys and navigation reach. It writes `platform.json` and ends with a verdict such as `shell: plan B — registerKey("1") absent; getCurrentApplication() absent`.

## Suggest next step

Read the exit code and the digest, then:
- `validate` reported problems → fix the named field and run it again
- exit 3 `needs_review` → the scenario asserts nothing; add an assertion and re-run
- exit 64 → the scenario, config or arguments are invalid; the named field says which
- `doctor` failed → fix the named check before anything else
- `blocked: <n>` → the read-only network guard stopped and recorded `<n>` intercepted writes. If the page writes on load, those writes appear in every capture; inspect `network.json` for their method and URL.
