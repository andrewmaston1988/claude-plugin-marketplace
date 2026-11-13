// SSH contender: the in-box Windows OpenSSH client, BatchMode, localhost only.
//
// Nothing here can reach the NAS: the host must be localhost, the remote command must be on
// an exact list, BatchMode is forced, and the user's ssh config is bypassed (`-F NUL`) so a
// Host alias can never redirect the probe. No key, agent or password is supplied by this
// file: if localhost has no sshd the row is OPEN, not attempted-and-failed elsewhere.
//
// `spawn` and `net` are injected at call time (offline smoke test drives both).

import { InputError, sshPolicy } from "../allow.mjs";
import { probeListening } from "../fixtures/hub.mjs";

export const SSH_ARGS = [
  "-F",
  "NUL", // never read ~/.ssh/config: no Host alias can carry this probe off localhost
  "-o",
  "BatchMode=yes", // no prompt, no password, ever
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=NUL", // do not write known_hosts from a probe
  "-o",
  "ConnectTimeout=5",
  "-o",
  "NumberOfPasswordPrompts=0",
];

export function sshArgv(host, command) {
  return [...SSH_ARGS, host, ...String(command).split(/\s+/)];
}

export function createSshAdapter({ spawn, net, host = "localhost", command = "df -h", timeoutMs = 8000, clock = () => performance.now() }) {
  const policy = sshPolicy({ hosts: ["localhost", "127.0.0.1"], commands: ["df -h"] });
  const argv = sshArgv(host, command);
  const line = `$ ssh ${argv.join(" ")}`;

  function render(result) {
    const lines = [line];
    lines.push(`exit ${result.code} (${Number(result.ms).toFixed(1)} ms)`);
    if (result.stdout) lines.push(`stdout:\n${result.stdout.trimEnd()}`);
    if (result.stderr) lines.push(`stderr:\n${result.stderr.trimEnd()}`);
    return lines.join("\n");
  }

  async function run(args) {
    if (!policy.allow(args)) {
      throw new InputError(`ssh: ${args.join(" ")} is off the allowlist (${policy.describe()})`);
    }
    const started = clock();
    const result = await spawn(args, { timeoutMs });
    const ms = clock() - started;
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms };
  }

  return {
    id: "ssh-batch",
    label: "ssh.exe -o BatchMode=yes (in-box OpenSSH)",
    tasks: ["ssh.df"],
    guard: {
      mechanism: "argv allowlist: BatchMode forced, localhost only, exact remote command, no forwards",
      describe: () => policy.describe(),
      bite: async () => {
        const attempt = ["-o", "BatchMode=yes", "localhost", "rm", "-rf", "/"];
        try {
          await run(attempt);
          return { attempt: attempt.join(" "), blocked: false, message: "the remote command reached ssh" };
        } catch (err) {
          return { attempt: attempt.join(" "), blocked: err instanceof InputError, message: err.message };
        }
      },
    },
    async probe() {
      const listening = await probeListening({ host: "127.0.0.1", port: 22, timeoutMs: 400, net });
      if (!listening) {
        // One attempt anyway, so the OPEN row carries the real refusal rather than a guess.
        const result = await run(argv);
        return {
          open: {
            reason: "no sshd listening on 127.0.0.1:22 — nothing to authenticate against",
            probe: line,
            evidence: render(result),
          },
        };
      }
      const result = await run(argv);
      return { transcript: render(result), meta: { code: result.code, stdout: result.stdout, stderr: result.stderr } };
    },
  };
}
