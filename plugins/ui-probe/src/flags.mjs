// The CLI's argv parsing: which flags each subcommand takes, and the four questions the dispatch asks.

// Each subcommand's flags, mapped to whether the flag takes a value. Built from what each branch
// reads, so a flag nobody asks for is still seen and refused instead of silently ignored.
export const SUBCOMMAND_FLAGS = {
  capture: {
    "--config": true,
    "--url": true,
    "--viewport": true,
    "--var": true,
    "--out": true,
    "--device": true,
    "--allow-writes": false,
    "--include-background": false,
    "--attach-port": true,
    "--screenshot": false,
  },
  run: {
    "--config": true,
    "--viewport": true,
    "--var": true,
    "--out": true,
    "--device": true,
    "--allow-writes": false,
    "--attach-port": true,
  },
  validate: { "--config": true },
  screens: { "--config": true },
  doctor: { "--config": true },
  "tv probe": {
    "--config": true,
    "--out": true,
    "--video": true,
    "--navigate": true,
    "--listen": true,
    "--listen-wait": true,
    "--fetch": true,
    "--exit": false,
    "--attach-port": true,
  },
};

// The union of value-taking flags: `positionals` runs after its subcommand's check, so telling a
// flag's value from a positional never needs the subcommand here.
const VALUE_FLAGS = new Set(
  Object.values(SUBCOMMAND_FLAGS)
    .flatMap((table) => Object.entries(table))
    .filter(([, takesValue]) => takesValue)
    .map(([flag]) => flag),
);

export function wantsHelp(argv) {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

/** `{ ok: true }`, or the first flag the subcommand does not take and the ones it does. */
export function checkFlags(subcommand, args) {
  // A subcommand with no table is a wiring error: refusing everything against an empty list
  // would hide the missing key behind a plausible-looking refusal.
  if (!Object.hasOwn(SUBCOMMAND_FLAGS, subcommand)) {
    throw new Error(`no flag table for subcommand ${JSON.stringify(subcommand)}`);
  }
  const table = SUBCOMMAND_FLAGS[subcommand];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // The same rule as getFlag: a value is consumed only when it does not start with `--`, so
    // `--out --nope` still checks `--nope` as a flag.
    if (table[arg] === true && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      i++;
      continue;
    }
    if (arg.startsWith("-") && !Object.hasOwn(table, arg)) {
      // `--name=value` names a flag the table has, in a form getFlag cannot read. Say that
      // instead of calling the whole token unknown.
      const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
      if (eq > 0 && Object.hasOwn(table, arg.slice(0, eq))) {
        return { unknown: arg, known: Object.keys(table), equalsForm: true };
      }
      return { unknown: arg, known: Object.keys(table) };
    }
  }
  return { ok: true };
}

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
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    values.push(arg);
  }
  return values;
}
