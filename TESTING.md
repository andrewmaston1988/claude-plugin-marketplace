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
node scripts/test.mjs --wsl
```

- No flags: select tests from the diff, plus every registered `*.win.test.mjs` file.
- `--all`: select every registered suite.
- `--suite <name>`: select one whole suite. Also accepts `--suite=<name>`; cannot combine with `--all`.
- `--against <ref>`: override the diff base. Also accepts `--against=<ref>`.
- `--list`: print `<suite> <file> <why>` without installing or running tests. Reasons are `changed: <path>`, `fallback: <path>`, `windows`, or `suite` for whole-suite selection.
- `--wsl`: sync the mirror and run `node scripts/test.mjs --all` there. Other selection flags, including `--list`, do not narrow or preview this run.
- `--help` or `-h`: print usage.

Exit 0 means success, including an empty selection. Exit 1 means a test run failed or timed out. Exit 2 means a request or prerequisite failed, such as an unknown suite, unresolved diff base, or unavailable WSL distro. WSL returns the remote runner's exit code once it starts.

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

Empty CLI selections are skipped, including suites with no matching files. The runner never launches bare `node --test` for an empty selection.

## The plugin-dev distro

Create the dedicated Ubuntu distro from Windows PowerShell:

```powershell
wsl.exe --install -d Ubuntu-26.04 --name plugin-dev --no-launch
wsl.exe -d plugin-dev -u root
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
wsl.exe -d plugin-dev -u ubuntu
```

Inside that shell:

```sh
git config --global user.name plugin-dev; git config --global user.email plugin-dev@localhost; git config --global init.defaultBranch master
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; sudo apt-get install -y /tmp/chrome.deb
exit
```

The password for ubuntu and sudo is `ubuntu`. Chrome stable supplies ui-probe's browser tests. Back in PowerShell, terminate the distro so `/etc/wsl.conf` takes effect:

```powershell
wsl.exe --terminate plugin-dev
node scripts/test.mjs --wsl
```

`docker-desktop` may stay the default distro. Every distro-targeted command names `-d plugin-dev` (or `--name plugin-dev` when creating it).

## WSL mirror

`--wsl` clones the repository's Git common directory into `~/mirror/<repo>` on the distro's own filesystem, supporting linked Windows worktrees. Each sync fetches, force-checks out Windows HEAD detached, then copies the working tree with `rsync -rlt --delete`, excluding `.git` and `node_modules`. Uncommitted and untracked files arrive too. Git file-mode checking is disabled in the clone.

Treat the mirror as disposable: sync overwrites its files, and a mirror with a different origin is replaced. Run edits in the Windows worktree. The excluded dependency directory retains the install hash between syncs.

## Writing portable tests

Name wholly Windows-specific test files `*.win.test.mjs`. Put Windows-only cases from mixed files in a sibling with that suffix, and skip those cases on other platforms. Tests that merely mock win32 remain portable and keep their ordinary names.

For swarm tests, follow the first-import home-isolation contract in [isolate-home.mjs](plugins/swarm/tests/helpers/isolate-home.mjs).

Build absolute paths from temporary directories using platform path utilities; do not hardcode Windows absolute paths. Make Git fixture commits differ through content or explicit metadata; do not rely on timestamps making two commits distinct.

## CI

[.github/workflows/test.yml](.github/workflows/test.yml) runs on pull requests and pushes to `master`, using `ubuntu-latest` and Node.js 22. Each suite job calls this runner with `--suite <name>`.

CI additionally checks the 500-line growth ratchet, configures swarm's Git identity, plants and verifies read-only home sentinels for swarm, and checks ui-probe's plugin file types. Local suite runs do not perform those extra workflow steps. Windows coverage is the local sign-off gate.
