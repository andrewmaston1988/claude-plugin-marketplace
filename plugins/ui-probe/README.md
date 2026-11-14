# ui-probe

Capture and test web interfaces using an installed Chromium-family browser and Node.js 22. The plugin uses Node's built-in APIs and needs no npm install.

## Setup

Install Edge, Chrome, Chromium, or Brave. Browser discovery checks common installations; set `browser` in `.ui-probe.json` to an executable path to override discovery. Install the plugin from the marketplace, or load a checkout with `claude --plugin-dir /path/to/claude-plugin-marketplace/plugins/ui-probe`. Run `/ui-probe doctor` to check the browser, config, and base URL.

Create `.ui-probe.json` in your project:

```json
{
  "baseUrl": "http://localhost:3000",
  "screens": {
    "home": { "url": "/", "measure": ["main"] }
  }
}
```

Use `/ui-probe screens` to list screens, `/ui-probe capture home --viewport phone,desktop` to capture, and `/ui-probe run scenario.yaml` to run a scenario. `/ui-probe validate scenario.yaml` checks a scenario; `/ui-probe validate --config` checks config.

### Tizen TV setup

On the TV, enable Developer Mode and note its IP address. Developer Mode switches itself off after two weeks, so enable it again if `/ui-probe doctor` reports that the TV is not listed. Install the Tizen SDK so `sdb` is on PATH, or set `tv.sdb` to the sdb executable. The TV's developer connection usually uses port `26101`; use the host value shown by Developer Mode, including its port. Set the installed application id from `sdb shell 0 applist`.

Add a `tv` block to `.ui-probe.json`:

```json
{
  "baseUrl": "http://127.0.0.1:8001",
  "tv": {
    "host": "192.0.2.10:26101",
    "appid": "example.app",
    "sdb": "C:/tizen-studio/tools/sdb.exe",
    "testOrigin": "http://127.0.0.1:8001",
    "focusSelector": ".focused"
  }
}
```

`tv.host` is the TV's developer-mode address and port. `tv.appid` is the installed widget application id. `tv.sdb` is optional; omit it when `sdb` is on PATH or in a standard Tizen SDK location. `tv.testOrigin` is the origin allowed to receive writes when a TV journey uses `--allow-writes`; use a test server, not a live service. `tv.focusSelector` is optional and defaults to `.focused`; it selects the app element whose focus marker should be shown in observations.

Run `/ui-probe doctor` to check `sdb`, the connected TV, and the configured app id. `/ui-probe run journey.yaml --device tv` attaches to the set. Use `--device desktop` (the default) to run the same TV journey in desktop Chromium for faster iteration. `/ui-probe tv probe --navigate http://127.0.0.1:8001` records the platform probe and its shell verdict, waiting for the app's page to settle first and naming that page in every step and in the verdict; add `--listen` for the guided physical-press check, `--fetch <url>` for one credentialed GET from the page, and `--exit` to exit the app last and report whether the inspector closed.

`--listen` walks the operator through one key at a time: the TV shows a large banner naming the key, ticks the press with the `key`, `code` and `keyCode` it received, or reports "not received" after `--listen-wait <seconds>` (default 8), then moves on. The CLI prints the key list and the wait before the first banner appears. The list defaults to `Left`, `Right`, `Digit1` and `MediaPlay`, plus `Enter` and `Back` only when `--navigate` reached the test URL — Back at the app's root exits it. Pass a comma-separated list of key names to choose your own, for example `--listen MediaPlay,Left`. Each key's outcome is recorded in `platform.json` under `listen.results`. Before each banner the check registers that key with `tizen.tvinputdevice.registerKey` and unregisters it after the result — only the arrows, Enter and Back reach a Tizen page unregistered — so each result also carries its `register` outcome (`returned`, `absent`, `threw`, or `not-needed`), and a miss whose register did not return reads `(registerKey absent)` or `(registerKey threw)` in the digest and on the TV.

The TV write guard blocks and records intercepted write requests outside the configured test origin. It cannot stop a GET request with a side effect. With `--allow-writes`, writes to the configured test origin are allowed, and writes the app makes to other origins remain blocked; the guard cannot stop writes the app makes outside the test origin through mechanisms that do not use intercepted network requests.

## Configuration

| Key | Type | Meaning |
| --- | --- | --- |
| `baseUrl` | string, required | Prefix for URLs beginning with `/`. |
| `viewports` | object | Named `{width, height, dpr?, touch?}` viewports. Built-ins: `phone` (390×844, DPR 3, touch) and `desktop` (1280×900). |
| `screens` | object | Named `{url, steps?, measure?}` screens. `steps` run before capture; `measure` lists CSS selectors to measure. |
| `auth.cookies` | array | Cookie entries `{name, command: [argv...], domain?}`. The command's stdout supplies the cookie value. |
| `outDir` | string | Output directory; defaults to `<os tmpdir>/ui-probe/<stamp>`. |
| `browser` | string | Browser executable path, overriding discovery. |
| `tv` | object | Optional TV settings: `host`, `appid`, optional `sdb`, `testOrigin`, and `focusSelector`. |

Cookie commands run as argv arrays without a shell, from the config directory. `{var}` substitution is forbidden in the executable and substituted values cannot contain path separators or shell metacharacters. Pass variables with `--var k=v`.

`capture --url <url>` captures an ad hoc URL without screen steps or measurements. `--viewport` selects comma-separated viewport names; the default is `phone,desktop`. `--out` selects the output location, and `--include-background` adds a DOM observation behind an open modal.

## Outputs

Browser capture produces `screenshot.png`, `dom.html`, `measure.json`, `console.json`, `network.json`, `assets.json`, `env.json`, and `observation.txt` per viewport. TV capture writes these outputs under `<outDir>/tv/`; it writes `screenshot.png` only when `--screenshot` is supplied. The TV screenshot is an operator artifact, not an input for agent analysis. Measurements contain boxes for each matching selector; the environment records the page's reported pointer and hover capabilities. The stdout digest reports viewport dimensions, pointer and hover, measured widths, blocked request count, and output directory. Traffic records contain method, URL, status, and whether blocked, without headers. Cookie values are not written to outputs or the digest.

Scenario runs write `results.json` with each step's source, operation, optional target, outcome, failure, measured and expected values, and duration. A step's source is `<file>:<line>` where the step is written, or `<file>#step<n>` — its position in that file — when no line is known; a step spliced from an include names the include as written, with its line in that file. A browser-backed run also writes `console.json` and `network.json` beside `results.json`, in the shape a capture writes them; a TV run records from the moment it attaches. The digest reports each step and the overall outcome and output directory. Runs return 0 for passed, 1 for failed, 2 for inconclusive, 3 for needs review, and 64 for invalid input.

## Read-only guard

By default, before a click or tap the action allowlist refuses a non-GET form submit as `write_blocked`. A CDP network guard also blocks and records requests other than GET, HEAD, and OPTIONS. `--allow-writes` disables the action guard; on TV it allows intercepted writes only to `tv.testOrigin`, while writes to other origins remain blocked and recorded. Neither guard can stop a GET request with a side effect, and the network guard cannot stop writes made outside intercepted network requests. Use a safe target environment.

## Limitations

Only Chromium-family browsers and CSS selectors are supported. There is no warm session, delta observation, or comparison in this release. A desktop browser at TV resolution does not reproduce a TV browser.
