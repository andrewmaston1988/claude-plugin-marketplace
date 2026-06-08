// Visual animations driven by Date.now() so callers don't manage frame counters:
//   - spin / queueSpin / claudeSpin    (rotating frame selection)
//   - shimmerRunning(label, hex)       (sweeping brightness across chars)
//   - shimmerStage(label, hex, elapsed) (per-char HSL wave, fades over 60s)
//   - marquee(text, width)              (scrolling window with separator)
//
// All driven by Date.now() so callers don't manage frame counters.
import {
  SPIN_FRAMES, SPIN_TICK_HZ,
  QUEUE_SPIN_FRAMES, QUEUE_SPIN_TICK_HZ,
  CLAUDE_SPIN_FRAMES, CLAUDE_SPIN_TICK_HZ,
  SHIMMER_AMP_RUN, SHIMMER_AMP_STAGE, SHIMMER_FADE_SECS,
  MARQUEE_WIDTH, MARQUEE_SPEED, MARQUEE_SEP,
} from "./style.mjs";

function _now() { return Date.now() / 1000; }
function _pick(frames, hz) { return frames[Math.floor(_now() * hz) % frames.length]; }

export function spin()       { return _pick(SPIN_FRAMES,        SPIN_TICK_HZ); }
export function queueSpin()  { return _pick(QUEUE_SPIN_FRAMES,  QUEUE_SPIN_TICK_HZ); }
export function claudeSpin() { return _pick(CLAUDE_SPIN_FRAMES, CLAUDE_SPIN_TICK_HZ); }

function _hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _clamp(x) { return Math.max(0, Math.min(255, Math.round(x))); }
function _hexFromRgb(r, g, b) {
  return "#" + [_clamp(r), _clamp(g), _clamp(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// HSL helpers used by shimmerStage to brighten / saturate per-character.
function _rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const v = mx;
  const d = mx - mn;
  s = mx === 0 ? 0 : d / mx;
  if (mx !== mn) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, v];
}
function _hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

// Iterate by code point (string iterator), NOT by code unit — otherwise
// surrogate pairs (🔨 🧪 🙋 …) get split across two markup wrappers and
// blessed writes each surrogate to a separate cell, rendering as
// replacement chars (��).
function _chars(s) { return Array.from(s); }

// Sweeping brightness shimmer across label characters.
export function shimmerRunning(label, hexColor) {
  const [r0, g0, b0] = _hexToRgb(hexColor);
  const amp = SHIMMER_AMP_RUN;
  const stops = [
    [r0 * (1 - amp), g0 * (1 - amp), b0 * (1 - amp)],
    [r0, g0, b0],
    [r0 * (1 + amp), g0 * (1 + amp), b0 * (1 + amp)],
    [r0, g0, b0],
    [r0 * (1 - amp), g0 * (1 - amp), b0 * (1 - amp)],
  ];
  const phase = _now() * 2.0;
  const chars = _chars(label);
  const n = Math.max(chars.length, 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const pos = ((Math.sin((phase - (i / n) * 1.2) * 2 * Math.PI) + 1) / 2) * 0.5;
    const seg = pos * (stops.length - 1);
    const si = Math.floor(seg);
    const frac = seg - si;
    const a = stops[Math.min(si, 3)];
    const b = stops[Math.min(si + 1, 4)];
    const r = a[0] + (b[0] - a[0]) * frac;
    const g = a[1] + (b[1] - a[1]) * frac;
    const bb = a[2] + (b[2] - a[2]) * frac;
    out += `{${_hexFromRgb(r, g, bb)}-fg}${chars[i]}{/}`;
  }
  return out;
}

// Per-character brightness wave on stage label, amplitude fading to zero
// at SHIMMER_FADE_SECS (60s by default).
export function shimmerStage(label, hexColor, elapsedSecs) {
  const [r0, g0, b0] = _hexToRgb(hexColor);
  const [hue, sat, val] = _rgbToHsv(r0, g0, b0);
  const amp = SHIMMER_AMP_STAGE * Math.max(0.0, 1.0 - elapsedSecs / SHIMMER_FADE_SECS);
  if (amp <= 0) return `{bold}{${hexColor}-fg}${label}{/}{/bold}`;
  const phase = _now() * 6.0;
  const chars = _chars(label);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const wave = Math.sin(phase - i * 0.5) * amp;
    const v = Math.max(0.15, Math.min(1.0, val + wave));
    const [sr, sg, sb] = _hsvToRgb(hue, sat, v);
    out += `{bold}{${_hexFromRgb(sr, sg, sb)}-fg}${chars[i]}{/}{/bold}`;
  }
  return out;
}

// Scrolling window into `text` when it exceeds `width` chars. Otherwise
// returned unchanged.
export function marquee(text, width = MARQUEE_WIDTH, speed = MARQUEE_SPEED) {
  if (text.length <= width) return text;
  const padded = text + MARQUEE_SEP;
  const offset = Math.floor(_now() * speed) % padded.length;
  const doubled = padded + padded;
  return doubled.slice(offset, offset + width);
}
