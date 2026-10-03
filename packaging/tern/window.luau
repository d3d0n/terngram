--!strict

local function shell_quote(value: string): string
	return "'" .. string.gsub(value, "'", "'\\''") .. "'"
end

tern.command({
	id = "open",
	title = "Open Terngram",
	icon = "terminal",
	group = "Terngram",
	run = function(cx)
		local root = tern.plugin.dir
		local pane = cx.layout:new_tab({
			cwd = root,
			command = "exec " .. shell_quote(root .. "/bin/terngram"),
		})
		if pane == nil then
			cx:toast("error", "Could not open Terngram")
		end
	end,
})
