// Shipped step library for the Gherkin contender. Every step compiles to one IR
// step, so a Gherkin scenario measures exactly what a flat scenario measures.
const SHEET = 'http://127.0.0.1:18771/sheet.html';

function num(text) {
  return Number(text);
}

function literal(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

export const steps = [
  { pattern: /^the fixture sheet page is open$/, build: () => ({ open: { url: SHEET } }) },
  { pattern: /^the viewport is (\d+)x(\d+)$/, build: (m) => ({ viewport: { width: num(m[1]), height: num(m[2]) } }) },
  { pattern: /^a touch viewport of (\d+)x(\d+)$/, build: (m) => ({ viewport: { width: num(m[1]), height: num(m[2]), touch: true } }) },
  { pattern: /^I hover "(.+)"$/, build: (m) => ({ hover: { target: m[1] } }) },
  { pattern: /^I tap "(.+)"$/, build: (m) => ({ tap: { target: m[1] } }) },
  { pattern: /^I click "(.+)"$/, build: (m) => ({ click: { target: m[1] } }) },
  { pattern: /^"(.+)" is visible$/, build: (m) => ({ expect_visible: { target: m[1] } }) },
  { pattern: /^"(.+)" is hidden$/, build: (m) => ({ expect_hidden: { target: m[1] } }) },
  {
    pattern: /^each of "(.+)" is (\d+(?:\.\d+)?) px wide within (\d+(?:\.\d+)?) px$/,
    build: (m) => ({ expect_widths: { target: m[1], equals: [num(m[2])], tolerance: num(m[3]) } }),
  },
  {
    pattern: /^"(.+)" has CSS "(.+)" equal to "(.+)"$/,
    build: (m) => ({ expect_css: { target: m[1], property: m[2], equals: m[3] } }),
  },
  { pattern: /^"(.+)" contains the text "(.+)"$/, build: (m) => ({ expect_text: { target: m[1], equals: m[2] } }) },
  {
    pattern: /^GET "(.+)" returns JSON field "(.+)" equal to "(.+)"$/,
    build: (m) => ({ expect_json: { url: m[1], path: m[2], equals: literal(m[3]) } }),
  },
  {
    pattern: /^the TCP banner from port (\d+) is "(.*)"$/,
    build: (m) => ({ tcp_banner: { port: num(m[1]), equals: m[2] } }),
  },
  {
    pattern: /^the text of control "(.+)" in window "(.+)" is "(.*)"$/,
    build: (m) => ({ uia_text: { control: m[1], window: m[2], equals: m[3] } }),
  },
];
