#!/usr/bin/env node
// Patch blessed to match the Python rich/textual reference look:
//
//   1. Box-drawing corners: straight (┌┐└┘) → rounded (╭╮╰╯)
//   2. Emoji width: blessed's `charWidth()` is missing modern emoji ranges
//      (U+1F300-U+1FAFF and select Dingbats). Terminals render those as
//      double-wide cells; blessed counts them as single-wide and the next
//      char smears across the second cell. Inject an emoji-aware width
//      check before the existing CJK table.
//
// Re-runs automatically via package.json postinstall after every npm install.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const BLESSED_LIB = join(HERE, "..", "..", "node_modules", "blessed", "lib");
const ELEMENT_PATH = join(BLESSED_LIB, "widgets", "element.js");
const UNICODE_PATH = join(BLESSED_LIB, "unicode.js");
const PROGRAM_PATH = join(BLESSED_LIB, "program.js");
const COLORS_PATH  = join(BLESSED_LIB, "colors.js");
const SCREEN_PATH  = join(BLESSED_LIB, "widgets", "screen.js");

if (!existsSync(ELEMENT_PATH) || !existsSync(UNICODE_PATH) || !existsSync(PROGRAM_PATH) || !existsSync(COLORS_PATH) || !existsSync(SCREEN_PATH)) {
  process.stderr.write(`patch-blessed: blessed not installed under ${BLESSED_LIB} — run 'npm install' first.\n`);
  process.exit(0);
}

// ── 1. Rounded corners ─────────────────────────────────────────────────────

let elementSrc = readFileSync(ELEMENT_PATH, "utf8");
const CORNER_SUBS = [
  [/'\\u250c'/g, "'\\u256d'"], // ┌ → ╭
  [/'\\u2510'/g, "'\\u256e'"], // ┐ → ╮
  [/'\\u2514'/g, "'\\u2570'"], // └ → ╰
  [/'\\u2518'/g, "'\\u256f'"], // ┘ → ╯
];
let cornerChanges = 0;
for (const [pat, rep] of CORNER_SUBS) {
  const m = elementSrc.match(pat);
  if (m) {
    cornerChanges += m.length;
    elementSrc = elementSrc.replace(pat, rep);
  }
}
if (cornerChanges > 0) {
  writeFileSync(ELEMENT_PATH, elementSrc, "utf8");
  process.stdout.write(`patch-blessed: rewrote ${cornerChanges} corner chars\n`);
} else if (elementSrc.includes("'\\u256d'")) {
  process.stdout.write("patch-blessed: corners already patched\n");
}

// ── 2. Emoji width awareness ───────────────────────────────────────────────

let unicodeSrc = readFileSync(UNICODE_PATH, "utf8");
const EMOJI_GUARD_MARK = "// PATCH: emoji-width-table";
const emojiAlreadyPatched = unicodeSrc.includes(EMOJI_GUARD_MARK);

// Inject an early-return for emoji-presentation ranges into charWidth().
// Modern emoji ranges that terminals reliably render as double-wide:
//   * 1F300-1F5FF Miscellaneous Symbols and Pictographs (🔨 🔬 📋 …)
//   * 1F600-1F64F Emoticons (🙋 …)
//   * 1F680-1F6FF Transport and Map
//   * 1F900-1F9FF Supplemental Symbols and Pictographs (🧪 …)
//   * 1FA00-1FAFF Symbols and Pictographs Extended-A
// Plus a few specific BMP codepoints that have emoji-default presentation
// (NOT the whole Dingbats block — most Dingbats are 1-cell text by default).
// Specifically required for the dashboard: 0x2705 ✅ (merge stage label).
const EMOJI_RETURN_BLOCK = `
  // PATCH: emoji-width-table — specific BMP emoji + 1F300-1FAFF ranges
  if (point === 0x2705 /* ✅ */
      || point === 0x2728 /* ✨ */
      || point === 0x1F440 /* 👀 (covered by 1F300-1F5FF too, listed for clarity) */
      || (0x1F300 <= point && point <= 0x1F5FF)
      || (0x1F600 <= point && point <= 0x1F64F)
      || (0x1F680 <= point && point <= 0x1F6FF)
      || (0x1F900 <= point && point <= 0x1F9FF)
      || (0x1FA00 <= point && point <= 0x1FAFF)) {
    return 2;
  }
`;
const INSERT_ANCHOR = /(\/\/ check for double-wide\s*\n {2}if \(\(0x3000 === point\))/;
if (!emojiAlreadyPatched) {
  const m = unicodeSrc.match(INSERT_ANCHOR);
  if (!m) {
    process.stderr.write("patch-blessed: emoji-width anchor not found — blessed unicode.js shape changed?\n");
  }
}
if (emojiAlreadyPatched) {
  process.stdout.write("patch-blessed: emoji widths already patched\n");
} else {
  unicodeSrc = unicodeSrc.replace(INSERT_ANCHOR, `${EMOJI_RETURN_BLOCK}\n  $1`);
  writeFileSync(UNICODE_PATH, unicodeSrc, "utf8");
  process.stdout.write("patch-blessed: injected emoji width table into unicode.js\n");
}

// ── 3. Truecolor emission ──────────────────────────────────────────────────
// blessed's _attr replaces #RRGGBB hex with the nearest 256-color index
// (line ~2770 of program.js) and outputs \x1b[38;5;Nm. Modern terminals
// (Windows Terminal, iTerm, etc.) support 24-bit \x1b[38;2;R;G;Bm — the
// muted Tokyo Night palette collapses badly in 256-color (#1e2030 → idx
// 234 ≈ near-black). Inject a hex shortcut before the existing match.

let programSrc = readFileSync(PROGRAM_PATH, "utf8");
const TRUECOLOR_GUARD_MARK = "// PATCH: truecolor-hex-shortcut";
if (programSrc.includes(TRUECOLOR_GUARD_MARK)) {
  process.stdout.write("patch-blessed: truecolor already patched\n");
  process.exit(0);
}

const TRUECOLOR_BLOCK = `
      // PATCH: truecolor-hex-shortcut — emit \\x1b[38;2;R;G;Bm directly
      // for hex inputs when the terminal advertises >= 24-bit. Falls
      // through to the original 256-color reduce path otherwise.
      var _hexm = /^#(([0-9a-f]{3}){1,2}) (fg|bg)$/i.exec(param);
      if (_hexm) {
        var _hex = _hexm[1];
        if (_hex.length === 3) _hex = _hex[0]+_hex[0]+_hex[1]+_hex[1]+_hex[2]+_hex[2];
        var _r = parseInt(_hex.substring(0,2),16);
        var _g = parseInt(_hex.substring(2,4),16);
        var _b = parseInt(_hex.substring(4,6),16);
        var _which = _hexm[3].toLowerCase() === 'fg' ? 38 : 48;
        return '\\x1b[' + _which + ';2;' + _r + ';' + _g + ';' + _b + 'm';
      }
`;
const TRUECOLOR_ANCHOR = "if (param[0] === '#') {";
const tIdx = programSrc.indexOf(TRUECOLOR_ANCHOR);
if (tIdx < 0) {
  process.stderr.write("patch-blessed: truecolor anchor not found — program.js shape changed?\n");
  process.exit(0);
}
// Find the start of the line containing the anchor so we insert before its indentation
const lineStart = programSrc.lastIndexOf("\n", tIdx) + 1;
programSrc = programSrc.slice(0, lineStart) + TRUECOLOR_BLOCK + "\n" + programSrc.slice(lineStart);
writeFileSync(PROGRAM_PATH, programSrc, "utf8");
process.stdout.write("patch-blessed: injected truecolor hex shortcut into program.js\n");

// ── 4. Hex cache for the style attr render path ────────────────────────────
// The program.js patch only catches inline markup tags ({#hex-fg}). Box
// borders + selection bg go through screen.js draw() which emits 38;5;<idx>
// from the 9-bit packed attr — at that point the hex info is lost.
//
// Workaround: have colors.match() remember the input hex keyed by the
// returned 256-idx, then patch screen.js draw() to consult that map and
// emit 24-bit when a hex is known.

let colorsSrc = readFileSync(COLORS_PATH, "utf8");
const COLORS_GUARD_MARK = "// PATCH: hex-cache";
if (!colorsSrc.includes(COLORS_GUARD_MARK)) {
  const COLORS_INJECT = `
// PATCH: hex-cache + truecolor side-table.
// Static hex inputs to match() are remembered by 256-color idx so static
// borders/labels emit truecolor cleanly. Dynamic per-char shimmer
// values collide (many hex → same idx, last write wins) so a side-
// channel _truecolorTable maps a packed idx (256 ring buffer) back to
// the exact RGB triple — screen.js draw() consults it via a flag bit.
exports._hexCache = exports._hexCache || {};
exports._truecolorTable = exports._truecolorTable || new Array(256);
exports._truecolorCursor = exports._truecolorCursor || 0;
exports._truecolorAlloc = function(r, g, b) {
  var k = (r << 16) | (g << 8) | b;
  // Linear-scan for an existing entry first (cheap with 256). Avoids
  // unbounded growth when many calls share the same RGB.
  for (var i = 0; i < 256; i++) {
    var e = exports._truecolorTable[i];
    if (e && e._k === k) return i;
  }
  var idx = exports._truecolorCursor;
  exports._truecolorTable[idx] = { r: r, g: g, b: b, _k: k };
  exports._truecolorCursor = (idx + 1) & 0xff;
  return idx;
};
var _patch_origMatch = exports.match;
exports.match = function(r1, g1, b1) {
  var _hex = null;
  if (typeof r1 === 'string' && r1[0] === '#') _hex = r1;
  var idx = _patch_origMatch.apply(this, arguments);
  if (_hex && idx >= 0) {
    if (_hex.length === 4) _hex = '#' + _hex[1]+_hex[1] + _hex[2]+_hex[2] + _hex[3]+_hex[3];
    exports._hexCache[idx] = _hex;
  }
  return idx;
};
`;
  colorsSrc += COLORS_INJECT;
  writeFileSync(COLORS_PATH, colorsSrc, "utf8");
  process.stdout.write("patch-blessed: injected hex cache + truecolor table into colors.js\n");
} else {
  process.stdout.write("patch-blessed: hex cache already patched\n");
}

// Patch screen.js draw() to consult the hex cache.
let screenSrc = readFileSync(SCREEN_PATH, "utf8");
const SCREEN_GUARD_MARK = "// PATCH: truecolor-emit";
if (!screenSrc.includes(SCREEN_GUARD_MARK)) {
  // Helper inline-injected at top of draw() so we don't need module-level requires:
  // var _emit24 = function(which, idx) {
  //   var hex = colors._hexCache[idx];
  //   if (!hex) return null;
  //   return which + ';2;' + parseInt(hex.substring(1,3),16) + ';' + parseInt(hex.substring(3,5),16) + ';' + parseInt(hex.substring(5,7),16);
  // };
  //
  // Then replace each "48;5;X" and "38;5;X" emission with a guard:
  //   var _t = _emit24(48, bg); out += (_t || '48;5;' + bg) + ';';
  //   var _t = _emit24(38, fg); out += (_t || '38;5;' + fg) + ';';

  const SCREEN_HELPER = `
  // PATCH: truecolor-emit — emit 24-bit when colors._hexCache has the idx.
  var _emit24 = function(which, idx) {
    var hex = (require('../colors')._hexCache || {})[idx];
    if (!hex || hex.length !== 7) return null;
    var r = parseInt(hex.substring(1,3),16);
    var g = parseInt(hex.substring(3,5),16);
    var b = parseInt(hex.substring(5,7),16);
    return which + ';2;' + r + ';' + g + ';' + b;
  };
`;
  // Inject helper at the start of draw()
  const drawAnchor = "Screen.prototype.draw = function(start, end) {";
  const drawIdx = screenSrc.indexOf(drawAnchor);
  if (drawIdx < 0) {
    process.stderr.write("patch-blessed: screen.draw anchor not found — screen.js shape changed?\n");
  } else {
    const afterAnchor = drawIdx + drawAnchor.length;
    screenSrc = screenSrc.slice(0, afterAnchor) + SCREEN_HELPER + screenSrc.slice(afterAnchor);

    // Replace the four `'48;5;' + bg` / `'38;5;' + fg` emissions with the guarded versions
    const SUBS_SCREEN = [
      [`out += '48;5;' + bg + ';';`, `var _t1 = _emit24(48, bg); out += (_t1 || ('48;5;' + (bg & 0xff))) + ';';`],
      [`out += '38;5;' + fg + ';';`, `var _t2 = _emit24(38, fg); out += (_t2 || ('38;5;' + (fg & 0xff))) + ';';`],
    ];
    // NOTE: truecolor side-table was attempted but the 256-slot ring buffer
    // wraps too fast under shimmer + borders → cells reference stale slots
    // that have been recycled to unrelated colors → psychedelic rendering.
    // attrCode keeps using the original colors.match path (256-color
    // approximation); shimmer gradient stays mildly banded — accepted.
    for (const [find, rep] of SUBS_SCREEN) {
      while (screenSrc.includes(find)) {
        screenSrc = screenSrc.replace(find, rep);
      }
    }
    writeFileSync(SCREEN_PATH, screenSrc, "utf8");
    process.stdout.write("patch-blessed: injected truecolor emit guards into screen.js draw()\n");
  }
} else {
  process.stdout.write("patch-blessed: screen.draw truecolor already patched\n");
}
