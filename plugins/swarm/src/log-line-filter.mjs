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
  let pending = Buffer.alloc(0);
  let ended = false;
  const writeLine = (line) => {
    if (!shouldDrop(line)) write(line);
  };

  return {
    push(chunk) {
      if (ended) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const input = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const newline = input.indexOf(0x0A, start);
        if (newline < 0) break;
        writeLine(input.subarray(start, newline + 1));
        start = newline + 1;
      }
      pending = input.subarray(start);
    },
    end() {
      if (ended) return;
      ended = true;
      if (pending.length) writeLine(pending);
      pending = Buffer.alloc(0);
    },
  };
}