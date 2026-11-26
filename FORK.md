# Spark fork of robloxstudio-mcp

This is Dvitash's fork of [chrrxs/robloxstudio-mcp](https://github.com/chrrxs/robloxstudio-mcp).
It runs the Studio MCP broker on Spark (ARM64 Linux, Roblox Studio under Wine/Proton).
Fixes that suit upstream go there as PRs; the rest stay here.

It exists for two reasons:

- Spark-only behavior: `preview_ui`, the primary-port claim and the idle-reaper activity stamps
  (patches below).
- The broker and the Studio plugin must come from the same build. The plugin handshake rejects any
  version difference with HTTP 426. With `npx @chrrxs/robloxstudio-mcp@latest`, an upstream release
  could change the broker while the plugin in the Wine prefixes stayed old, or the reverse. Both now
  come from this checkout (`~/Projects/robloxstudio-mcp`).

## Branches

- `spark`: upstream `main` plus the patches below. Spark runs this branch.
- `main`: a copy of upstream `main`. Fast-forward only; never commit to it.

Keep the version that upstream sets (`package.json`, 3.6.0 at the time of writing; `spark` is rebased
onto upstream `main` at `6a16374`). The broker reports it, and the plugin is built with it.

## Patches

Former patches now in upstream `main` (PRs #174 to #180): the gated Wine launch fix, the X11
window capture and contact sheets, `wait_until`, ready playtests, pending results and
`capture_video` with x11grab. Upstream #190 detaches budgeted playtest starts from the closed
request's signal, which replaced the fork's own fix. Upstream left out `capture_screenshot`'s
`save_to`, so the fork no longer has it either. omp's MCP client times out at 30 s by default, and pending results arrive
after the 25 s response budget, so the chezmoi `mcp.json` template sets `"timeout": 120000` for
this server.

1. The `preview_ui` commits (formerly the `feat/preview-ui` merge plus `ddb00f1`): `preview_ui`,
   which needs the `vendor/ui-renderer` submodule (`git submodule update --init`) and pnpm for
   `build:plugin:artifact`. It reads the viewport through `_captureViewportImageNow` inside the
   viewport queue; keep that helper when upstream reshapes `_captureViewportImage`.
2. `feat(core): ROBLOX_STUDIO_CLAIM_PRIMARY takes the port from a session that holds it`
   (`server.ts`, `http-server.ts`). Every omp session runs this server, and the first to bind
   :58741 is primary. A session's 5 s promotion check often binds the port in the gap of a unit
   restart, which left the unit a proxy and the session's old build serving Studio. A claiming
   broker sends `POST /primary/yield` (auth token) to the holder. The holder stops listening,
   drops its Studio connections and becomes a proxy, and the claimant binds the port. A claimant
   never yields. A holder without the route (a build before this patch) keeps the port; the
   claimant logs `Could not claim port` and proxies, promoting when the port frees.
   Tests: `primary-claim`.
3. `feat(core): record per-Studio MCP activity for the idle reaper`
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
   Jest setup points it at a temporary one.
   Read-only identity probes do not count, because tools send them to every connected Studio to
   find their own: an `ensure_worktree_studio` in one worktree kept resetting another worktree's
   idle Studio (dsv99 `test-like`) by reading its stamp. Exempt are `/api/place-info`
   (`get_place_info`) and any operation whose `operation_id` starts with `ensure-identity-`
   (`ensure_worktree_studio`'s per-candidate `execute_luau` stamp read in omp-workflow-tools
   `studio_workflows/ensure.ts`; keep that prefix if it changes). `get_connected_instances`,
   `manage_instance status` and `/health` are answered by the broker and never admitted. Other
   `execute_luau` calls, edits, playtests and captures still count. Tests: `studio-activity`.
4. `feat(core): capture_video records the Studio's sound on Linux`
   (`host-capture-linux.ts`, `video-recorder.ts`, `tools/index.ts`). Spark starts each Studio with
   `PULSE_SINK=spark_<display>` (and `PULSE_SERVER`), so its sound plays into that display's own
   PipeWire sink. The X11 session read from the Studio's `/proc/<pid>/environ` carries the sink's
   monitor as `pulseSource`, and the x11grab recording adds it as a `-f pulse` input, encoded as
   AAC 160k (`aresample=async=1` keeps it on the picture's clock). The result names it in
   `video.audio`. If ffmpeg fails at once with the sound input, the recording starts again
   without it and the result carries `audio_warning`; a Studio without `PULSE_SINK` records
   silently as before, and Windows/WSL sources are unchanged. Upstream candidate, but only Spark
   sets a per-Studio sink. Tests: `video-recorder`, `host-capture-linux`.

### Agent usage

- Take screenshots with `capture_screenshot`, not scrot, xwd or ffmpeg. Use `frames` with `grid: true`
  for motion. Read mouse coordinates only from single-frame captures.
- Record longer motion (cutscenes, animations) with `capture_video`. Keep other windows off the
  Studio while it records: x11grab records whatever covers the window.
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

On Spark, `screenshot-sequences.test.ts` "frames are spaced by interval_ms" fails because the
real X11 host capture runs under fake timers; it passes with `ROBLOX_STUDIO_HOST_CAPTURE=0`.

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
build older than patch 2, which cannot yield: kill that server process (the pid from `ss`); the
unit promotes within 50 ms. `spark-install` does this itself.

Never stop these processes with `pkill -f` or `pgrep -f` patterns that contain the dist path
(`packages/robloxstudio-mcp/dist/index.js`). The unit and every omp session's server match it. One
such `pkill` (2026-11-01) killed all of them at once: in-flight calls failed in every session,
omp restarted its servers, and the unit's exit took down the Studios in its cgroup (before
`KillMode=process`). Kill one exact pid, taken from `ss` or `systemctl --user show -p MainPID`.
