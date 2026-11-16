import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';

describe('Studio activity files', () => {
  const previousDir = process.env.ROBLOXSTUDIO_MCP_ACTIVITY_DIR;
  let activityDir: string;

  beforeEach(() => {
    activityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmcp-activity-'));
    process.env.ROBLOXSTUDIO_MCP_ACTIVITY_DIR = activityDir;
    jest.useFakeTimers({ now: 1_800_000_000_000 });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env.ROBLOXSTUDIO_MCP_ACTIVITY_DIR = previousDir;
    fs.rmSync(activityDir, { recursive: true, force: true });
  });

  test('an admitted request touches the target instance file at most once per 30 s', () => {
    const bridge = new BridgeService();
    bridge.registerPeer({ peerId: 'server-peer', transportPeerId: 'server-peer', instanceId: 'instance:c0h-zzf-server', role: 'server' });
    const file = path.join(activityDir, 'instance:c0h-zzf-server');
    const admit = () => bridge.sendRequest('/api/test', {}, 'server-peer').catch(() => undefined);
    const mtime = () => Math.round(fs.statSync(file).mtimeMs);

    admit();
    expect(fs.readdirSync(activityDir)).toEqual(['instance:c0h-zzf-server']);
    expect(mtime()).toBe(Date.now());

    const stale = Date.now() - 600_000;
    fs.utimesSync(file, stale / 1000, stale / 1000);
    jest.advanceTimersByTime(29_000);
    admit();
    expect(mtime()).toBe(stale);

    jest.advanceTimersByTime(1_000);
    admit();
    expect(mtime()).toBe(Date.now());

    bridge.clearAllPendingRequests();
  });

  test('identity reads across Studios record no activity; real work on the Studio does', () => {
    const bridge = new BridgeService();
    bridge.registerPeer({ peerId: 'a-edit', transportPeerId: 'a-edit', instanceId: 'instance:aaa-aaa', role: 'edit' });
    bridge.registerPeer({ peerId: 'b-edit', transportPeerId: 'b-edit', instanceId: 'instance:bbb-bbb', role: 'edit' });
    const send = (endpoint: string, peerId: string, operationId?: string) =>
      bridge.sendRequest(endpoint, { code: 'return 1' }, peerId, undefined, undefined, operationId).catch(() => undefined);

    // ensure_worktree_studio from another worktree: list, then read every candidate's stamp.
    bridge.getConnectedInstances();
    send('/api/execute-luau', 'a-edit', 'ensure-identity-1b4e28ba-2fa1-11d2-883f-0016d3cca427');
    send('/api/place-info', 'a-edit');
    expect(fs.readdirSync(activityDir)).toEqual([]);

    send('/api/execute-luau', 'b-edit', 'scene-shot-capture-1');
    send('/api/execute-luau', 'a-edit');
    expect(fs.readdirSync(activityDir).sort()).toEqual(['instance:aaa-aaa', 'instance:bbb-bbb']);

    bridge.clearAllPendingRequests();
  });
});
