// Hurl contender — OPEN.
//
// Hurl was not on the operator's approved install list (plan Current Status, 2026-11-13), so
// this bake-off may not install it and cannot measure it. The adapter exists so the row is a
// real contender row with an exact probe attached, not a silent gap.

export function createHurlAdapter({ which } = {}) {
  return {
    id: "hurl",
    label: "Hurl (not installed, not approved)",
    tasks: ["http.scan-status", "http.scan-status-anon", "http.missing"],
    guard: {
      mechanism: "not applicable — Hurl's own request grammar plus `[Asserts]` would need its read-only story measured",
      describe: () => "hurl --test <file.hurl>",
      bite: async () => ({
        attempt: "hurl --test scan-status.hurl",
        blocked: false,
        message: "not attempted: Hurl is not installed and was not approved",
      }),
    },
    async probe(task) {
      const found = which ? await which("hurl") : null;
      return {
        open: {
          reason: found
            ? `Hurl is present at ${found} but was not approved for this bake-off; not run`
            : "Hurl is not installed and was not on the operator's approved install list",
          probe:
            "hurl --version && hurl --test --variable host=http://127.0.0.1:<fixture-port> " +
            `bakeoff/ui-probe/protocols/hurl/${task.id}.hurl`,
        },
      };
    },
  };
}
