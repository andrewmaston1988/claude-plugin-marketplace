import "./helpers/isolate-home.mjs";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { deepEqual, equal, strictEqual } from "node:assert/strict";
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
