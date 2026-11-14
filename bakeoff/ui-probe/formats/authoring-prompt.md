# Scenario authoring prompt — RQ8

This file is the prompt template an authoring leaf receives. Everything below the rule
is handed to the leaf verbatim, with the `{{...}}` placeholders substituted.

**Dispatcher rules (not shown to the leaf):**

- One leaf = one task + one format. Never two tasks in one prompt.
- `{{EXAMPLE}}` is the **whole contents** of one shipped example from
  `scenarios/<format>/examples/` whose task id **differs** from the target task. Never
  the example for the task being authored — that would hand over the answer.
- `{{FORMAT_BRIEF}}` is exactly one of the three format briefs in the appendix, matching
  the format the leaf is writing. Do not include the other two.
- `{{OUTPUT_PATH}}` is
  `bakeoff/ui-probe/formats/attempts/{{FORMAT}}/{{MODEL}}/{{TASK_ID}}/attempt-{{N}}.{{EXT}}`.
- Give the leaf no other repository context, no validator source, and no reference to
  another format. The measurement is "can this model write this format from one example".

---

# Write one UI scenario

You are writing a single automation scenario. Someone else built the fixtures; the app,
the servers and the desktop window described below are already running. Your job is to
write the scenario file that checks one thing and asserts the exact values given.

## The task

**{{TASK_TITLE}}**

{{TASK_ASK}}

Reference values, which your scenario must assert:

```
{{REFERENCE_VALUES}}
```

## Where to write it

Write exactly one file:

```
{{OUTPUT_PATH}}
```

Nothing else. Do not create helper files, READMEs or notes.

## The format

{{FORMAT_BRIEF}}

## One worked example

This is a complete, working scenario in the same format, for a **different** task. Copy
its shape, not its content.

```{{EXAMPLE_LANGUAGE}}
{{EXAMPLE}}
```

## Rules

- Assert the reference values above. A scenario that runs without asserting the pinned
  values scores as wrong.
- Use only the fixtures named in the task. Do not start servers, open other pages or
  touch anything on the machine.
- No arbitrary sleeps. Wait on the condition you are asserting.
- Do not run the scenario, do not open a browser, and do not execute the file. It is
  scored on the first version you write — debugging it yourself defeats the measurement.
- If the format supports only part of the task, write the part it supports and stop.

---

## Appendix — format briefs (substitute one)

### Format brief: `playwright-test`

Write a Playwright Test spec in TypeScript.

- `import { test, expect } from '@playwright/test'` — the harness provides that specifier.
- File extension `.spec.ts`. Everything runs headless Chromium against the running fixtures.
- Desktop viewport: `test.use({ viewport: { width: 1280, height: 900 } })`.
  Touch viewport: `test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })`.
- The detail sheet is at `http://127.0.0.1:18771/sheet.html`; its controls carry
  `data-testid` attributes.
- Non-browser fixtures (a Windows window, a TCP listener) are reached through a probe CLI:

  ```ts
  import { execFileSync } from 'node:child_process';
  const out = execFileSync(process.execPath,
    [process.env.UI_PROBE_PROBE_CLI, 'uia', '--window', 'ui-probe-fixture', '--control', 'ValueBox'],
    { encoding: 'utf8' });
  JSON.parse(out); // { text: "..." }
  ```

  Subcommands: `http --url <url>` → `{ status, body, text }`; `tcp --port <port>` →
  `{ banner }`; `uia --window <title> --control <name>` → `{ text }`.
- One `test(...)` per behaviour, each with a real `expect(...)`. No `.only`, no `.skip`.

### Format brief: `flat-yaml`

Write a flat YAML step list — a top-level `id`, `task`, `backend`, and a `steps` sequence.
Each step is an object with **exactly one** op key.

```yaml
id: <task id>
task: <task id>
backend: browser | network | desktop
steps:
  - <op>: { <parameters> }
```

Ops and their parameters:

| op | parameters |
|---|---|
| `open` | `url` |
| `viewport` | `width`, `height`, optional `touch: true` |
| `hover` / `tap` / `click` | `target` |
| `expect_visible` / `expect_hidden` | `target`, optional `timeoutMs` |
| `expect_widths` | `target`, `equals: [numbers]`, optional `tolerance` |
| `expect_css` | `target`, `property`, `equals`, optional `tolerance` |
| `expect_text` | `target`, `equals` |
| `expect_json` | `url`, `path`, `equals` |
| `tcp_banner` | `port`, `equals`, optional `host` |
| `uia_text` | `window`, `control`, `equals` |

A `target` is a CSS selector, or `role=<role>[name="<name>"]`. Assertions that can change
over time retry until they hold or the step times out. A single `equals` value in
`expect_widths` applies to every matched element.

### Format brief: `gherkin`

Write a Gherkin feature file: one `Feature:`, one or more `Scenario:`, and steps using
`Given` / `When` / `Then` / `And`. Every step line must match a binding in the shipped
step library — a step nothing binds is not executable and the scenario is rejected.

Available steps (parameters in quotes are literal text from the feature):

```gherkin
Given the fixture sheet page is open
Given the viewport is 1280x900
Given a touch viewport of 390x844
When I hover "<target>"
When I tap "<target>"
When I click "<target>"
Then "<target>" is visible
Then "<target>" is hidden
Then each of "<target>" is 111 px wide within 1 px
Then "<target>" has CSS "<property>" equal to "<value>"
Then "<target>" contains the text "<text>"
Then GET "<url>" returns JSON field "<path>" equal to "<value>"
Then the TCP banner from port <port> is "<text>"
Then the text of control "<control>" in window "<window>" is "<text>"
```

`<target>` follows the same rule as the flat format: a CSS selector or
`role=<role>[name="<name>"]`. If you need a step the library does not have, you may also
write a `<same-basename>.steps.mjs` beside the feature exporting
`steps = [{ pattern: /regex/, build: (m) => ({ <op>: { ... } }) }]` using the same ops as
the flat format — but prefer the library.
