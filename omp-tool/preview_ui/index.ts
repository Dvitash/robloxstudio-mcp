/**
 * preview_ui as an omp custom tool, running on a released robloxstudio-mcp server.
 *
 * Built and installed by scripts/build-preview-bundle.mjs from the feat/preview-ui branch, which is the source
 * of truth; this directory holds only build output. The tool is an MCP client of the server's local streamable
 * HTTP endpoint and uses only released tools:
 *   - import_rbxm injects preview-ui.rbxm (the preview core and story renderer) into a non-archivable
 *     ServerStorage.__OmpPreviewUi folder, once per Studio session and again when the bundle version changes;
 *   - execute_luau requires the injected core and calls it; the MCP plugin's VM keeps the module (and so the
 *     preview state, story controls and hot reloading) alive between calls;
 *   - capture_screenshot returns the image after each visible action.
 * Clicks and typing run inside the core (CreateVirtualInput), so simulate_* tools are not needed.
 *
 * Server discovery: PREVIEW_UI_MCP_URL, else http://127.0.0.1:<ROBLOX_STUDIO_PORT or 58741>. Auth: ROBLOX_STUDIO_NO_AUTH,
 * ROBLOX_STUDIO_AUTH_TOKEN, else ~/.robloxstudio-mcp/auth-token (the token the server itself uses).
 */

import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(TOOL_DIR, "preview-ui.rbxm");
const MANIFEST_PATH = join(TOOL_DIR, "preview-ui.json");
const HOLDER = "__OmpPreviewUi";
const ACTIONS = ["mount", "set_controls", "click", "type", "inspect", "screenshot", "unmount"] as const;
const CAPTURE_ACTIONS = new Set(["mount", "set_controls", "click", "type", "screenshot"]);
const DEFAULT_SETTLE_SECONDS = 0.25;
const MAX_SETTLE_SECONDS = 5;
// Above the core's 20 s story mount bound plus its 15 s hot-reload wait.
const REQUEST_TIMEOUT_MS = 90_000;

type Action = (typeof ACTIONS)[number];

interface PreviewArgs {
	action: Action;
	target?: string;
	controls?: Record<string, unknown>;
	element?: string;
	x?: number;
	y?: number;
	text?: string;
	submit?: boolean;
	backdrop?: boolean;
	settle_seconds?: number;
	format?: "jpeg" | "png";
	quality?: number;
	instance_id?: string;
}

interface McpContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

interface McpResult {
	content?: McpContent[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

interface Manifest {
	name: string;
	version: string;
}

function readManifest(): Manifest {
	if (!existsSync(MANIFEST_PATH) || !existsSync(BUNDLE_PATH)) {
		throw new Error(
			`preview_ui bundle is missing from ${TOOL_DIR}. Rebuild it with "node scripts/build-preview-bundle.mjs --install" in the robloxstudio-mcp feat/preview-ui checkout.`,
		);
	}
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function serverUrl(): string {
	const explicit = process.env.PREVIEW_UI_MCP_URL?.trim();
	if (explicit) return explicit.replace(/\/+$/, "");
	const port = process.env.ROBLOX_STUDIO_PORT?.trim() || "58741";
	return `http://127.0.0.1:${port}`;
}

function authToken(): string | undefined {
	const noAuth = (process.env.ROBLOX_STUDIO_NO_AUTH ?? "").toLowerCase();
	if (noAuth === "1" || noAuth === "true") return undefined;
	const env = process.env.ROBLOX_STUDIO_AUTH_TOKEN?.trim();
	if (env) return env;
	const file = join(homedir(), ".robloxstudio-mcp", "auth-token");
	if (!existsSync(file)) {
		throw new Error(`No robloxstudio-mcp auth token: set ROBLOX_STUDIO_AUTH_TOKEN or start the server once to create ${file}.`);
	}
	return readFileSync(file, "utf8").trim();
}

let nextRequestId = 1;

/** Calls one tool on the released server through its streamable HTTP MCP endpoint (stateless tools/call). */
async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpResult> {
	const id = nextRequestId++;
	const token = authToken();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${serverUrl()}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(token ? { "x-mcp-auth": token } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
	} catch (error) {
		throw new Error(
			`Could not reach the robloxstudio-mcp server at ${serverUrl()} (${error instanceof Error ? error.message : String(error)}). ` +
				"Start it (npx @chrrxs/robloxstudio-mcp) or set ROBLOX_STUDIO_PORT / PREVIEW_UI_MCP_URL.",
		);
	}
	const body = await response.text();
	if (!response.ok) throw new Error(`robloxstudio-mcp ${name} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
	// The endpoint answers with JSON or a short SSE stream; take the JSON-RPC message for this request.
	const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
		? body
				.split("\n")
				.filter(line => line.startsWith("data:"))
				.map(line => JSON.parse(line.slice(5)))
		: [JSON.parse(body)];
	const message = messages.find(entry => entry?.id === id);
	if (!message) throw new Error(`robloxstudio-mcp ${name} returned no response for the request.`);
	if (message.error) throw new Error(`robloxstudio-mcp ${name} failed: ${message.error.message ?? JSON.stringify(message.error)}`);
	const result = message.result as McpResult;
	if (result.isError) {
		const text = result.content?.find(entry => entry.type === "text")?.text;
		throw new Error(`robloxstudio-mcp ${name} failed: ${text ?? "unknown error"}`);
	}
	return result;
}

function resultJson(result: McpResult): Record<string, unknown> {
	if (result.structuredContent) return result.structuredContent;
	const text = result.content?.find(entry => entry.type === "text")?.text;
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Runs Luau in the edit DataModel and returns its string result. */
async function runLuau(code: string, instanceId: string | undefined, signal?: AbortSignal): Promise<string> {
	const response = resultJson(
		await callTool("execute_luau", { code, target: "edit", ...(instanceId ? { instance_id: instanceId } : {}) }, signal),
	);
	if (response.success !== true) {
		throw new Error(`execute_luau failed: ${String(response.error ?? response.message ?? JSON.stringify(response))}`);
	}
	return String(response.returnValue ?? "");
}

/** A Luau long string literal for arbitrary text. */
function luauString(text: string): string {
	let level = 0;
	while (text.includes(`]${"=".repeat(level)}]`)) level++;
	const eq = "=".repeat(level);
	return `[${eq}[${text}]${eq}]`;
}

function luauLocateCore(version: string): string {
	return `local holder = game:GetService("ServerStorage"):FindFirstChild("${HOLDER}")
local bundle = holder and holder:FindFirstChildWhichIsA("Folder")
if not bundle or bundle:GetAttribute("PreviewUiVersion") ~= "${version}" then bundle = nil end`;
}

/**
 * Makes sure this Studio has the current bundle. An outdated copy is shut down first (its preview is unmounted)
 * so two copies of the core never own the viewport at once.
 */
async function ensureBundle(manifest: Manifest, instanceId: string | undefined, signal?: AbortSignal): Promise<void> {
	const state = await runLuau(
		`${luauLocateCore(manifest.version)}
if bundle then return "ready" end
local previous = shared.__ompPreviewUi
if previous then pcall(previous.shutdown) shared.__ompPreviewUi = nil end
local ServerStorage = game:GetService("ServerStorage")
local old = ServerStorage:FindFirstChild("${HOLDER}")
if old then old:Destroy() end
local folder = Instance.new("Folder")
folder.Name = "${HOLDER}"
folder.Archivable = false
folder.Parent = ServerStorage
return "inject"`,
		instanceId,
		signal,
	);
	if (state === "ready") return;
	await callTool(
		"import_rbxm",
		{
			source: { path: BUNDLE_PATH },
			parent_path: `game.ServerStorage.${HOLDER}`,
			...(instanceId ? { instance_id: instanceId } : {}),
		},
		signal,
	);
	const check = await runLuau(`${luauLocateCore(manifest.version)}
return bundle and "ready" or "missing"`, instanceId, signal);
	if (check !== "ready") throw new Error("preview_ui could not import its bundle into Studio.");
}

/** Calls the core's previewUi(data) in the MCP plugin VM, injecting the bundle when it is missing or stale. */
async function invokeCore(
	manifest: Manifest,
	data: Record<string, unknown>,
	instanceId: string | undefined,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const code = `${luauLocateCore(manifest.version)}
local HttpService = game:GetService("HttpService")
if not bundle then return HttpService:JSONEncode({ __inject = true }) end
local core = require(bundle.modules.preview.UiPreview)
if shared.__ompPreviewUi ~= core then
	if shared.__ompPreviewUi then pcall(shared.__ompPreviewUi.shutdown) end
	shared.__ompPreviewUi = core
end
if typeof(plugin) ~= "Instance" then
	return HttpService:JSONEncode({ error = "execute_luau did not expose the MCP plugin object; preview_ui needs it." })
end
core.init(plugin)
return HttpService:JSONEncode(core.previewUi(HttpService:JSONDecode(${luauString(JSON.stringify(data))})))`;
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = JSON.parse(await runLuau(code, instanceId, signal)) as Record<string, unknown>;
		if (result.__inject !== true) return result;
		await ensureBundle(manifest, instanceId, signal);
	}
	throw new Error("preview_ui could not load its bundle in Studio.");
}

function validate(args: PreviewArgs): { request: Record<string, unknown>; point?: { x: number; y: number } } {
	const { action } = args;
	const request: Record<string, unknown> = { action };
	const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
	const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
	if (action === "mount") {
		if (!nonEmpty(args.target)) throw new Error("preview_ui mount requires target: the path of a story module, ScreenGui, or GuiObject");
		if (args.controls !== undefined && !isObject(args.controls)) throw new Error("preview_ui controls must be an object of { controlName: value }");
		Object.assign(request, { target: args.target, controls: args.controls, backdrop: args.backdrop });
	} else if (action === "set_controls") {
		if (!isObject(args.controls) || Object.keys(args.controls as object).length === 0) {
			throw new Error("preview_ui set_controls requires a non-empty controls object");
		}
		request.controls = args.controls;
	} else if (action === "click") {
		const hasPoint = args.x !== undefined || args.y !== undefined;
		if (args.element !== undefined && hasPoint) throw new Error("preview_ui click takes element or x/y, not both");
		if (hasPoint) {
			if (typeof args.x !== "number" || typeof args.y !== "number" || args.x < 0 || args.y < 0) {
				throw new Error("preview_ui click x and y must both be non-negative screenshot pixel coordinates");
			}
			return { request, point: { x: args.x, y: args.y } };
		}
		if (!nonEmpty(args.element)) throw new Error("preview_ui click requires element (a path below the preview root) or x and y");
		request.element = args.element;
	} else if (action === "type") {
		if (!nonEmpty(args.element)) throw new Error("preview_ui type requires element: the TextBox path below the preview root");
		if (typeof args.text !== "string") throw new Error("preview_ui type requires text");
		Object.assign(request, { element: args.element, text: args.text, submit: args.submit });
	}
	return { request };
}

// Per Studio process: viewport pixels per pixel of the last preview_ui screenshot, and a queue so actions on one
// Studio never interleave (a capture must not land in the middle of another action).
const scales = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(run, run);
	const settled = next.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, settled);
	void settled.then(() => {
		if (queues.get(key) === settled) queues.delete(key);
	});
	return next;
}

async function previewUi(args: PreviewArgs, signal?: AbortSignal) {
	const settleSeconds = args.settle_seconds ?? DEFAULT_SETTLE_SECONDS;
	if (!Number.isFinite(settleSeconds) || settleSeconds < 0 || settleSeconds > MAX_SETTLE_SECONDS) {
		throw new Error(`preview_ui settle_seconds must be a number from 0 to ${MAX_SETTLE_SECONDS}`);
	}
	const { request, point } = validate(args);
	const manifest = readManifest();
	const instanceId = args.instance_id;
	const key = instanceId ?? "";
	return serialize(key, async () => {
		if (point) {
			const scale = scales.get(key) ?? 1;
			request.x = Math.round(point.x * scale);
			request.y = Math.round(point.y * scale);
		}
		const response = await invokeCore(manifest, request, instanceId, signal);
		if (typeof response.error === "string") throw new Error(`preview_ui ${args.action} failed: ${response.error}`);
		const summary: Record<string, unknown> = { ...response };
		delete summary.success;
		if (args.action === "unmount") scales.delete(key);
		if (!CAPTURE_ACTIONS.has(args.action)) {
			return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: summary };
		}

		if (settleSeconds > 0) await Bun.sleep(Math.floor(settleSeconds * 1000));
		let capture: McpResult;
		try {
			capture = await callTool(
				"capture_screenshot",
				{
					...(instanceId ? { instance_id: instanceId } : {}),
					...(args.format ? { format: args.format } : {}),
					...(args.quality !== undefined ? { quality: args.quality } : {}),
				},
				signal,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (args.action === "screenshot") throw new Error(`preview_ui screenshot failed: ${message}`);
			summary.screenshotError = message;
			return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: summary };
		}
		const image = capture.content?.find(entry => entry.type === "image");
		const meta = resultJson(capture);
		if (!image?.data) {
			const message = String(meta.error ?? "capture_screenshot returned no image");
			if (args.action === "screenshot") throw new Error(`preview_ui screenshot failed: ${message}`);
			summary.screenshotError = message;
			return { content: [{ type: "text" as const, text: JSON.stringify(summary) }], details: summary };
		}
		const width = Number(meta.width);
		const height = Number(meta.height);
		const viewport = summary.viewport as number[] | undefined;
		const scale = viewport && width > 0 ? viewport[0] / width : 1;
		scales.set(key, scale);
		summary.screenshot = {
			width,
			height,
			format: meta.format,
			...(meta.quality === undefined ? {} : { quality: meta.quality }),
			source: meta.source,
			coordinates:
				Math.abs(scale - 1) > 0.001
					? `Downscaled from the ${viewport?.[0]}x${viewport?.[1]} viewport; preview_ui click x/y read off this image are scaled automatically.`
					: "Native viewport pixels; use them directly as preview_ui click x/y.",
		};
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(summary) },
				{ type: "image" as const, data: image.data, mimeType: image.mimeType ?? "image/jpeg" },
			],
			details: summary,
		};
	});
}

const DESCRIPTION =
	"Use to mount, click, type, inspect, and screenshot edit-mode UI; stories hot-reload. Prefer to playtests for UI checks.\n\n" +
	"Runs in the idle edit DataModel of a Studio connected to robloxstudio-mcp and shows the preview in the viewport.\n" +
	"- mount: target is a story module (*.story ModuleScript), a ScreenGui, or a GuiObject. Stories render through the bundled story renderer " +
	"(function, React/Roact, Vide, Fusion, Iris, generic). ScreenGuis and GuiObjects are cloned; originals never change and scripts inside them do not run in edit mode. " +
	"The result lists the story's controls (type, value, options or limits). Mounting again replaces the preview.\n" +
	'- set_controls / mount controls: values by name, validated against the story. Colors "#RRGGBB", RGBA { "color", "transparency" }, Choose/EnumList an option, Object an instance path or "", groups nest.\n' +
	"- inspect lists the GuiObject tree (paths, classes, visibility, screen rects, Text/Image, button/TextBox flags). Use paths as element for click (element centre) or type (focus a TextBox, enter text, submit=true presses Return). click also takes x/y from the last preview_ui screenshot.\n" +
	"- mount, set_controls, click, type, and screenshot return a screenshot after settle_seconds; story state and controls persist between calls.\n" +
	"- Hot reloading is on for story previews: editing the story or any module it requires reloads it in place without remounting, and controls you set are re-applied. Each action waits for an in-flight reload and reports it in reload " +
	"(reloads, status, controlsReapplied, controlsDropped, storyErrors); a failed reload is reload.error and click/type/set_controls fail until the source is fixed. Native ScreenGui/GuiObject previews are static clones and do not reload.\n" +
	"- unmount when done; the preview also unmounts after 10 idle minutes, when a playtest starts, and when the MCP plugin unloads.";

const factory: CustomToolFactory = pi => {
	const z = pi.zod;
	return {
		name: "preview_ui",
		label: "Preview UI",
		description: DESCRIPTION,
		parameters: z.object({
			action: z.enum([...ACTIONS]).describe("mount first; the preview persists until unmount and stories hot-reload on edits."),
			target: z.string().optional().describe("mount: story module, ScreenGui, or GuiObject path."),
			controls: z.record(z.unknown()).optional().describe("Story control values by name; colors as #RRGGBB."),
			element: z.string().optional().describe("click/type: path below the preview root, e.g. Shop/Buy."),
			x: z.number().optional().describe("click: pixel X in the last preview_ui screenshot."),
			y: z.number().optional().describe("click: pixel Y in the last preview_ui screenshot."),
			text: z.string().optional().describe("type: text for the element TextBox."),
			submit: z.boolean().optional().describe("type: press Return after the text; default false."),
			backdrop: z.boolean().optional().describe("mount: neutral backdrop over game UI; default true."),
			settle_seconds: z.number().min(0).max(5).optional().describe("Wait before the screenshot, 0-5; default 0.25."),
			format: z.enum(["jpeg", "png"]).optional().describe("Format; jpeg is smaller, png lossless; default jpeg."),
			quality: z.number().min(1).max(100).optional().describe("JPEG quality 1-100; defaults to 92. Ignored for png."),
			instance_id: z.string().optional().describe("Studio process ID when ambiguous."),
		}),
		async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
			return previewUi(params, signal);
		},
	};
};

export default factory;
