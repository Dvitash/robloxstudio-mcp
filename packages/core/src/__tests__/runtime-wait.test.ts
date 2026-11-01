import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools, buildWaitProbe } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { decodePngToRgba } from '../image-decode.js';

type Reply = Record<string, unknown>;
type Handler = (endpoint: string, data: { code?: string; encoding?: string }) => Reply | Promise<Reply>;

const parse = (result: { content: Array<{ type: string; text?: string }> }) => JSON.parse(result.content[0].text ?? '{}');

function setup(handler: Handler) {
  const bridge = new BridgeService();
  for (const role of ['edit', 'server', 'client-1']) {
    const peerId = `peer:${role}`;
    const registered = bridge.registerPeer({
      peerId, transportPeerId: peerId, instanceId: 'instance:solo', role,
      placeId: 1, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
    });
    if (!registered.ok) throw new Error(registered.error.message);
  }
  const request = jest.spyOn(StudioHttpClient.prototype, 'request')
    .mockImplementation((async (endpoint: string, data: { code?: string }) => handler(endpoint, data)) as never);
  return { bridge, request, tools: new RobloxStudioTools(bridge) };
}

describe('buildWaitProbe', () => {
  test('returns an expression and keeps the caller text on line 1', () => {
    const probe = buildWaitProbe('workspace:GetAttribute("Ready")');
    expect(probe.split('\n')[0]).toBe('local __mcp_value = (function() return (workspace:GetAttribute("Ready")');
    expect(probe).toContain('return (if __mcp_value then "T" else "F") .. __mcp_shown');
  });

  test('runs a block with its own return unchanged', () => {
    expect(buildWaitProbe('local n = #workspace:GetChildren() return n > 3').split('\n')[0])
      .toBe('local __mcp_value = (function() local n = #workspace:GetChildren() return n > 3');
  });
});

describe('eval_*_runtime wait_until', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const probeOf = (data: { code?: string }) => data.code?.startsWith('local __mcp_value') ?? false;

  test('runs code once, then returns as soon as the server condition flips', async () => {
    let polls = 0;
    const { tools, request } = setup((_endpoint, data) => probeOf(data)
      ? { bridge: 'ok', ok: true, result: ++polls < 3 ? 'Ffalse' : 'Ttrue' }
      : { bridge: 'ok', ok: true, result: 'nil', output: ['scheduled'] });
    const pending = tools.evalServerRuntime('task.delay(1, flip)', 'instance:solo', { wait_until: 'workspace:GetAttribute("flip")', poll_ms: 100 });
    await jest.advanceTimersByTimeAsync(500);
    expect(parse(await pending)).toMatchObject({ satisfied: true, value: 'true', polls: 3, code_result: 'nil', code_output: ['scheduled'] });
    expect(request.mock.calls.map(([, , peer]) => peer)).toEqual(['peer:server', 'peer:server', 'peer:server', 'peer:server']);
  });

  test('polls a client and reports the last value on timeout', async () => {
    const { tools, request } = setup(() => ({ bridge: 'ok', ok: true, result: 'F3' }));
    const pending = tools.evalClientRuntime(undefined, undefined, 'instance:solo', { wait_until: '#game.Players:GetPlayers() > 3', timeout_s: 1, poll_ms: 250 });
    await jest.advanceTimersByTimeAsync(1500);
    expect(parse(await pending)).toMatchObject({
      satisfied: false, value: '3', error: 'wait_until timed out after 1s: the condition never became truthy.',
    });
    expect(request.mock.calls.every(([, , peer]) => peer === 'peer:client-1')).toBe(true);
  });

  test.each([
    [{ bridge: 'ok', ok: false, error: '[string "probe"]:1: Expected identifier, got \')\'' }, 'wait_until does not compile'],
    [{ error: 'eval_*_runtime requires a running playtest.' }, 'The playtest stopped while waiting'],
  ])('stops early on %j', async (reply, error) => {
    const { tools, request } = setup(() => reply);
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', { wait_until: 'x ==' });
    await jest.advanceTimersByTimeAsync(0);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 1, error: expect.stringContaining(error) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('stops when the runtime peer disconnects', async () => {
    const { tools, bridge } = setup(() => {
      bridge.unregisterPeer('peer:server');
      return { bridge: 'ok', ok: true, result: 'Fnil' };
    });
    const pending = tools.evalServerRuntime(undefined, 'instance:solo', { wait_until: 'false', poll_ms: 50 });
    await jest.advanceTimersByTimeAsync(200);
    expect(parse(await pending)).toMatchObject({ satisfied: false, polls: 2, value: 'nil', error: expect.stringContaining('server peer is gone') });
  });

  test('rejects a call with neither code nor wait_until', async () => {
    const { tools } = setup(() => ({}));
    await expect(tools.evalServerRuntime(undefined, 'instance:solo')).rejects.toThrow('eval_server_runtime requires code or wait_until');
  });

  test('a wait past the response budget returns pending; repeats join it and get_request_status returns the result', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, ROBLOX_STUDIO_MCP_RESPONSE_BUDGET_MS: '1000' });
    let flipped = false;
    const { tools } = setup(() => ({ bridge: 'ok', ok: true, result: flipped ? 'Ttrue' : 'Ffalse' }));
    const wait = { wait_until: 'workspace:GetAttribute("flip")', timeout_s: 30 };

    const first = tools.evalServerRuntime(undefined, 'instance:solo', wait);
    await jest.advanceTimersByTimeAsync(1000);
    const pending = parse(await first);
    expect(pending).toMatchObject({ state: 'pending', tool: 'eval_server_runtime', action: 'wait_until', requestId: expect.stringMatching(/^eval_server_runtime-/) });

    const repeat = tools.evalServerRuntime(undefined, 'instance:solo', wait);
    await jest.advanceTimersByTimeAsync(1000);
    expect(parse(await repeat)).toMatchObject({ state: 'pending', requestId: pending.requestId, joinedRunningCall: true });

    flipped = true;
    const status = tools.getRequestStatus(pending.requestId, 5000);
    await jest.advanceTimersByTimeAsync(500);
    const result = await status;
    expect(parse(result)).toMatchObject({ requestId: pending.requestId, state: 'completed', outcome: 'result' });
    expect(JSON.parse(result.content[1].text ?? '{}')).toMatchObject({ satisfied: true, value: 'true' });
  });
});

describe('capture_screenshot sequences', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsmcp-capture-'));
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    jest.spyOn(StudioInstanceManager.prototype, 'get').mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let shade = 0;
  const frameReply = (): Reply => {
    shade += 40;
    return {
      success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: 2, height: 1,
      data: Buffer.from([shade, 0, 0, 255, 0, shade, 0, 255]).toString('base64'),
    };
  };

  test('frames return every client frame in order and save numbered files', async () => {
    const { tools, request } = setup(frameReply);
    const result = await tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 3, interval_ms: 0, save_to: path.join(dir, 'shot.png') });
    const body = parse(result);
    expect(body.frames.map((frame: { frame: number }) => frame.frame)).toEqual([1, 2, 3]);
    expect(result.content.filter((item) => item.type === 'image')).toHaveLength(3);
    expect(body.savedTo).toEqual([1, 2, 3].map((index) => path.join(dir, `shot-0${index}.png`)));
    expect(request.mock.calls.map(([endpoint, , peer]) => [endpoint, peer])).toEqual(Array(3).fill(['/api/capture-studio', 'peer:client-1']));
  });

  test('grid returns one numbered contact sheet and saves it as one file', async () => {
    const { tools } = setup(frameReply);
    const savePath = path.join(dir, 'sheet.png');
    const result = await tools.captureScreenshot('instance:solo', undefined, undefined, { frames: 4, interval_ms: 0, grid: true, save_to: savePath });
    const body = parse(result);
    expect(body).toMatchObject({ format: 'png', grid: { columns: 2, rows: 2, tileWidth: 2, tileHeight: 1 }, savedTo: [savePath] });
    expect(result.content.filter((item) => item.type === 'image')).toHaveLength(1);
    const sheet = decodePngToRgba(fs.readFileSync(savePath));
    expect([sheet.width, sheet.height]).toEqual([body.grid.width, body.grid.height]);
  });

  test('rejects a sequence longer than the capture window', async () => {
    const { tools, request } = setup(frameReply);
    await expect(tools.captureScreenshot('instance:solo', 'png', undefined, { frames: 16, interval_ms: 5000 })).rejects.toThrow(/keep \(frames - 1\) \* interval_ms within/);
    expect(request).not.toHaveBeenCalled();
  });
});
