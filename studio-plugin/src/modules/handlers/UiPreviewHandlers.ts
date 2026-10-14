// MCP plugin entry for preview_ui: the core lives in modules/preview/UiPreview so the same code also ships as
// a standalone bundle. This wrapper adds only the plugin-specific guards.

import State from "../State";
import PluginSession from "../PluginSession";
import UiPreview from "../preview/UiPreview";

function previewUi(data: Record<string, unknown>): unknown {
	if (data.action !== "unmount") {
		if (State.PLUGIN_VARIANT !== "main") return { error: "preview_ui requires the main MCP plugin." };
		if (PluginSession.getRole() !== "edit") return { error: "preview_ui requires the edit DataModel with no active playtest." };
	}
	return UiPreview.previewUi(data);
}

export = { init: UiPreview.init, endForPlaytest: UiPreview.endForPlaytest, previewUi };
