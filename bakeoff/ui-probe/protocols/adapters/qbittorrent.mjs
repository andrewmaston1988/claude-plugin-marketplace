// qBittorrent contender — OPEN by instruction.
//
// qBittorrent is not contacted by this bake-off at all: its API needs QB_* credentials, and no
// credential value may be printed, logged or committed. The row records the exact probe that
// would run on the operator's own machine, with the credential supplied from the environment
// and never echoed.

export function createQbittorrentAdapter() {
  return {
    id: "qbittorrent",
    label: "qBittorrent Web API (not contacted)",
    tasks: ["qbittorrent.version"],
    guard: {
      mechanism: "not exercised — the probe was never run (credentials stay out of the bake-off)",
      describe: () => "GET http://127.0.0.1:<qb-port>/api/v2/app/version with the SID cookie",
      bite: async () => ({
        attempt: "GET /api/v2/app/version",
        blocked: false,
        message: "not attempted: qBittorrent credentials are out of scope for the bake-off",
      }),
    },
    async probe() {
      return {
        open: {
          reason:
            "qBittorrent was deliberately not contacted: the probe needs QB_* credentials and no credential may enter the bake-off",
          probe:
            "QB_USER/QB_PASS from the environment → POST /api/v2/auth/login (SID cookie) → " +
            "GET http://127.0.0.1:<qb-port>/api/v2/app/version with `Cookie: SID=<redacted>`",
        },
      };
    },
  };
}
