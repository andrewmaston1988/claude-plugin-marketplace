# Testing

## Tiers and gates

Use Node.js 22 and Git. Run commands from the repository root.

1. Windows: `node scripts/test.mjs` gates every feature sign-off. Swarm leaves run this command.
2. WSL: the main session runs `node scripts/test.mjs --wsl` before a PR when the diff selects tests beyond the Windows-specific tests.
3. CI: the Linux workflow gates the merge.

## Test runner

For flags, output, agent mode, orphan checks, diff selection and the WSL mirror, see the [test-runner README](https://github.com/andrewmaston1988/test-runner#readme) or the [local copy](node_modules/test-runner/README.md).

`node scripts/test.mjs` is a shim that runs `npm ci` at the repository root on the first run in a tree and whenever the root lockfile changes. Changes to `test-runner.config.mjs`, the root `package-lock.json`, `.github/workflows/test.yml` or `scripts/test.mjs` select every suite. Record deliberately excluded tests and their reasons in the config's `notRun`.

## Suites and execution

[test-runner.config.mjs](test-runner.config.mjs) defines suite membership, working directories, environment, installs and timeouts.

The suites are `checkpoint`, `slack-bridge`, `claude-peers`, `swarm`, `ui-probe`, `pipeline`, `agent-investigation`, `discipline` and `repo`. Swarm has a 20-minute test-process timeout. Other runs have 10 minutes.

Pipeline has core, parity and script runs. Core and parity load `.env.test`. Pipeline runs `npm ci` in `plugins/pipeline` when its lockfile hash changes or the install record is missing. It skips installation if the lockfile is absent.

ui-probe has separate `browser` and `bakeoff` runs with separate logs at `test-results/ui-probe[browser].log` and `test-results/ui-probe[bakeoff].log`. The browser run sets `UI_PROBE_REQUIRE_BROWSER=1` and needs Chrome.

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

## Writing portable tests

Name wholly Windows-specific test files `*.win.test.mjs`. Put Windows-only cases from mixed files in a sibling with that suffix, and skip those cases on other platforms. Tests that merely mock win32 remain portable and keep their ordinary names.

For swarm tests, follow the first-import home-isolation contract in [isolate-home.mjs](plugins/swarm/tests/helpers/isolate-home.mjs).

Build absolute paths from temporary directories using platform path utilities. Make Git fixture commits differ through content or explicit metadata.

## CI

The [test workflow](.github/workflows/test.yml) runs on pull requests and pushes to `master` with `ubuntu-latest` and Node.js 22. Every job checks out the full Git history and runs `npm ci` from the repository root before invoking any repository script.

On pull requests, each suite job uses the PR base SHA with `--if-selected`. Pushes to `master` run every suite in full.

The `file-size` job enforces the 500-line bar and runs the orphan check. The workflow also plants and verifies read-only home sentinels for swarm and pipeline and checks ui-probe's plugin file types.
