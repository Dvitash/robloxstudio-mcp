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
});
