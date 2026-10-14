--!strict
-- Reshapes the compiled main plugin (as a binary model) into the standalone preview_ui bundle: a Folder with
-- the preview core, its few plugin modules, the roblox-ts runtime, @rbxts/services and the story renderer.
-- No plugin bootstrap is included, so nothing runs until a host requires modules/preview/UiPreview.
-- Usage: lune run scripts/preview-bundle.luau <plugin.rbxm> <out.rbxm> <bundle-name>

local fs = require("@lune/fs")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local serde = require("@lune/serde")

local inputPath, outputPath, bundleName = process.args[1], process.args[2], process.args[3]
assert(inputPath and outputPath and bundleName, "usage: preview-bundle.luau <plugin.rbxm> <out.rbxm> <bundle-name>")

local roots = roblox.deserializeModel(fs.readFile(inputPath))
assert(#roots == 1, "expected one plugin root")
local plugin = roots[1]

local function child(parent: any, name: string): any
	local found = parent:FindFirstChild(name)
	assert(found, `plugin build is missing {parent:GetFullName()}.{name}`)
	return found
end

local bundle = roblox.Instance.new("Folder")
bundle.Name = bundleName

for _, name in { "include", "node_modules", "UIRenderer" } do
	child(plugin, name).Parent = bundle
end

-- Keep only the modules the preview core imports.
local sourceModules = child(plugin, "modules")
local modules = roblox.Instance.new("Folder")
modules.Name = "modules"
modules.Parent = bundle
for _, path in { { "Utils" }, { "RenderMonitor" }, { "handlers", "InputHandlers" }, { "preview", "UiPreview" } } do
	local source = sourceModules
	local target = modules
	for index, segment in path do
		source = child(source, segment)
		if index < #path then
			local folder = target:FindFirstChild(segment)
			if not folder then
				folder = roblox.Instance.new("Folder")
				folder.Name = segment
				folder.Parent = target
			end
			target = folder
		end
	end
	source.Parent = target
end

-- Version = hash of every module path and source, so a host re-injects exactly when the code changed.
local entries = {}
for _, descendant in bundle:GetDescendants() do
	if descendant:IsA("ModuleScript") then
		table.insert(entries, descendant:GetFullName() .. "\0" .. descendant.Source)
	end
end
table.sort(entries)
local version = string.sub(serde.hash("sha256", table.concat(entries, "\0")), 1, 16)
bundle:SetAttribute("PreviewUiVersion", version)

fs.writeFile(outputPath, roblox.serializeModel({ bundle }))
print(`{version} {#entries}`)
