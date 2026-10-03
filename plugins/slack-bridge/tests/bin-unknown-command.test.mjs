// An unknown subcommand used to fall through to `start`: a hook naming a
// subcommand the installed bin predates (`stop-hook` against a stale plugin
// cache) launched a full bridge per hook fire — 50 never-exiting daemons, each
// clobbering the pid file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binPath = fileURLToPath(new URL("../bin/claude-slack.mjs", import.meta.url));

function runBin(args, tmp) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, [binPath, ...args], {
      env: {
        ...process.env, APPDATA: tmp, LOCALAPPDATA: tmp,
        XDG_CONFIG_HOME: tmp, XDG_DATA_HOME: tmp, XDG_STATE_HOME: tmp, HOME: tmp,
        SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", CLAUDE_CWD: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // A fallthrough to `start` never exits on a loadable config — kill it so
    // the assertion reports the defect instead of hanging the suite.
    const timer = setTimeout(() => child.kill(), 5000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

test("unknown subcommand exits 2 with a usage error instead of starting the bridge", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bin-unknown-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A loadable config, so a fallthrough to `start` would get as far as the bridge.
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    tokens: { bot: "xoxb-not-real", app: "xapp-not-real" },
    claude: { cwd: tmp },
  }));

  const { code, stderr } = await runBin(["no-such-subcommand", "--config", configPath], tmp);
  assert.equal(code, 2, `expected exit 2, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /unknown command "no-such-subcommand"/);
  const pidFiles = fs.readdirSync(tmp, { recursive: true }).filter((f) => String(f).endsWith("claude-slack.pid"));
  assert.deepEqual(pidFiles, [], "an unknown subcommand must never write the bridge pid file");
});
