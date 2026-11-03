import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { StudioHttpClient } from '../tools/studio-client.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';

const EDIT_PEER = 'peer:instance:edit:edit';
const FRAME = {
  success: true, source: 'StudioCaptureService', encoding: 'rgba8', width: 2, height: 1,
  data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]).toString('base64'),
};
const SUMMARY = { kind: 'story', target: 'game.ReplicatedStorage.Shop.story', root: 'game.StarterGui.x.Content', viewport: [2, 1] };

type Handler = (data: Record<string, unknown>) => unknown;

function register(bridge: BridgeService, instanceId: string, role: string, group?: string) {
  const peerId = `peer:${instanceId}:${role}`;
  const result = bridge.registerPeer({
    peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId: group,
    placeId: 123, placeName: 'Place', dataModelName: 'Place', isRunning: role !== 'edit',
  });
  if (!result.ok) throw new Error(result.error.message);
  return peerId;
}

function metadata(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const entry = result.content[0];
  if (entry.type !== 'text' || typeof entry.text !== 'string') throw new Error('Expected text metadata first');
  return JSON.parse(entry.text);
}

describe('preview_ui', () => {
  let lastTools: RobloxStudioTools | undefined;
  beforeEach(() => {
    // Synthetic topology only; never inspect the user's managed Studio state.
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
  });
  afterEach(async () => {
    await lastTools?.dispose();
    lastTools = undefined;
    jest.restoreAllMocks();
  });

  function setup(handlers: { preview?: Handler; capture?: Handler } = {}) {
    const bridge = new BridgeService();
    register(bridge, 'instance:edit', 'edit');
    const calls: Array<{ endpoint: string; body: Record<string, unknown>; peer: string }> = [];
    jest.spyOn(StudioHttpClient.prototype, 'request').mockImplementation(async (endpoint, data, peer) => {
      const body: Record<string, unknown> = data && typeof data === 'object' ? { ...data } : {};
      calls.push({ endpoint, body, peer });
      if (endpoint === '/api/capture-studio') return handlers.capture ? handlers.capture(body) : FRAME;
      if (endpoint === '/api/preview-ui') return handlers.preview ? handlers.preview(body) : { success: true, ...SUMMARY };
      throw new Error(`unexpected endpoint ${endpoint}`);
    });
    lastTools = new RobloxStudioTools(bridge);
    return { bridge, calls, tools: lastTools };
  }

  const steps = (calls: Array<{ endpoint: string; body: Record<string, unknown> }>) =>
    calls.map((call) => (call.endpoint === '/api/preview-ui' ? call.body.action : call.endpoint));

  test('mounts on the resolved edit peer and returns the summary with a screenshot', async () => {
    const { tools, calls } = setup({
      preview: () => ({ success: true, ...SUMMARY, controls: [{ name: 'Title', type: 'String', value: 'Shop' }] }),
    });
    const result = await tools.previewUi({
      action: 'mount', target: SUMMARY.target, controls: { Title: 'Sale' }, backdrop: false, settle_seconds: 0, format: 'png',
    }, 'instance:edit');
    expect(calls.map(({ endpoint, peer }) => [endpoint, peer])).toEqual([
      ['/api/preview-ui', EDIT_PEER],
      ['/api/capture-studio', EDIT_PEER],
    ]);
    expect(calls[0].body).toEqual({ action: 'mount', target: SUMMARY.target, controls: { Title: 'Sale' }, backdrop: false });
    const meta = metadata(result);
    expect(meta).toMatchObject({ ...SUMMARY, controls: [{ name: 'Title', type: 'String', value: 'Shop' }] });
    expect(meta).not.toHaveProperty('success');
    expect(meta.screenshot).toMatchObject({ width: 2, height: 1, format: 'png' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  test('passes hot-reload reports through and surfaces a failed reload as a tool error', async () => {
    const reload = { status: 'ready', generation: 3, reloads: 2, controlsReapplied: ['Title'] };
    const { tools } = setup({
      preview: (body) => (body.action === 'click'
        ? { error: 'The story failed to hot-reload, so there is nothing to click: syntax error' }
        : { success: true, ...SUMMARY, reload }),
    });
    const shot = await tools.previewUi({ action: 'screenshot', settle_seconds: 0 }, 'instance:edit');
    expect(metadata(shot).reload).toEqual(reload);
    expect(shot.content[1]).toMatchObject({ type: 'image' });
    await expect(tools.previewUi({ action: 'click', element: 'Buy', settle_seconds: 0 }, 'instance:edit'))
      .rejects.toThrow('preview_ui click failed: The story failed to hot-reload');
  });

  test('inspect and unmount return text without capturing', async () => {
    const { tools, calls } = setup({
      preview: (body) => (body.action === 'inspect' ? { success: true, ...SUMMARY, nodes: [], nodeCount: 0 } : { success: true, unmounted: SUMMARY.target }),
    });
    const inspected = await tools.previewUi({ action: 'inspect' }, 'instance:edit');
    expect(metadata(inspected)).toMatchObject({ nodes: [], nodeCount: 0 });
    expect(inspected.content).toHaveLength(1);
    const unmounted = await tools.previewUi({ action: 'unmount' }, 'instance:edit');
    expect(metadata(unmounted)).toEqual({ unmounted: SUMMARY.target });
    expect(steps(calls)).toEqual(['inspect', 'unmount']);
  });

  test('maps click x/y from a downscaled preview screenshot to viewport pixels', async () => {
    const { tools, calls } = setup({ capture: () => ({ ...FRAME, nativeWidth: 4, nativeHeight: 3 }) });
    await tools.previewUi({ action: 'screenshot', settle_seconds: 0 }, 'instance:edit');
    const clicked = await tools.previewUi({ action: 'click', x: 1, y: 1, settle_seconds: 0 }, 'instance:edit');
    expect(calls[2].body).toEqual({ action: 'click', x: 2, y: 3 });
    expect((metadata(clicked).screenshot as Record<string, unknown>).coordinates).toMatch(/Downscaled from the 4x3 viewport/);
  });

  test('sends element clicks and typing unchanged', async () => {
    const { tools, calls } = setup();
    await tools.previewUi({ action: 'click', element: 'Shop/Buy', settle_seconds: 0 }, 'instance:edit');
    await tools.previewUi({ action: 'type', element: 'Search', text: 'sword', submit: true, settle_seconds: 0 }, 'instance:edit');
    expect(calls.filter((call) => call.endpoint === '/api/preview-ui').map((call) => call.body)).toEqual([
      { action: 'click', element: 'Shop/Buy' },
      { action: 'type', element: 'Search', text: 'sword', submit: true },
    ]);
  });

  test('reports plugin errors and an outdated plugin', async () => {
    const failing = setup({ preview: () => ({ error: 'Unknown control "Colour". Controls: Color, Title.' }) });
    await expect(failing.tools.previewUi({ action: 'set_controls', controls: { Colour: '#fff' } }, 'instance:edit'))
      .rejects.toThrow('preview_ui set_controls failed: Unknown control "Colour"');
    expect(steps(failing.calls)).toEqual(['set_controls']);
    await lastTools?.dispose();
    jest.restoreAllMocks();
    jest.spyOn(StudioInstanceManager.prototype, 'pendingLaunches').mockResolvedValue([]);
    const outdated = setup({ preview: () => ({ error: 'Unknown endpoint: /api/preview-ui' }) });
    await expect(outdated.tools.previewUi({ action: 'mount', target: 'game.StarterGui.Hud' }, 'instance:edit'))
      .rejects.toThrow(/rebuilt main Studio plugin/);
  });

  test('keeps the preview and reports a failed capture after an action', async () => {
    const { tools, calls } = setup({ capture: () => { throw new Error('capture boom'); } });
    const result = await tools.previewUi({ action: 'mount', target: 'game.StarterGui.Hud', settle_seconds: 0 }, 'instance:edit');
    expect(metadata(result)).toMatchObject({ ...SUMMARY, screenshotError: 'capture boom' });
    expect(result.content).toHaveLength(1);
    await expect(tools.previewUi({ action: 'screenshot', settle_seconds: 0 }, 'instance:edit'))
      .rejects.toThrow(/preview_ui screenshot failed: capture boom/);
    expect(steps(calls)).toEqual(['mount', '/api/capture-studio', 'screenshot', '/api/capture-studio']);
  });

  test.each([
    [{ action: 'render' }, /action must be one of/],
    [{ action: 'mount' }, /mount requires target/],
    [{ action: 'mount', target: 'game.X', controls: [1] }, /controls must be an object/],
    [{ action: 'set_controls', controls: {} }, /non-empty controls object/],
    [{ action: 'click' }, /requires element .* or x and y/],
    [{ action: 'click', element: 'A', x: 1, y: 1 }, /element or x\/y, not both/],
    [{ action: 'click', x: 1 }, /x and y must both be/],
    [{ action: 'type', element: 'Search' }, /type requires text/],
    [{ action: 'screenshot', settle_seconds: 6 }, /settle_seconds must be a number from 0 to 5/],
  ])('rejects invalid arguments %j without sending requests', async (args, message) => {
    const { tools, calls } = setup();
    await expect(tools.previewUi(args as Record<string, unknown>, 'instance:edit')).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  test('rejects an active playtest without sending requests', async () => {
    const { tools, bridge, calls } = setup();
    register(bridge, 'instance:edit', 'server');
    register(bridge, 'instance:edit', 'client-1');
    await expect(tools.previewUi({ action: 'screenshot' }, 'instance:edit')).rejects.toThrow(/idle edit DataModel/);
    expect(calls).toEqual([]);
  });

  test('rejects an omitted instance when several Studio processes are connected', async () => {
    const { tools, bridge, calls } = setup();
    register(bridge, 'instance:other', 'edit');
    const failure = await tools.previewUi({ action: 'inspect' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RoutingFailure);
    expect(failure).toMatchObject({ routingError: { code: 'ambiguous_target' } });
    expect(calls).toEqual([]);
  });

  test('does not capture when a playtest starts while the preview settles', async () => {
    const started: { bridge?: BridgeService } = {};
    const { tools, bridge, calls } = setup({
      preview: () => {
        if (started.bridge) register(started.bridge, 'instance:edit', 'server');
        return { success: true, ...SUMMARY };
      },
    });
    started.bridge = bridge;
    const result = await tools.previewUi({ action: 'mount', target: 'game.StarterGui.Hud', settle_seconds: 0 }, 'instance:edit');
    expect(metadata(result).screenshotError).toMatch(/idle edit DataModel/);
    expect(steps(calls)).toEqual(['mount']);
  });

  test('ordinary screenshots wait for an in-flight preview action', async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<unknown>();
    const { tools, calls } = setup({ preview: () => { reached.resolve(); return release.promise; } });
    const preview = tools.previewUi({ action: 'mount', target: 'game.StarterGui.Hud', settle_seconds: 0 }, 'instance:edit');
    await reached.promise;
    const screenshot = tools.captureScreenshot('instance:edit', 'png');
    release.resolve({ success: true, ...SUMMARY });
    await Promise.all([preview, screenshot]);
    expect(steps(calls)).toEqual(['mount', '/api/capture-studio', '/api/capture-studio']);
  });
});

// Execute the plugin's TypeScript with only the Roblox primitives used by these helpers.
// The production build separately checks roblox-ts/Luau compatibility.
function pluginFixture() {
  const context = createContext({ console });
  runInContext(`
    String.prototype.size = function () { return this.length; };
    String.prototype.sub = function (first, last) {
      const index = n => n < 0 ? this.length + n : n - 1;
      return this.slice(index(first), last === undefined ? undefined : index(last) + 1);
    };
    String.prototype.match = function (pattern) {
      const match = new RegExp(pattern.replaceAll("%a", "a-zA-Z").replaceAll("%w", "a-zA-Z0-9")).exec(this);
      return match ? [match[0]] : [];
    };
    String.prototype.gsub = function (pattern, replacement) { return [this.split(pattern).join(replacement)]; };
    Array.prototype.size = function () { return this.length; };
    const math = { max: Math.max, round: Math.round, floor: Math.floor };
    const error = message => { throw new Error(message); };
    const pcall = callback => { try { return [true, callback()]; } catch (err) { return [false, err]; } };
    class Vector2 {
      constructor(X, Y) { this.X = X; this.Y = Y; }
      add(other) { return new Vector2(this.X + other.X, this.Y + other.Y); }
      sub(other) { return new Vector2(this.X - other.X, this.Y - other.Y); }
    }
    Vector2.zero = new Vector2(0, 0);
    class UDim2 {
      constructor(xs, xo, ys, yo) { this.X = { Scale: xs, Offset: xo }; this.Y = { Scale: ys, Offset: yo }; }
      static fromOffset(x, y) { return new UDim2(0, x, 0, y); }
      static fromScale(x, y) { return new UDim2(x, 0, y, 0); }
    }
    let inset = 0, coreHits = [], previewHits = [];
    const services = {
      GuiService: { GetGuiInset: () => [new Vector2(0, inset)] },
      CoreGui: { GetGuiObjectsAtPosition: () => coreHits },
      StarterGui: { GetGuiObjectsAtPosition: () => previewHits },
      StudioTestService: {}, ScriptEditorService: {},
    };
    const game = {
      GetService(name) {
        const service = services[name] || this.children.find(child => child.Name === name);
        if (service) return service;
        throw new Error("Unknown service " + name);
      },
      Workspace: { CurrentCamera: { ViewportSize: new Vector2(800, 600) } },
      Name: "game", Parent: undefined, children: [],
      FindFirstChild(name) { return this.children.find(child => child.Name === name); },
      GetChildren() { return this.children; },
    };
    function node(Name, ClassName = "Folder", Parent = game) {
      const result = {
        Name, ClassName, Parent, children: [], Visible: true, Enabled: true,
        IsA(name) { return name === ClassName || (name === "GuiObject" && ["Frame", "TextButton"].includes(ClassName)); },
        FindFirstChild(name) { return this.children.find(child => child.Name === name); },
        GetChildren() { return this.children; },
      };
      Parent?.children.push(result);
      return result;
    }
    const Instance = class { constructor(ClassName) { this.ClassName = ClassName; } };
    const Color3 = { fromRGB: () => ({}) };
    const Enum = { ZIndexBehavior: { Sibling: "Sibling" } };
    const HttpService = { GenerateGUID: () => "fixture" };
    const RunService = {};
    let utils;
    const require = name => {
      if (name === "./PathAmbiguity") return { default: {} };
      if (name === "../Utils") return { default: utils };
      if (name === "@rbxts/services") return { HttpService, RunService };
      if (name === "../handlers/InputHandlers") return {};
      throw new Error("Unexpected module " + name);
    };
    let module = { exports: {} }, exports = module.exports;
  `, context);
  const compile = (file: string, extraExports?: string) => {
    let source = readFileSync(resolve(__dirname, '../../../../studio-plugin/src/modules', file), 'utf8');
    if (extraExports) source = source.replace(/export = \{[^\n]+\};/, `export = { ${extraExports} };`);
    return ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  };
  runInContext(compile('Utils.ts'), context);
  runInContext('utils = module.exports; module = { exports: {} }; exports = module.exports;', context);
  runInContext(compile('preview/UiPreview.ts', 'resolveTarget, targetSegments, coreGuiAt, createHost, clickPoints'), context);
  return {
    run: (code: string) => runInContext(code, context),
  };
}

describe('preview_ui plugin path and topbar regressions', () => {
  test.each([
    'ServerStorage/ServerModules/Stories/RoundEnd.story',
    'game/ServerStorage/ServerModules/Stories/RoundEnd.story',
    'ServerStorage.ServerModules.Stories.RoundEnd',
    'game.ServerStorage.ServerModules.Stories["RoundEnd.story"]',
    'game.ServerStorage.ServerModules.Stories["RoundEnd"]',
  ])('resolves story target %s', target => {
    const f = pluginFixture();
    f.run('const stories = node("Stories", "Folder", node("ServerModules", "Folder", node("ServerStorage"))); const story = node("RoundEnd.story", "ModuleScript", stories);');
    expect(f.run(`module.exports.resolveTarget(${JSON.stringify(target)}) === story`)).toBe(true);
  });

  test('preserves slashes, dots, and escaped quotes inside bracketed names', () => {
    const f = pluginFixture();
    f.run('const storage = node("ReplicatedStorage"); const folder = node(\'UI/"quoted".folder\', "Folder", storage); const story = node("Shop.story", "ModuleScript", folder);');
    const target = 'game/ReplicatedStorage["UI/\\"quoted\\".folder"]/Shop';
    expect(f.run(`module.exports.resolveTarget(${JSON.stringify(target)}) === story`)).toBe(true);
  });

  test('keeps an exact nested child named story and does not append a second suffix', () => {
    const f = pluginFixture();
    f.run(`
      const storage = node("ReplicatedStorage");
      const nested = node("story", "ModuleScript", node("Group", "Folder", storage));
      node("Missing.story.story", "ModuleScript", storage);
    `);
    expect(f.run('module.exports.resolveTarget("ReplicatedStorage.Group.story") === nested')).toBe(true);
    expect(() => f.run('module.exports.resolveTarget("ReplicatedStorage.Missing.story")')).toThrow(/No instance at/);
    expect(() => f.run('module.exports.resolveTarget(\'ReplicatedStorage["Missing.story"]\')')).toThrow(/No instance at/);
  });

  test('prefers an exact child and lists at most eight preview siblings on a miss', () => {
    const f = pluginFixture();
    f.run(`
      const storage = node("ReplicatedStorage");
      const exact = node("Shop", "Frame", storage);
      node("Shop.story", "ModuleScript", storage);
      node("NotPreviewable", "Folder", storage);
      for (let i = 0; i < 10; i++) node("Candidate" + i + ".story", "ModuleScript", storage);
    `);
    expect(f.run('module.exports.resolveTarget("ReplicatedStorage.Shop") === exact')).toBe(true);
    expect(() => f.run('module.exports.resolveTarget("ReplicatedStorage.Missing")'))
      .toThrow(/No instance at .*missing Missing under game.ReplicatedStorage.*Candidate0.story.*Candidate7.story/);
    try {
      f.run('module.exports.resolveTarget("ReplicatedStorage.Missing")');
    } catch (err) {
      expect(String(err)).not.toMatch(/Candidate8|Candidate9|NotPreviewable/);
    }
  });

  test.each([0, 36, 80])('reserves at least 58 viewport pixels when the reported inset is %i', inset => {
    const f = pluginFixture();
    const reserve = Math.max(58, inset);
    f.run(`inset = ${inset};`);
    expect(f.run(`module.exports.coreGuiAt(new Vector2(10, ${reserve - 1}))`)).toMatch(/CoreGui topbar reserve/);
    expect(f.run(`module.exports.coreGuiAt(new Vector2(10, ${reserve}))`)).toBeUndefined();
    f.run('coreHits = [{ Active: true, GetFullName: () => "CoreGui.Unibar" }];');
    expect(f.run('module.exports.coreGuiAt(new Vector2(300, 200))')).toBe('CoreGui.Unibar');
  });

  test('insets story/GuiObject content without resizing full-screen ScreenGui previews', () => {
    const f = pluginFixture();
    f.run('inset = 36; const hosted = module.exports.createHost(false, true); const full = module.exports.createHost(false, false);');
    expect(f.run('hosted[0].IgnoreGuiInset')).toBe(true);
    expect(f.run('hosted[1].Position.Y.Offset')).toBe(58);
    expect(f.run('hosted[1].Size.Y.Offset')).toBe(-58);
    expect(f.run('full[1].Position.Y.Offset')).toBe(0);
    expect(f.run('full[1].Size.Y.Offset === 0')).toBe(true);
  });

  test('picks a clear part of a partially shielded button and explains a fully shielded one', () => {
    const f = pluginFixture();
    f.run(`
      const screen = node("Screen", "ScreenGui");
      const button = node("Buy", "TextButton", screen);
      button.AbsolutePosition = new Vector2(0, 20);
      button.AbsoluteSize = new Vector2(100, 60);
      previewHits = [button];
      const points = module.exports.clickPoints(button, button);
    `);
    expect(f.run('points.length > 0 && points.every(point => point.Y >= 58)')).toBe(true);
    f.run('button.AbsolutePosition = new Vector2(0, 0); button.AbsoluteSize = new Vector2(100, 40);');
    expect(() => f.run('module.exports.clickPoints(button, button)')).toThrow(/CoreGui topbar reserve.*viewport y=0..57/);
  });
});
