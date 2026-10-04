--!strict

local function shell_quote(value: string): string
	local escaped = string.gsub(value, "\\", "\\\\")
	escaped = string.gsub(escaped, '"', '\\"')
	escaped = string.gsub(escaped, "%$", "\\$")
	escaped = string.gsub(escaped, "`", "\"'`'\"")
	return '"' .. escaped .. '"'
end

local function open(cx, in_block: boolean)
	local root = tern.plugin.dir
	local launch = "if test -x " .. shell_quote(root .. "/bin/terngram")
		.. "; then exec " .. shell_quote(root .. "/bin/terngram")
		.. "; else exec /bin/sh " .. shell_quote(root .. "/scripts/launch_release.sh") .. "; fi"
	local spec = {
		cwd = root,
		command = "exec /bin/sh -c " .. shell_quote(launch),
	}
	local pane
	if in_block then
		local focused = cx.session:focused()
		if focused ~= nil then
			pane = cx.layout:split(focused, "right", spec)
		end
	else
		pane = cx.layout:new_tab(spec)
	end
	if pane == nil then
		cx:toast("error", "Could not open Terngram")
	end
end

tern.command({
	id = "open",
	title = "Open Terngram",
	icon = "terminal",
	group = "Terngram",
	run = function(cx)
		open(cx, false)
	end,
})

tern.command({
	id = "open-block",
	title = "Open Terngram in Block",
	icon = "terminal",
	group = "Terngram",
	run = function(cx)
		open(cx, true)
	end,
})
