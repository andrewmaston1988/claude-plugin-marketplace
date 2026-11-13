// Read-only enforcement for every protocol probe in this lane.
//
// Modelled on rts-mobile/tools/frame-witness.mjs:29 `allowed(args)`: a predicate that names
// the exact calls a tool may make, and a guard that refuses everything else BEFORE it
// reaches the wire. Each transport gets its own policy because "a write" looks different
// per layer: an HTTP method, a byte on a socket, a remote command, an sdb subcommand.
//
// A refused call throws; it is never logged-and-continued.

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/** Wrap a caller so only allowlisted calls get through. Same shape as frame-witness `guarded`. */
export function guarded(run, allowed, label) {
  return async (args) => {
    if (!allowed(args)) throw new InputError(`${label}: ${render(args)} is off the allowlist`);
    return run(args);
  };
}

function render(args) {
  return Array.isArray(args) ? args.join(" ") : JSON.stringify(args);
}

/**
 * HTTP: method, scheme, host, port and path all named. `redirect: manual` on the caller
 * stops a 30x from carrying the probe to a host this policy never approved.
 */
export function httpPolicy({ host = "127.0.0.1", ports = [], paths = ["/"], methods = ["GET"] } = {}) {
  const methodsUp = methods.map((m) => m.toUpperCase());
  return {
    label: "http",
    methods: methodsUp,
    allow({ method = "GET", url } = {}) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      const port = Number(parsed.port || 80);
      return (
        methodsUp.includes(String(method).toUpperCase()) &&
        parsed.protocol === "http:" &&
        parsed.hostname === host &&
        ports.includes(port) &&
        paths.includes(parsed.pathname)
      );
    },
    describe() {
      return `${methodsUp.join("/")} http://${host}:{${ports.join(",")}} ${paths.join(", ")}`;
    },
  };
}

/** TCP: the only bytes this tool may send. An empty list means the probe may read only. */
export function tcpPolicy({ host = "127.0.0.1", port, writes = [] } = {}) {
  return {
    label: "tcp",
    writes,
    allow({ host: to = host, port: toPort = port, write = "" } = {}) {
      return to === host && Number(toPort) === Number(port) && writes.includes(write);
    },
    describe() {
      return `connect ${host}:${port}; write ${writes.length === 0 ? "(nothing)" : writes.map((w) => JSON.stringify(w)).join(" | ")}`;
    },
  };
}

/** SSH: argv-level. BatchMode is mandatory, forwards and local commands are refused, the
 *  host is localhost only, and the remote command is an exact string on the list. */
export const SSH_FORBIDDEN = [/^-L$/, /^-R$/, /^-D$/, /^-N$/, /^-w$/, /LocalCommand=/, /ProxyCommand=/, /PermitLocalCommand=yes/];

export function sshPolicy({ hosts = ["localhost", "127.0.0.1"], commands = ["df -h"] } = {}) {
  return {
    label: "ssh",
    hosts,
    commands,
    allow(args = []) {
      if (!Array.isArray(args)) return false;
      if (args.some((arg) => SSH_FORBIDDEN.some((re) => re.test(String(arg))))) return false;
      if (!args.includes("BatchMode=yes")) return false;
      const at = args.findIndex((arg) => hosts.includes(arg));
      if (at < 0) return false;
      // Anything after the host is the remote command; anything before it is an option.
      const command = args.slice(at + 1).join(" ").trim();
      return commands.includes(command);
    },
    describe() {
      return `ssh -o BatchMode=yes {${hosts.join(",")}} ${commands.join(" | ")}`;
    },
  };
}

/** sdb: the exact RQ6 steps, nothing that installs, uninstalls, kills or forwards extra ports. */
export function sdbPolicy() {
  const allowed = [
    /^devices$/,
    /^connect \d{1,3}(?:\.\d{1,3}){3}:\d+$/,
    /^shell 0 debug [A-Za-z0-9._-]+$/,
    /^forward tcp:\d+ tcp:\d+$/,
    /^forward --remove tcp:\d+$/,
    /^version$/,
    /^kill-server$/,
  ];
  return {
    label: "sdb",
    allow(args = []) {
      const text = Array.isArray(args) ? args.join(" ") : String(args);
      return allowed.some((re) => re.test(text));
    },
    describe() {
      return "sdb devices | connect <ip>:<port> | shell 0 debug <appid> | forward tcp:N tcp:N | forward --remove tcp:N | version | kill-server";
    },
  };
}
