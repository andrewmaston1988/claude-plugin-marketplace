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

export function createLogLineFilter(write) {
  let pending = [];
  let pendingLength = 0;
  let ended = false;
  const writeLine = (line) => {
    if (!shouldDrop(line)) write(line);
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
      if (ended) return;
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
    },
    end() {
      if (ended) return;
      ended = true;
      if (pendingLength > 0) writeLine(Buffer.concat(pending, pendingLength));
      pending = [];
      pendingLength = 0;
    },
  };
}