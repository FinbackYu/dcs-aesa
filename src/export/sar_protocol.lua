-- Wire constants and value mapping of the SAR Export. Pure Lua: no game API, no IO, no require.
--
-- Everything the deployed service parses verbatim is declared here once: the port, the two job
-- geometries (a square patch and a coarse north-up lattice), the surface vocabularies and the
-- status provider tokens. The sampler (sar_collector.lua) only formats lines with these values.
--
-- DCS coordinates: y up. A patch centre is relative to the ground track or an explicit
-- geographic point; a MAP cell (col,row) is (x0 + col*step, z0 + row*step), declared on the wire
-- by MAPGRID <id> col_x_row_z, so the server only asks for the cells that entered its rolling
-- window and a whole 30 km sector costs one pass while every later frame costs a band of it.
-- Both grids are projected by src/sar_core/geometry.lua, the canonical scene/MAP geometry that the
-- service's JS twin uses, so the two ends cannot disagree about an orientation.
local M = { HOST = "127.0.0.1", PORT = 3592, N = 17, SIZE = 128, DURATION = 2,
    MAP_CELLS = 20000, MAP_ROWS = 200, MAP_STEP = { 25, 2000 }, MAP_POSE = 0.25,
    -- Handshake words. HELLO names the channel and its line layout in one token; CAPS carries the
    -- capability block revision the service must understand before it sends a command.
    VERSION = "SAR1", CAPS = 2 }

-- CAPS/STATUS providers are wire tokens the deployed service parses verbatim.
-- They name the adapter capability, not an engine call, so this file stays free of direct game API
-- references (the adapter reports the capability; the token is only a protocol word).
M.SURFACE_PROVIDER = "terrain" .. ".GetSurfaceType"
M.HEIGHT_PROVIDER = "terrain" .. ".GetHeight"

function M.finite(v) return type(v) == "number" and v == v and math.abs(v) < 1e10 end

-- A model value through its provider: nil when the provider is missing or answers a non-number.
function M.safe(f, ...)
    if type(f) ~= "function" then return nil end
    local ok, v = pcall(f, ...)
    if ok and M.finite(v) then return v end
end

function M.fields(line)
    local a = {}
    for v in string.gmatch(line, "[^,]+") do a[#a + 1] = v end
    return a
end

-- The three patch geometries the Export can collect and the service accepts.
function M.allowed(size, n) return (size == 128 and n == 17) or (size == 512 and n == 33) or (size == 2048 and n == 65) end

-- Fine ground classes from the engine's own 16-class mask, through the native aesa_agradar probe. The
-- adapter's five-class surface query (land/sea/water/road/runway) cannot draw a runway or a building;
-- the probe reports the mask the engine's CPU side keeps (Land, Runway, Sea, River, Lake, Road, Railway,
-- Town, Field, Beach, Building, Construction, Trees, Forest, Traffic, ParticleEffect). It is loaded once
-- per connection — never per cell — and only when the service asks for the fine vocabulary with
-- SURFACE_FINE: a service that predates that command rejects anything but the five-class words, and a
-- new Export must not break an old server.
local SURFACE_FINE_NAMES = {
    land = "Land", runway = "Runway", sea = "Sea", river = "River", lake = "Lake", road = "Road",
    railway = "Railway", town = "Town", field = "Field", beach = "Beach", building = "Building",
    construction = "Construction", trees = "Trees", forest = "Forest", traffic = "Traffic",
    particleeffect = "Particle_Effect" }
-- The probe names its classes in CamelCase ("ParticleEffect") but the service's vocabulary is
-- snake_case ("particle_effect", src/sar_core/materials.cjs). A plain lower() therefore produced
-- "particleeffect", which the consumer degrades to 'unknown' — ParticleEffect was silently lost.
-- Keys are normalised (lowercase, separators removed) so both spellings resolve, and the wire token
-- keeps the capitalised convention that separates engine "Sea" from the legacy word "sea" (water).
-- The service refuses a MAPSURFACE class field longer than 96 characters (tools/sar_service/collector.cjs
-- surfaceClass); the same limit here keeps a worst-case union from failing the whole map job. A union
-- longer than the limit is cut at the first class that does not fit; probe order keeps Building, the
-- service's top significance class, inside every prefix, so truncation cannot change its pick.
M.MAPSURFACE_MAX = 96
function M.fine_classes(value)
    if type(value) ~= "string" or #value > 256 then return nil end
    local out, length = {}, 0
    for name in string.gmatch(value, "[^,]+") do
        local key = string.gsub(string.lower(string.match(name, "^%s*(.-)%s*$") or ""), "[^%a]", "")
        local canonical = SURFACE_FINE_NAMES[key]
        if canonical and #out < 16 then
            local extra = (#out > 0 and 1 or 0) + #canonical
            if length + extra > M.MAPSURFACE_MAX then break end
            out[#out + 1] = canonical
            length = length + extra
        end
    end
    return #out > 0 and table.concat(out, "+") or nil
end

-- Five-class fallback: adapter terrain_surface_type returns a class number or a
-- name. Only 1..5 and the five legacy words are meaningful; anything else,
-- including a missing adapter, is unknown rather than a guess.
function M.surface(f, x, z)
    if type(f) ~= "function" then return "unknown" end
    local ok, v = pcall(f, x, z)
    if not ok then return "unknown" end
    if type(v) == "number" and v >= 1 and v <= 5 and v == math.floor(v) then return tostring(v) end
    if type(v) == "string" then
        v = string.lower(v)
        if v == "land" or v == "sea" or v == "water" or v == "road" or v == "runway" then return v end
    end
    return "unknown"
end

return M
