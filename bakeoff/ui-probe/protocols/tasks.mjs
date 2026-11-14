// The tasks every contender is driven against. One definition, one reference value each —
// the harness compares every adapter's observation with the same `verify`, so a contender
// cannot pass on a weaker check than its rivals.
//
// `command` is the reproducible runner invocation; `{origin}` and `{port}` are substituted
// with the live fixture address at run time.

export const TASKS = [
  {
    id: "http.scan-status",
    title: "HTTP GET /api/scan-status (authenticated)",
    transport: "http",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only http --repeats 5  # target {origin}",
    verify: (o) =>
      o?.meta?.status === 200 &&
      o.meta.json?.any_running === false &&
      Array.isArray(o.meta.json?.recommend_queued) &&
      o.meta.json.recommend_queued.length === 0,
  },
  {
    id: "http.scan-status-anon",
    title: "HTTP GET /api/scan-status (no session cookie)",
    transport: "http",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only http --repeats 5  # target {origin}",
    verify: (o) => o?.meta?.status === 302 && String(o.meta.headers?.location ?? "").startsWith("/pin"),
  },
  {
    id: "http.missing",
    title: "HTTP GET /api/does-not-exist (404 path)",
    transport: "http",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only http --repeats 5  # target {origin}",
    verify: (o) => o?.meta?.status === 404,
  },
  {
    id: "tcp.banner",
    title: "TCP connect + banner read",
    transport: "tcp",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only tcp --repeats 5  # fixture 127.0.0.1:{port}",
    verify: (o) => o?.meta?.banner === "220 ui-probe-bakeoff fixture ready",
  },
  {
    id: "tcp.echo",
    title: "TCP allowlisted write + echo read",
    transport: "tcp",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only tcp --repeats 5  # fixture 127.0.0.1:{port}",
    verify: (o) => o?.meta?.echo === "250 HELLO ui-probe",
  },
  {
    id: "ssh.df",
    title: "SSH BatchMode `df -h` on localhost",
    transport: "ssh",
    command: "node bakeoff/ui-probe/protocols/run.mjs --only ssh --repeats 5",
    verify: (o) => o?.meta?.code === 0 && /Filesystem/i.test(o.meta.stdout ?? ""),
  },
  {
    id: "qbittorrent.version",
    title: "qBittorrent GET /api/v2/app/version",
    transport: "http",
    command: "never run — needs QB_* credentials",
    verify: (o) => o?.meta?.status === 200,
  },
];

export function withAddress(tasks, { origin, port }) {
  return tasks.map((task) => ({
    ...task,
    command: String(task.command).replaceAll("{origin}", origin ?? "").replaceAll("{port}", String(port ?? "")),
  }));
}
