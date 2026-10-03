--!strict

local function shell_quote(value: string): string
	local escaped = string.gsub(value, "\\", "\\\\")
	escaped = string.gsub(escaped, '"', '\\"')
	escaped = string.gsub(escaped, "%$", "\\$")
	escaped = string.gsub(escaped, "`", "\"'`'\"")
	return '"' .. escaped .. '"'
end

tern.command({
	id = "open",
	title = "Open Terngram",
	icon = "terminal",
	group = "Terngram",
	run = function(cx)
		local root = tern.plugin.dir
		local launch = "if test -x " .. shell_quote(root .. "/bin/terngram")
			.. "; then exec " .. shell_quote(root .. "/bin/terngram")
			.. "; else exec /bin/sh " .. shell_quote(root .. "/scripts/launch_release.sh") .. "; fi"
		local pane = cx.layout:new_tab({
			cwd = root,
			command = "exec /bin/sh -c " .. shell_quote(launch),
		})
		if pane == nil then
			cx:toast("error", "Could not open Terngram")
		end
	end,
})
