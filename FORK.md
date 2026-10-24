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
| `spark-studio-mcp.service` (systemd user unit, the broker on :58741) | `~/Projects/tern-worktree/spark/spark-studio-mcp.service`, linked into `~/.config/systemd/user/` | `node packages/robloxstudio-mcp/dist/index.js` as the main process, stdin held open by a pipe from `sleep infinity` |
| omp MCP server `robloxstudio` (one per omp session; a proxy unless it holds :58741) | `~/.omp/agent/mcp.json`, chezmoi template `dot_omp/private_agent/mcp.json.tmpl` | `node <checkout>/packages/robloxstudio-mcp/dist/index.js` |
| Plugin sync and stale-primary heal | `spark-worktree-desktop` (`MCP_PACKAGE_DIR`, default this checkout; repo `~/Projects/spark-worktree-desktop`, installed by copy to `~/.local/bin`; `spark-carbon-worktree` loads it) | copies `studio-plugin/MCPPlugin.rbxmx` into each prefix and compares the primary's `/health` version with the root `package.json` |

Running processes keep the code they loaded. After a rebuild, restart the broker unit while no
launch is in flight (`systemctl --user restart spark-studio-mcp`). omp sessions load the new build
when they next start.
