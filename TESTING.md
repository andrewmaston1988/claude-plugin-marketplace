# Testing

## Tiers and gates

Use Node.js 22 and Git. Run commands from the repository root.

1. Windows: `node scripts/test.mjs` gates every feature sign-off. Swarm leaves run this command.
2. WSL: the main session runs `node scripts/test.mjs --wsl` before a PR for any change that is not docs-only.
3. CI: the Linux workflow gates the merge.

Docs-only means the changed files select no tests; Windows-specific tests are still added. It does not mean every changed file has a documentation extension.

## Runner flags

```powershell
node scripts/test.mjs
node scripts/test.mjs --list
node scripts/test.mjs --against master --list
node scripts/test.mjs --suite swarm
node scripts/test.mjs --all
node scripts/test.mjs --fast
node scripts/test.mjs --orphans
node scripts/test.mjs --wsl
```

- No flags: select tests from the diff, plus every registered `*.win.test.mjs` file.
- `--all`: select every registered suite.
- `--suite <name>`: select one whole suite. Also accepts `--suite=<name>`; cannot combine with `--all`.
- `--against <ref>`: override the diff base. Also accepts `--against=<ref>`.
- `--list`: print `<suite> <file> <why>` without installing or running tests. Reasons are `changed: <path>`, `fallback: <path>`, `windows`, or `suite` for whole-suite selection.
- `--reporter=agent|default`: override the output mode, which is otherwise detected; see Output.
- `--fast`: skip files this machine measured over 30 s, whose bytes are unchanged and whose measurement is under 7 days old. It names what it skipped, and with nothing recorded it runs everything and says so. A run it empties reports `skipped` (ok), not a failure. Refused with `--wsl`, which is always the full regression.
- `--if-selected`: requires `--suite`. Runs that suite whole when the diff selects any of its files for a reason other than `windows`; otherwise prints `[test] <name>: not selected by this diff` and exits 0. A selection error exits 2 rather than skipping.
- `--orphans`: print every test file no suite runs, and exit 1 when there are any. Runs no tests.
- `--wsl`: sync the mirror and run `node scripts/test.mjs --all` there. Combining it with `--list`, `--suite`, `--all`, `--against` or `--fast` exits 2 naming the conflicting flag, because that run is always the whole regression.
- `--help` or `-h`: print usage.

Exit 0 means success, including an empty diff selection or a run `--fast` emptied. Exit 1 means a test run failed or timed out, a whole-suite run matched no file, or `--orphans` found one. Exit 2 means a request or prerequisite failed, such as an unknown suite, unresolved diff base, or unavailable WSL distro. WSL returns the remote runner's exit code once it starts.

## Output

A file prints its line the moment it finishes: `✓ tests/a.test.mjs  12.3s`, or `✗` when it failed. Node relays per-test detail in file order, so only the file-level completion is live; that is what the line is built from. While nothing finishes, `… still running (65s): <files>` prints every 60 s, so a silent run always names a file that is still working.

At the end the run prints each failing test with its error and a code frame, the 10 slowest tests over 1000 ms, and the totals. The full per-test record of every run always goes to `test-results/<label>.log`, whose path the runner prints. `test-results/` is ignored by git.

A run killed at its timeout names the files it still had in flight, read from `test-results/<label>.<pid>.inflight.json` — the record of what the killed child could not report itself.

### Agent mode

Run by an agent, output follows Vitest's `agent` reporter: failures and their errors only, with no per-file lines, slowest list or totals. It switches on when an agent's variable is set — `CLAUDECODE`, `AI_AGENT`, or the variables `std-env` recognises. `--reporter=agent` or `--reporter=default` overrides the detection. Two things stay in every mode, including agent mode: the heartbeat, because a silent run is the problem this exists to solve, and the runner's one `[test] <label>: PASS|FAIL` line, which is the exit evidence. The log file holds the full tree.

## Orphan tests

A `*.test.mjs` file that no suite's globs expand to and that `notRun` does not list is never executed. Every run names such files on stderr, and `--orphans` exits 1 on them. A test deliberately left out belongs in `test-suites.mjs`'s `notRun` with the reason, so its absence is a recorded decision rather than an accident.

## Diff selection

The changed set combines the branch diff, staged and unstaged changes against HEAD, and untracked files not ignored by Git. The default base is the merge-base with the first available ref of `origin/master`, then `master`. Without either, supply `--against <ref>`.

Selection follows relative imports, re-exports, literal dynamic imports, literal `new URL(..., import.meta.url)` paths (including directory contents), and file-name string literals within the same plugin. A changed file reachable from a test selects that test.

These changes select the plugin's whole suite: `package.json`, `package-lock.json`, `.env.test`, files under `.claude-plugin` or `.codex-plugin`, `hooks/hooks.json`, and non-Markdown plugin files reached by no test. Changes under `scripts/` or `.github/` select the `repo` suite. Root metadata fallback files also select `repo`.

Unreached Markdown selects no tests. Runtime-built paths without a file-name literal can escape the graph; use `--all` when coverage is uncertain. The selector adds `*.win.test.mjs` files on every platform; those tests must skip themselves where unsupported.

## Suites and execution

The source of truth for suite membership, globs, working directories, environment, installs, and timeouts is [scripts/test-suites.mjs](scripts/test-suites.mjs).

Available suites: `checkpoint`, `slack-bridge`, `claude-peers`, `swarm`, `ui-probe`, `pipeline`, `agent-investigation`, `discipline`, and `repo`.

Pipeline has core, parity, and script runs. Core and parity load `.env.test`. Pipeline's `npm ci` is hash-gated by `package-lock.json` and `node_modules/.test-install-hash`; it runs when the record differs or is absent. A missing lockfile skips installation. ui-probe sets `UI_PROBE_REQUIRE_BROWSER=1` and needs Chrome available.

Runs execute sequentially with explicit test-file arguments and stream output. Each prints a result and duration. Swarm has a 20-minute test-process timeout; other runs have 10 minutes. Timeout handling kills the process tree on Windows or process group on Linux. Installation happens before that timer.

In diff mode, a run with nothing selected is skipped. A whole-suite run (`--suite`, `--all`) whose globs match no file fails and names the glob. Either way the runner never launches a bare `node --test`.

## The ubuntu distro

Create the dedicated Ubuntu distro from Windows PowerShell:

```powershell
wsl.exe --install -d Ubuntu-26.04 --name ubuntu --no-launch
wsl.exe -d ubuntu -u root
```

Inside that root shell:

```sh
useradd -m -s /bin/bash -G sudo ubuntu; echo ubuntu:ubuntu | chpasswd
printf '[user]\ndefault=ubuntu\n[boot]\nsystemd=true\n' > /etc/wsl.conf
apt-get update; apt-get install -y git rsync curl xz-utils ca-certificates nodejs npm
exit
```

From PowerShell, open a shell as ubuntu:

```powershell
wsl.exe -d ubuntu -u ubuntu
```

Inside that shell:

```sh
git config --global user.name plugin-dev; git config --global user.email plugin-dev@localhost; git config --global init.defaultBranch master
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; sudo apt-get install -y /tmp/chrome.deb
exit
```

The password for ubuntu and sudo is `ubuntu`. Chrome stable supplies ui-probe's browser tests. Back in PowerShell, terminate the distro so `/etc/wsl.conf` takes effect:

```powershell
wsl.exe --terminate ubuntu
node scripts/test.mjs --wsl
```

`docker-desktop` may stay the default distro. Every distro-targeted command names `-d ubuntu` (or `--name ubuntu` when creating it).

## WSL mirror

`--wsl` clones the repository's Git common directory into `~/mirror/<repo>` on the distro's own filesystem, supporting linked Windows worktrees. Each sync fetches, force-checks out Windows HEAD detached, then copies the working tree with `rsync -rlt --delete`, excluding `.git` and `node_modules`. Uncommitted and untracked files arrive too. Git file-mode checking is disabled in the clone.

Treat the mirror as disposable: sync overwrites its files, and a mirror with a different origin is replaced. Run edits in the Windows worktree. The excluded dependency directory retains the install hash between syncs.

## Writing portable tests

Name wholly Windows-specific test files `*.win.test.mjs`. Put Windows-only cases from mixed files in a sibling with that suffix, and skip those cases on other platforms. Tests that merely mock win32 remain portable and keep their ordinary names.

For swarm tests, follow the first-import home-isolation contract in [isolate-home.mjs](plugins/swarm/tests/helpers/isolate-home.mjs).

Build absolute paths from temporary directories using platform path utilities; do not hardcode Windows absolute paths. Make Git fixture commits differ through content or explicit metadata; do not rely on timestamps making two commits distinct.

## CI

[.github/workflows/test.yml](.github/workflows/test.yml) runs on pull requests and pushes to `master`, using `ubuntu-latest` and Node.js 22.

Each suite job is diff-aware and selects itself. On a pull request it runs `node scripts/test.mjs --suite <name> --if-selected --against <base sha>`: the suite runs whole when the diff selects it, and the job is green with `[test] <name>: not selected by this diff` when it does not. On a push to `master` it runs `--suite <name>`, the whole suite. Every job checks out with `fetch-depth: 0`, because a shallow clone cannot compute the diff. A change to the runner — `scripts/test.mjs`, `scripts/test-lib/**`, `scripts/test-suites.mjs`, or the workflow — selects every suite.

The always-running `file-size` job also runs `node scripts/test.mjs --orphans`, so a test file nothing runs fails the PR.

CI additionally checks the 500-line growth ratchet, configures swarm's Git identity, plants and verifies read-only home sentinels for swarm, and checks ui-probe's plugin file types. Local suite runs do not perform those extra workflow steps. Windows coverage is the local sign-off gate; a PR no longer runs the full regression.
