// The CLI's argv parsing: which flags take a value, and the four questions the dispatch asks.

const VALUE_FLAGS = [
  "--config", "--url", "--viewport", "--var", "--out",
  "--device", "--attach-port", "--video", "--navigate", "--listen",
];

export function varsFrom(args) {
  const vars = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--var") continue;
    const pair = args[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) return { vars, problem: `--var needs k=value, got ${JSON.stringify(pair)}` };
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { vars, problem: null };
}

/** `--device` names where a tv-backend journey runs; the set is opt-in, the stand-in is not. */
export function deviceFlag(args) {
  const value = getFlag("--device", args);
  if (value === null) return { value: "desktop", problem: null };
  if (value !== "tv" && value !== "desktop") {
    return { value: null, problem: `--device must be tv or desktop, got ${JSON.stringify(value)}` };
  }
  return { value, problem: null };
}

export function getFlag(name, args) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return null;
  return value;
}

export function hasFlag(name, args) {
  return args.includes(name);
}

export function positionals(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.includes(arg)) i++;
      continue;
    }
    values.push(arg);
  }
  return values;
}
