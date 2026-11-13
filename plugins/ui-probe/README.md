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

## Configuration

| Key | Type | Meaning |
| --- | --- | --- |
| `baseUrl` | string, required | Prefix for URLs beginning with `/`. |
| `viewports` | object | Named `{width, height, dpr?, touch?}` viewports. Built-ins: `phone` (390×844, DPR 3, touch) and `desktop` (1280×900). |
| `screens` | object | Named `{url, steps?, measure?}` screens. `steps` run before capture; `measure` lists CSS selectors to measure. |
| `auth.cookies` | array | Cookie entries `{name, command: [argv...], domain?}`. The command's stdout supplies the cookie value. |
| `outDir` | string | Output directory; defaults to `<os tmpdir>/ui-probe/<stamp>`. |
| `browser` | string | Browser executable path, overriding discovery. |

Cookie commands run as argv arrays without a shell, from the config directory. `{var}` substitution is forbidden in the executable and substituted values cannot contain path separators or shell metacharacters. Pass variables with `--var k=v`.

`capture --url <url>` captures an ad hoc URL without screen steps or measurements. `--viewport` selects comma-separated viewport names; the default is `phone,desktop`. `--out` selects the output location, and `--include-background` adds a DOM observation behind an open modal.

## Outputs

Capture produces `screenshot.png`, `dom.html`, `measure.json`, `console.json`, `network.json`, `assets.json`, `env.json`, and `observation.txt` per viewport. Measurements contain boxes for each matching selector; the environment records the page's reported pointer and hover capabilities. The stdout digest reports viewport dimensions, pointer and hover, measured widths, blocked request count, and output directory. Traffic records contain method, URL, status, and whether blocked, without headers. Cookie values are not written to outputs or the digest.

Scenario runs write `results.json` with each step's source, operation, optional target, outcome, failure, measured and expected values, and duration. The digest reports each step and the overall outcome and output directory. Runs return 0 for passed, 1 for failed, 2 for inconclusive, 3 for needs review, and 64 for invalid input.

## Read-only guard

By default, before a click or tap the action allowlist refuses a non-GET form submit as `write_blocked`. A CDP Fetch guard also blocks and records requests other than GET, HEAD, and OPTIONS. `--allow-writes` disables both layers for that capture or run. Neither layer can stop a GET request with a side effect; use a safe target environment.

## Limitations

Only Chromium-family browsers and CSS selectors are supported. There is no warm session, delta observation, or comparison in this release. A desktop browser at TV resolution does not reproduce a TV browser.
