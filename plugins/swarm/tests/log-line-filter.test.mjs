import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { createLogLineFilter } from "../src/log-line-filter.mjs";

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
  filter.push(Buffer.from('\n'));
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