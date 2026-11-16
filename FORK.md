# Spark fork of robloxstudio-mcp

This is Dvitash's fork of [chrrxs/robloxstudio-mcp](https://github.com/chrrxs/robloxstudio-mcp).
It runs the Studio MCP broker on Spark (ARM64 Linux, Roblox Studio under Wine/Proton).
Fixes stay in this fork; they are not sent upstream.

It exists for two reasons:

- Carbon's Studio launches failed on Wine. See the patch list below.
- The broker and the Studio plugin must come from the same build. The plugin handshake rejects any
  version difference with HTTP 426. With `npx @chrrxs/robloxstudio-mcp@latest`, an upstream release
  could change the broker while the plugin in the Wine prefixes stayed old, or the reverse. Both now
  come from this checkout (`~/Projects/robloxstudio-mcp`).

## Branches

- `spark`: upstream `main` plus the patches below. Spark runs this branch.
- `main`: a copy of upstream `main`. Fast-forward only; never commit to it.

Keep the version that upstream sets (`package.json`, 3.5.0 at the time of writing; `spark` is rebased
onto upstream `main` at `dd73269`). The broker reports it, and the plugin is built with it.

## Patches

1. `fix: keep gated Wine launches running until Studio execs, and record authorization as an observation`
   (`packages/core/src/studio-instance-manager.ts`).
   A Wine launch is a stopped `/bin/sh` gate until `manage_instance authorize` resumes it and Wine
   execs `RobloxStudioBeta.exe` in the same PID. Studio enumeration lists only `RobloxStudioBeta.exe`,
   so the broker's 5 s coordinator saw each gated launch as missing:
   - One refresh before authorization left the record `not_running`. Authorization verified the
     exact process but did not update the observation, so it returned `process_running: false`.
     Carbon then closed the launch and the broker SIGKILLed the Studio it had just started
     ("robloxstudio-mcp did not authorize the exact Studio process").
   - Two refreshes while Wine was still starting confirmed an exit and aborted the gate mid-start
     ("Wine Studio process ... exited (signal SIGKILL) before RobloxStudioBeta.exe started").

   Now a pending launch whose gate this broker retains is observed as running; the gate is the
   broker's own child, so its exit still closes the record. A successful authorization records a
   running observation, so a snapshot taken while the launch was gated is too old to override it.
   Regression tests: the three gated-launch tests in
   `packages/core/src/__tests__/studio-wine-host.test.ts` ("Wine host managed Studio lifecycle").
2. `feat(core): capture the Studio window on Linux and compose contact sheets`
   (`host-capture-linux.ts`, `contact-sheet.ts`). Under Wine, Studio's own capture of the play
   viewport fails or comes back black. On Linux the broker grabs the Studio X11 window with
   python3 ctypes (libX11, libXcomposite; `xprop` from x11-utils), taking DISPLAY and XAUTHORITY
   from the Studio process, and crops it to the viewport the plugin's markers outline.
   `ROBLOX_STUDIO_HOST_CAPTURE=0` turns host capture off. Captures go to the host window first when
   the broker knows the Studio's process (from its managed-instance registry). A Studio it did not
   launch (e.g. one Carbon started while another broker was primary) is grabbed when Studio's own
   fast path is unavailable, before CaptureService; the window that shows the markers then names
   the process, so later captures go host-first.
   This coexists with upstream's WSL host capture: `isHostCaptureSupported` is true on Linux, but
   `isHostCapturePreferred` and the X11 grab apply only to native Linux, so WSL still routes to the
   Windows PowerShell capture. Upstream's `capture_video` is unsupported on native Linux for now: it
   reports that video recording needs Windows or WSL before any window grab or ffmpeg probe
   (`action=storyboard` of an existing video still works with the Linux `ffmpeg`).
3. `feat(core): screenshot sequences, wait_until, ready playtests and pending results`
   (`tools/index.ts`, `tools/definitions.ts`, `mcp-compat.ts`, `mcp-runtime.ts`):
   - `capture_screenshot` works in edit mode and in solo and multiplayer playtests. A multiplayer
     `<id>-server` captures the server window. New arguments: `frames` (up to 16),
     `interval_ms`, `grid` (one numbered contact sheet) and `save_to`.
   - `eval_server_runtime` and `eval_client_runtime` take `wait_until` (plus `code`, `timeout_s`
     and `poll_ms`). They poll the condition in the runtime VM and return `satisfied`.
   - `solo_playtest start` defaults to play mode. Playtest starts return once every runtime peer
     answers an eval (`ready_timeout_s`, default 90 s) and list `targets[].instance_id`.
   - Calls longer than `ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS` (default 25000) return
     `state: "pending"` with a `requestId`. A repeated call joins the running one, and
     `get_request_status` collects the result. omp's MCP client times out at 30 s by default, so
     the chezmoi `mcp.json` template sets `"timeout": 120000` for this server.
   Tests: `host-capture-linux`, `contact-sheet`, `runtime-wait` and the playtest cases in `smoke`.
4. The `preview_ui` commits (formerly the `feat/preview-ui` merge plus `ddb00f1`): `preview_ui`,
   which needs the `vendor/ui-renderer` submodule (`git submodule update --init`) and pnpm for
   `build:plugin:artifact`.
5. `feat(core): ROBLOX_STUDIO_CLAIM_PRIMARY takes the port from a session that holds it`
   (`server.ts`, `http-server.ts`). Every omp session runs this server, and the first to bind
   :58741 is primary. A session's 5 s promotion check often binds the port in the gap of a unit
   restart, which left the unit a proxy and the session's old build serving Studio. A claiming
   broker sends `POST /primary/yield` (auth token) to the holder. The holder stops listening,
   drops its Studio connections and becomes a proxy, and the claimant binds the port. A claimant
   never yields. A holder without the route (a build before this patch) keeps the port; the
   claimant logs `Could not claim port` and proxies, promoting when the port frees.
   Tests: `primary-claim`.
6. `feat(core): record per-Studio MCP activity for the idle reaper`
   (`bridge-service.ts`, `managed-instance-registry.ts`). When the primary admits a new operation
   for a peer (not a rejection or a replay of a retained or pending one), it touches
   `~/.local/state/robloxstudio-mcp/activity/<instanceId>` (the peer's `instanceId`, so a
   multiplayer runtime writes its role-suffixed id, e.g. `instance:abc-server`). The file is
   empty; its mtime is the activity time. Writes are throttled to one per 30 s per id, and a
   failed write never fails the request. Session servers in proxy mode forward every Studio
   request to the primary's `/proxy`, which admits it there, so all callers count.
   `spark-worktree-desktop` maps a Studio pid to its `managed-instances/v1` record's
   `instanceId` and closes the Studio when the newest matching file (`<instanceId>` or
   `<instanceId>-*`) goes stale. `ROBLOXSTUDIO_MCP_ACTIVITY_DIR` overrides the directory; the
   Jest setup points it at a temporary one. Tests: `studio-activity`.

### Agent usage

- Take screenshots with `capture_screenshot`, not scrot, xwd or ffmpeg. Use `frames` with `grid: true`
  for motion, and `save_to` for files. Read mouse coordinates only from single-frame captures.
- Wait for game state with `wait_until`, not sleeps.
- Pass a `targets[].instance_id` from a playtest start as `instance_id`.
- A `state: "pending"` result means "call `get_request_status`"; never repeat the call.

## Build

```sh
npm ci
npm run build                      # broker: packages/robloxstudio-mcp/dist/index.js
npm --prefix studio-plugin ci
npm run build:plugin:artifact      # plugin: studio-plugin/MCPPlugin.rbxmx (gitignored)
npm test -w packages/core          # the Wine host tests need Linux /proc and bash
```

## Rebase onto upstream

Follow "Nightly upstream sync" below by hand. Rebase and test in the sync worktree, never in the
live checkout, then run `scripts/spark-install`.

## Install

`scripts/spark-install` puts the checkout into service. If a nightly sync left a `spark-next`
branch, it first moves `spark` to it with `git reset --hard`. Then it builds the broker and
plugin and restarts `spark-studio-mcp`. It checks that the unit holds :58741 and that `/health`
reports the `package.json` version, then kills every omp session's server that started before
the build. omp starts each one again from the new dist. It records the installed commit in
`~/.local/state/robloxstudio-mcp/installed-head`.

It refuses (exit 3) while a Studio is open or a `carbon serve` is running, because a running
Studio keeps the plugin it loaded at startup. After a version change the new broker would
reject that plugin with HTTP 426. `--force` installs anyway and copies the new plugin into each
running Studio's prefix. Studio watches its Plugins folder and usually reloads it within
seconds, but on 2026-11-15 one of two Studios didn't and needed a restart. `--check-idle` only
runs the check.

## Nightly upstream sync

Herb runs the schedule "robloxstudio-mcp upstream sync" at 04:00, gated by
`scripts/spark-sync-gate`. The gate exits 1, so Herb sends nothing and starts no agent, unless:

- `upstream/main` has commits that the newest fork branch lacks (`spark-next` if one exists,
  else `spark`), or
- that branch is ahead of `installed-head` and no Studio is open.

The run follows these steps:

1. If upstream moved, work in the sync worktree `~/.cache/robloxstudio-mcp-sync`:
   1. When no `spark-next` branch exists, run
      `git worktree add -B spark-next ~/.cache/robloxstudio-mcp-sync spark` and
      `git config branch.spark-next.syncbase "$(git rev-parse spark)"` from the live checkout.
      Otherwise reuse the worktree, and run `git rebase --abort` if a failed run left a rebase
      there.
   2. Run `git rebase upstream/main` in the worktree. Resolve each conflict so upstream's change
      and the patch both survive, and keep the regression tests.
   3. Run `git submodule update --init` and the commands under Build, including
      `npm test -w packages/core`. Fix any failure the merge caused. If you can't, reset
      `spark-next` to where this run started, stop and report.
   4. Update this file's base reference and version note, and commit.
   5. Push with
      `git push --force-with-lease=spark:"$(git config branch.spark-next.syncbase)" origin spark-next:spark`
      and `git push origin upstream/main:main`. The lease fails if origin's `spark` is not the
      commit the sync started from; treat that like exit 5 below.
2. Run `scripts/spark-install` in the live checkout. It adopts `spark-next` only if `spark`
   still points at `syncbase`, then removes the worktree and the branch. Exit 5 means `spark`
   gained commits since the sync started: remove the worktree and `spark-next`, then go back to
   step 1. Exit 3 means a Studio is open: report that the install waits. The gate opens again
   on the first night no Studio is open.
3. Reply in two or three short lines: what upstream brought in, whether it is installed or
   waiting, and any conflict that took judgment or anything that failed.

The live checkout is never rebased or built until `spark-install` runs. Building it while
Studios run changes `package.json` under the running broker. `spark-worktree-desktop`'s
`heal_stale_mcp_primary` then restarts the primary at the next Studio launch, and every open
Studio's older plugin gets HTTP 426 (this happened during the 2026-11-15 rebase).

Keep `spark` pushed: the sync's push lease assumes origin's `spark` matches the local branch.

## Where Spark uses it

| User | Source | What it runs |
|---|---|---|
| `spark-studio-mcp.service` (systemd user unit, the broker on :58741) | `~/Projects/tern-worktree/spark/spark-studio-mcp.service`, linked into `~/.config/systemd/user/` | `node packages/robloxstudio-mcp/dist/index.js` as the main process, stdin held open by a pipe from a `tail --pid` that ends with it, with `ROBLOX_STUDIO_CLAIM_PRIMARY=1`. Studios it launches run in its cgroup; `KillMode=process` keeps them alive when it restarts |
| omp MCP server `robloxstudio` (one per omp session; a proxy unless it holds :58741) | `~/.omp/agent/mcp.json`, chezmoi template `dot_omp/private_agent/mcp.json.tmpl` | `node <checkout>/packages/robloxstudio-mcp/dist/index.js` |
| Plugin sync and stale-primary heal | `spark-worktree-desktop` (`MCP_PACKAGE_DIR`, default this checkout; repo `~/Projects/spark-worktree-desktop`, installed by copy to `~/.local/bin`; `spark-carbon-worktree` loads it) | copies `studio-plugin/MCPPlugin.rbxmx` into each prefix and compares the primary's `/health` version with the root `package.json` |

Running processes keep the code they loaded; `scripts/spark-install` restarts all of them. If an
omp session's server holds :58741 instead of the unit, the unit is a proxy and its journal
(`journalctl --user -u spark-studio-mcp`) says `Could not claim port 58741`. That session runs a
build older than patch 5, which cannot yield: kill that server process (the pid from `ss`); the
unit promotes within 50 ms. `spark-install` does this itself.

Never stop these processes with `pkill -f` or `pgrep -f` patterns that contain the dist path
(`packages/robloxstudio-mcp/dist/index.js`). The unit and every omp session's server match it. One
such `pkill` (2026-11-01) killed all of them at once: in-flight calls failed in every session,
omp restarted its servers, and the unit's exit took down the Studios in its cgroup (before
`KillMode=process`). Kill one exact pid, taken from `ss` or `systemctl --user show -p MainPID`.
