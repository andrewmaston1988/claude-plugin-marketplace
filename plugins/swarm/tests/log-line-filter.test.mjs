import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { deepEqual, equal, ok, strictEqual } from "node:assert/strict";
import { createLogLineFilter, stripImages } from "../src/log-line-filter.mjs";
import { parseReadCalls } from "../src/coverage.mjs";

const tokenLine = Buffer.from('{"type":"system","subtype":"thinking_tokens","estimated_tokens":1}\n');
const writeAll = (chunks) => Buffer.concat(chunks);

test("log line filter drops only system thinking_tokens events", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  filter.push(Buffer.concat([
    Buffer.from('{"type":"system","subtype":"init"}\n'),
    tokenLine,
    Buffer.from('{"type":"result","subtype":"success"}\n'),
  ]));
  filter.end();
  deepEqual(writeAll(written), Buffer.from('{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n'));
});

test("log line filter preserves non-thinking lines split across chunks byte-for-byte", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  filter.push(Buffer.from('{"type":"assistant","message":{"text":"first'));
  filter.push(Buffer.from(' line"}}\n{"type":"result"'));
  filter.push(Buffer.from('}\n'));
  filter.end();
  deepEqual(writeAll(written), Buffer.from('{"type":"assistant","message":{"text":"first line"}}\n{"type":"result"}\n'));
});

test("log line filter preserves a multibyte UTF-8 character split across chunks", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  const line = Buffer.from('{"type":"assistant","text":"café"}\n');
  const at = line.indexOf(Buffer.from("é"));
  filter.push(line.subarray(0, at + 1));
  filter.push(line.subarray(at + 1));
  filter.end();
  deepEqual(writeAll(written), line);
  equal(writeAll(written).toString("utf8"), '{"type":"assistant","text":"café"}\n');
});

test("log line filter flushes a trailing partial non-thinking line on end", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  const partial = Buffer.from('{"type":"assistant","text":"unfinished café"}');
  filter.push(partial);
  filter.end();
  deepEqual(writeAll(written), partial);
});

test("log line filter drops a trailing partial thinking_tokens event on end", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  filter.push(Buffer.from(tokenLine.subarray(0, -1)));
  filter.end();
  deepEqual(writeAll(written), Buffer.alloc(0));
});
test("log line filter writes a 4 MiB line fed in 1 KiB chunks intact as one line", () => {
  const written = [];
  const filter = createLogLineFilter((chunk) => written.push(Buffer.from(chunk)));
  const line = Buffer.alloc(4 * 1024 * 1024, 0x61);
  for (let offset = 0; offset < line.length; offset += 1024) {
    filter.push(line.subarray(offset, offset + 1024));
  }
  filter.push(Buffer.from("\n"));
  filter.end();
  equal(written.length, 1);
  deepEqual(written[0], Buffer.concat([line, Buffer.from("\n")]));
});

// ── image stripping ───────────────────────────────────────────────────────────
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const imageBlock = (bytes, mediaType = "image/png") => ({
  type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
});
const lineOf = (value) => Buffer.from(JSON.stringify(value) + "\n", "utf8");
const parse = (buf) => JSON.parse(buf.toString("utf8"));

test("F1: a tool_result image block becomes a stub with its byte length and digest", () => {
  const bytes = Buffer.alloc(64 * 1024, 7);
  const event = {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "r1",
        content: [{ type: "text", text: "read the image" }, imageBlock(bytes)],
      }],
    },
  };
  const out = parse(stripImages(lineOf(event)));
  deepEqual(out, {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "r1",
        content: [{
          type: "text", text: "read the image",
        }, {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "[stripped]", bytes: 65536, sha256: sha(bytes) },
        }],
      }],
    },
  });
});

test("F2: an image block at the top of message.content is stripped, and so are two on one line", () => {
  const first = Buffer.alloc(4, 1);
  const second = Buffer.alloc(8, 2);
  const event = { type: "assistant", message: { content: [imageBlock(first, "image/jpeg"), imageBlock(second)] } };
  const out = parse(stripImages(lineOf(event)));
  deepEqual(out.message.content.map((block) => block.source), [
    { type: "base64", media_type: "image/jpeg", data: "[stripped]", bytes: 4, sha256: sha(first) },
    { type: "base64", media_type: "image/png", data: "[stripped]", bytes: 8, sha256: sha(second) },
  ]);
});

test("F3: a data:image/ base64 string is replaced by a stubbed data URL", () => {
  const bytes = Buffer.alloc(3, 5);
  const line = lineOf({ x: `data:image/jpeg;base64,${bytes.toString("base64")}` });
  equal(parse(stripImages(line)).x, `data:image/jpeg;base64,[stripped bytes=3 sha256=${sha(bytes)}]`);
});

test("F4: a gate-matching line with no image, non-JSON, torn and string-value lines pass through as the same buffer", () => {
  const untouched = [
    // Parses and matches the gate, but holds no image. Any re-serialisation would
    // rewrite the spacing and `1.0` — so this row is what proves the original wins.
    Buffer.from('{"type":"image" , "note": 1.0}\n'),
    Buffer.from("spawn error: nope\n"),
    // Matches the gate, then fails to parse: a torn write stays exactly as torn.
    Buffer.from('{"type":"image","source":{"type":"base64","data":"AAA'),
    // The gate text inside a string value, escaped exactly as JSON must write it.
    lineOf({ text: 'the word "type":"image" appears here' }),
  ];
  for (const line of untouched) {
    strictEqual(stripImages(line), line, line.toString("utf8"));
  }
});

test("F5: coverage reads the same windows before and after stripping", () => {
  const windows = [
    { file: "C:/repo/a.txt", offset: 1, limit: 100 },
    { file: "C:/repo/b.txt", offset: 21, limit: 40 },
    { file: "C:/repo/c.txt", offset: 1, limit: 2000 },
  ];
  const events = [];
  windows.forEach((w, i) => {
    events.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `r${i}`, name: "Read", input: { file_path: w.file, offset: w.offset, limit: w.limit } }] } });
    events.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `r${i}`, content: [{ type: "text", text: "page" }, imageBlock(Buffer.alloc(32, i))] }] } });
  });
  const raw = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const stripped = raw.split("\n").filter(Boolean)
    .map((l) => stripImages(Buffer.from(l + "\n", "utf8")).toString("utf8")).join("");
  deepEqual(parseReadCalls(raw, "claude"), windows);
  deepEqual(parseReadCalls(stripped, "claude"), windows);
});

test("F6: a codex command_execution keeps its aggregated_output verbatim", () => {
  const line = lineOf({
    type: "item.completed",
    item: { id: "c1", type: "command_execution", command: "cat shot.png", exit_code: 0, aggregated_output: "data:image/png;base64,AAAA" },
  });
  strictEqual(stripImages(line), line);
});

test("F7: a stub is never re-stripped, so a second pass is byte-identical", () => {
  const blockLine = lineOf(imageBlock(Buffer.alloc(64, 3)));
  const blockOnce = stripImages(blockLine);
  deepEqual(stripImages(blockOnce), blockOnce);

  const urlLine = lineOf({ x: `data:image/png;base64,${Buffer.alloc(64, 4).toString("base64")}` });
  const urlOnce = stripImages(urlLine);
  deepEqual(stripImages(urlOnce), urlOnce);
});

// ── the Read tool's own result copy (R1–R3, R6, R7) ───────────────────────────
// One real Claude Code leaf line: the Read tool returns the image TWICE on it — a
// content block under `message`, and its own `tool_use_result.file`. The 501 KB JPEG
// on the real line is re-encoded at 160x295 as the few KB below.
const JPEG_B64 = [
  "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",
].join("");
const JPEG_BYTES = Buffer.from(JPEG_B64, "base64");
const REAL_FILE = {
  type: "image/jpeg",
  originalSize: 3030922,
  dimensions: { originalWidth: 1936, originalHeight: 3570, displayWidth: 1085, displayHeight: 2000 },
};
const stubOf = (bytes) => ({ bytes: bytes.length, sha256: sha(bytes) });
const rawContentSource = () => ({ type: "base64", media_type: "image/jpeg", data: JPEG_B64 });

// One builder for the raw line, a #475-compacted line and a fully stubbed one.
const readLine = ({ contentSource, toolBase64 = JPEG_B64 } = {}) => lineOf({
  type: "user",
  message: {
    role: "user",
    content: [{
      tool_use_id: "call_nkcz589v",
      type: "tool_result",
      content: [{ type: "image", source: contentSource ?? rawContentSource() }],
    }],
  },
  parent_tool_use_id: null,
  session_id: "44145b51-73ca-43af-a979-90af7dde8a47",
  uuid: "4d9577e0-03dd-48d5-bd4a-3bdc08d5ed5a",
  timestamp: "2026-11-02T17:17:28.979Z",
  tool_use_result: { type: "image", file: { base64: toolBase64, ...REAL_FILE } },
  tool_result_meta: [{ id: "call_nkcz589v", permission_decision: { decision: "accept", source: "config", reason_type: "mode" } }],
});

test("R1: a real Read line has BOTH image copies stripped, with equal digests", () => {
  const line = readLine();
  const buf = stripImages(line);
  ok(buf.length < line.length, "the line shrinks");
  const out = parse(buf);
  const source = out.message.content[0].content[0].source;
  const file = out.tool_use_result.file;
  deepEqual(source, { type: "base64", media_type: "image/jpeg", data: "[stripped]", ...stubOf(JPEG_BYTES) });
  deepEqual(file, { base64: "[stripped]", ...REAL_FILE, ...stubOf(JPEG_BYTES) });
  equal(file.sha256, source.sha256, "both copies digest the same bytes");
  equal(file.bytes, source.bytes);
});

test("R2: a #475-compacted line gets only its second copy stripped", () => {
  const contentSource = { type: "base64", media_type: "image/jpeg", data: "[stripped]", ...stubOf(JPEG_BYTES) };
  const input = readLine({ contentSource });
  const out = parse(stripImages(input));
  deepEqual(out, {
    ...parse(input),
    tool_use_result: { type: "image", file: { base64: "[stripped]", ...REAL_FILE, ...stubOf(JPEG_BYTES) } },
  });
});

test("R3: a fully stubbed line comes back as the SAME buffer", () => {
  const once = stripImages(readLine());
  strictEqual(stripImages(once), once);
});

test("R6: only type:image matches — a pdf or text file.base64 is untouched", () => {
  for (const type of ["pdf", "text"]) {
    // Alone, nothing in the line passes the gate: same buffer, never even parsed.
    const alone = lineOf({ tool_use_result: { type, file: { base64: JPEG_B64 } } });
    strictEqual(stripImages(alone), alone, `${type} alone is never parsed`);
    // Beside a real image the line IS walked, so the type guard is what protects it.
    const out = parse(stripImages(lineOf({
      tool_use_result: { type, file: { base64: JPEG_B64 } },
      sibling: imageBlock(JPEG_BYTES, "image/jpeg"),
    })));
    equal(out.tool_use_result.file.base64, JPEG_B64, `${type} is never stripped`);
    equal(out.sibling.source.data, "[stripped]", "the image beside it is");
  }
});

test("R7: a lone tool_use_result image passes the gate and is stripped", () => {
  const out = parse(stripImages(lineOf({
    type: "user",
    tool_use_result: { type: "image", file: { base64: JPEG_B64, ...REAL_FILE } },
  })));
  deepEqual(out.tool_use_result.file, { base64: "[stripped]", ...REAL_FILE, ...stubOf(JPEG_BYTES) });
});
