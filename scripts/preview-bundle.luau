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

-- Keep only the plugin modules the preview core imports, followed transitively through the compiled
-- `TS.import(script, script.Parent..., "a", "b")` calls, so a new import in any of them is bundled too.
local sourceModules = child(plugin, "modules")

-- Returns the instance a compiled import names, or nil when it does not resolve in the module's tree.
local function resolveImport(module: any, args: string): any
	local relative, rest = string.match(args, "^script([%.%w]*)(.*)$")
	if not relative then
		return nil
	end
	local node = module
	for _ in string.gmatch(relative, "%.Parent") do
		node = node and node.Parent
	end
	for segment in string.gmatch(rest, '"([^"]+)"') do
		node = node and node:FindFirstChild(segment)
	end
	return node
end

local function imports(module: any): { any }
	local found = {}
	for args in string.gmatch(module.Source, "TS%.import%(script,%s*([^)]*)%)") do
		local target = resolveImport(module, args)
		assert(target, `{module:GetFullName()} imports an instance missing from the plugin build: {args}`)
		table.insert(found, target)
	end
	return found
end

local selected: { [any]: boolean } = {}
local queue = { child(child(sourceModules, "preview"), "UiPreview") }
while #queue > 0 do
	local module = table.remove(queue) :: any
	if not selected[module] then
		selected[module] = true
		for _, target in imports(module) do
			if target:IsDescendantOf(sourceModules) and target:IsA("ModuleScript") then
				table.insert(queue, target)
			end
		end
	end
end

-- Each module's path under `modules`, read before anything moves.
local paths = {}
for module in selected do
	for _, descendant in module:GetDescendants() do
		assert(not descendant:IsA("ModuleScript"), `{module:GetFullName()} has child modules; bundle it as a folder`)
	end
	local path = {}
	local node = module
	while node ~= sourceModules do
		table.insert(path, 1, node.Name)
		node = node.Parent
	end
	table.insert(paths, { module = module, path = path })
end

local bundle = roblox.Instance.new("Folder")
bundle.Name = bundleName

for _, name in { "include", "node_modules", "UIRenderer" } do
	child(plugin, name).Parent = bundle
end

local modules = roblox.Instance.new("Folder")
modules.Name = "modules"
modules.Parent = bundle
for _, entry in paths do
	local target = modules
	for index = 1, #entry.path - 1 do
		local segment = entry.path[index]
		local folder = target:FindFirstChild(segment)
		if not folder then
			folder = roblox.Instance.new("Folder")
			folder.Name = segment
			folder.Parent = target
		end
		target = folder
	end
	entry.module.Parent = target
end

-- Every bundled plugin module's imports must resolve inside the bundle, or the host's require hangs.
for _, descendant in modules:GetDescendants() do
	if descendant:IsA("ModuleScript") then
		for _, target in imports(descendant) do
			assert(target:IsDescendantOf(bundle), `{descendant:GetFullName()} imports {target:GetFullName()}, outside the bundle`)
		end
	end
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
