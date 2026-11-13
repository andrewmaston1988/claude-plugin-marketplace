// Bake-off scenario examples, kept as YAML text so the parser is exercised on
// real documents. They live in a module rather than .yaml files because the
// plugin ships only .mjs/.md/.json.

export const scenarios = {
  't1-layout': `id: t1-layout
backend: browser
steps:
  - viewport: { width: 390, height: 844, touch: true }
  - open: { url: "http://127.0.0.1:18771/sheet.html" }
  - expect_widths:
      target: "[data-testid=action-tile]"
      equals: [111, 111, 111]
      tolerance: 1
`,

  't2-hover': `id: t2-hover
backend: browser
steps:
  - viewport: { width: 1280, height: 900 }
  - open: { url: "http://127.0.0.1:18771/sheet.html" }
  - hover: { target: "[data-testid=rec-tile]" }
  - expect_css: { target: "[data-testid=hover-bar]", property: "opacity", equals: "1" }

  - viewport: { width: 390, height: 844, touch: true }
  - open: { url: "http://127.0.0.1:18771/sheet.html" }
  - tap: { target: "[data-testid=rec-tile]" }
  - expect_css: { target: "[data-testid=hover-bar]", property: "opacity", equals: "0" }
`,

  'http-health': `id: http-health
backend: http
steps:
  - expect_json:
      url: "http://127.0.0.1:18772/health"
      path: ok
      equals: true
`,
};
