-- One-file compatibility probe entry.
-- The build script wraps the modular api/profile/probe sources into this file,
-- so deployment is a single Lua file under Scripts/AESA/.
--
-- The entry is dev-only and read-only:
--   * export: wraps LuaExportAfterNextFrame, first run after ~1 s, then every 60 s;
--   * hook:   called once from onSimulationStart; native probing is symbol-level
--             only (vtable/offset sanity still needs a real DCS run).
-- Every call is pcall-protected; a missing API never breaks the hosting script.

return function(deps)
    local M = {}

    local function append(root, kind, text)
        local file = io.open(root .. "probe-" .. kind .. ".log", "a")
        if file then
            file:write(text, "\n")
            file:close()
        end
    end

    local function run(kind, api, root, facts)
        local profile = deps.profile.new(deps.profile_data, "generated")
        local ok, result = pcall(deps.probe.run, profile, api, { kind = kind, facts = facts })
        if ok then
            append(root, kind, deps.probe.format(result))
        end
    end

    function M.install_export(root)
        local api = deps.export.new()
        local next_at

        local previous = LuaExportAfterNextFrame
        LuaExportAfterNextFrame = function()
            if previous then pcall(previous) end
            local t = api:model_time() or os.clock()
            if not next_at then next_at = t + 1 end
            if t >= next_at then
                next_at = t + 60
                pcall(run, "export", api, root, {
                    export_callbacks = {
                        loaded = true,
                        after_next_frame = true,
                        activity_next_event = "passthrough",
                    },
                })
            end
        end
    end

    function M.run_hook(root)
        local api = deps.hook.new()
        local native = deps.native.new()
        local writedir = api:writedir()
        if writedir then
            api.native = native:probe(deps.profile_data.native, {
                paths = {
                    agradar = writedir .. [[Scripts\AESA-AGR\aesa_agradar.dll]],
                    fc = writedir .. [[Scripts\AESA-FC\aesa_fc_trace.dll]],
                },
            })
        end
        run("hook", api, root)
    end

    function M.schema()
        return 1
    end

    return M
end
