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

Keep the version that upstream sets (`package.json`, 3.3.0 at the time of writing). The broker reports
it, and the plugin is built with it.

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
4. Merge of `feat/preview-ui` (and `ddb00f1`): `preview_ui`, which needs the `vendor/ui-renderer`
   submodule (`git submodule update --init`) and pnpm for `build:plugin:artifact`.
5. `feat(core): ROBLOX_STUDIO_CLAIM_PRIMARY takes the port from a session that holds it`
   (`server.ts`, `http-server.ts`). Every omp session runs this server, and the first to bind
   :58741 is primary. A session's 5 s promotion check often binds the port in the gap of a unit
   restart, which left the unit a proxy and the session's old build serving Studio. A claiming
   broker sends `POST /primary/yield` (auth token) to the holder. The holder stops listening,
   drops its Studio connections and becomes a proxy, and the claimant binds the port. A claimant
   never yields. A holder without the route (a build before this patch) keeps the port; the
   claimant logs `Could not claim port` and proxies, promoting when the port frees.
   Tests: `primary-claim`.

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

```sh
git fetch upstream
git switch spark
git rebase upstream/main           # keep the regression tests when you resolve conflicts
# build and test as above
git push --force-with-lease origin spark
git push origin upstream/main:main
```

If the rebase changes the version or anything under `studio-plugin/`, rebuild the plugin.
`spark-worktree-desktop` copies it into each prefix before Studio starts there.

## Where Spark uses it

| User | Source | What it runs |
|---|---|---|
| `spark-studio-mcp.service` (systemd user unit, the broker on :58741) | `~/Projects/tern-worktree/spark/spark-studio-mcp.service`, linked into `~/.config/systemd/user/` | `node packages/robloxstudio-mcp/dist/index.js` as the main process, stdin held open by a pipe from `sleep infinity`, with `ROBLOX_STUDIO_CLAIM_PRIMARY=1` |
| omp MCP server `robloxstudio` (one per omp session; a proxy unless it holds :58741) | `~/.omp/agent/mcp.json`, chezmoi template `dot_omp/private_agent/mcp.json.tmpl` | `node <checkout>/packages/robloxstudio-mcp/dist/index.js` |
| Plugin sync and stale-primary heal | `spark-worktree-desktop` (`MCP_PACKAGE_DIR`, default this checkout; repo `~/Projects/spark-worktree-desktop`, installed by copy to `~/.local/bin`; `spark-carbon-worktree` loads it) | copies `studio-plugin/MCPPlugin.rbxmx` into each prefix and compares the primary's `/health` version with the root `package.json` |

Running processes keep the code they loaded. After a rebuild, restart the broker unit while no
launch is in flight (`systemctl --user restart spark-studio-mcp`), then check that
`ss -ltnp 'sport = :58741'` shows the pid from `systemctl --user show -p MainPID spark-studio-mcp`.
If an omp session's server holds the port instead, the unit is a proxy and its journal
(`journalctl --user -u spark-studio-mcp`) says `Could not claim port 58741`. That session runs a
build older than patch 5, which cannot yield: kill that server process (the pid from `ss`); the
unit promotes within 50 ms.
omp sessions load the new build when they next start.
