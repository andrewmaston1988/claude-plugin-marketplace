import { createHash } from "node:crypto";

const THINKING_TOKENS = Buffer.from('"subtype":"thinking_tokens"');

function shouldDrop(line) {
  if (!line.includes(THINKING_TOKENS)) return false;
  try {
    const event = JSON.parse(line.toString("utf8"));
    return event.type === "system" && event.subtype === "thinking_tokens";
  } catch {
    return false;
  }
}

// ── image stripping ───────────────────────────────────────────────────────────
// Each image block becomes a stub keeping its position, media type and a digest.
// The two byte gates are independent (a block has no `"data":"` key, a data URL no
// `"type":"image"` object), so an ordinary line never pays for a parse.
const IMAGE_TYPE_GATE = Buffer.from('"type":"image"');
const DATA_URL_GATE = Buffer.from("data:image/");
const STUB = "[stripped]";
const STUB_PREFIX = "[stripped";
const DATA_URL_RE = /^data:(image\/[^;,]+);base64,([\s\S]*)$/;

const digest = (buf) => createHash("sha256").update(buf).digest("hex");

function stubDataUrl(value) {
  const m = DATA_URL_RE.exec(value);
  // A stub is left alone, so a second pass over the same line is byte-identical.
  if (!m || m[2].startsWith(STUB_PREFIX)) return value;
  const raw = Buffer.from(m[2], "base64");
  return `data:${m[1]};base64,[stripped bytes=${raw.length} sha256=${digest(raw)}]`;
}

// Replaces every image-shaped value in place, at any depth: tool results nest
// images inside `content` arrays. Returns the number of replacements made.
function stripValue(value, counts) {
  if (typeof value === "string") {
    const next = stubDataUrl(value);
    if (next !== value) counts.n++;
    return next;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = stripValue(value[i], counts);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (value.type === "image" && value.source && typeof value.source === "object"
      && value.source.type === "base64" && typeof value.source.data === "string") {
    const source = value.source;
    if (source.data !== STUB) {
      const raw = Buffer.from(source.data, "base64");
      source.data = STUB;
      source.bytes = raw.length;
      source.sha256 = digest(raw);
      counts.n++;
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    // Codex coverage measures this field's bytes and line windows, so stripping
    // inside it would move the very windows coverage is checked against.
    if (key === "aggregated_output" && value.type === "command_execution") continue;
    value[key] = stripValue(value[key], counts);
  }
  return value;
}

// One transcript line in, one out. A line that replaced nothing — or that does not
// parse — is returned as the SAME buffer: re-serialising would rewrite number forms,
// escapes and key order, and a torn write must stay exactly as torn as it was.
export function stripImages(line) {
  const buf = Buffer.isBuffer(line) ? line : Buffer.from(line);
  if (!buf.includes(IMAGE_TYPE_GATE) && !buf.includes(DATA_URL_GATE)) return buf;
  const text = buf.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return buf;
  }
  const counts = { n: 0 };
  const walked = stripValue(parsed, counts);
  if (counts.n === 0) return buf;
  const eol = text.endsWith("\r\n") ? "\r\n" : text.endsWith("\n") ? "\n" : "";
  return Buffer.from(JSON.stringify(walked) + eol, "utf8");
}

// `push`/`end` return whether anything was dropped or stripped so far, which lets a
// rewriter skip a file that would come out byte-identical.
export function createLogLineFilter(write) {
  let pending = [];
  let pendingLength = 0;
  let ended = false;
  let changed = false;
  const writeLine = (line) => {
    if (shouldDrop(line)) { changed = true; return; }
    const stripped = stripImages(line);
    if (stripped !== line) changed = true;
    write(stripped);
  };
  const completeLine = (chunk, start, end) => {
    const segment = chunk.subarray(start, end);
    const line = pendingLength === 0
      ? segment
      : Buffer.concat([...pending, segment], pendingLength + segment.length);
    writeLine(line);
    pending = [];
    pendingLength = 0;
  };

  return {
    push(chunk) {
      if (ended) return changed;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0A, start);
        if (newline < 0) break;
        completeLine(bytes, start, newline + 1);
        start = newline + 1;
      }
      if (start < bytes.length) {
        const remainder = bytes.subarray(start);
        pending.push(remainder);
        pendingLength += remainder.length;
      }
      return changed;
    },
    end() {
      if (ended) return changed;
      ended = true;
      if (pendingLength > 0) writeLine(Buffer.concat(pending, pendingLength));
      pending = [];
      pendingLength = 0;
      return changed;
    },
  };
}
