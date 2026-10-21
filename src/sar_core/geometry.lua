-- Canonical scene/MAP geometry shared by Lua and the JS twin
-- (src/sar_core/geometry.cjs). Pure math: no game API, no IO, no require.
--
-- Scene grid (docs/conventions.md §6.3; src/export/aesa_sar_export.lua;
-- src/scene/aesa_sar_mission.lua; tools/sar_viewer.html):
--   cross  = (col/(n-1) - 0.5) * size
--   ground = (row/(n-1) - 0.5) * size
--   x = cx + cross*sin(b) + ground*cos(b)
--   z = cz - cross*cos(b) + ground*sin(b)
-- Its inverse:
--   cross = dx*sin(b) - dz*cos(b)
--   ground = dx*cos(b) + dz*sin(b)
-- The vertical axis is not part of this module: callers take y from the DEM.
-- `bearing` is the SAR scene bearing of the ground/LOS axis: 0 = +x,
-- +pi/2 = +z (atan2(dz,dx)); it is not the MAP engine heading atan2(dx,dz).
--
-- MAP grid (docs/conventions.md §6.1; src/export/aesa_sar_export.lua): col runs
-- along +x, row along +z.
--   x = x0 + col*step, z = z0 + row*step
--
-- Return convention: Lua returns multiple values, the JS twin returns arrays in
-- the same order. `center` accepts either {x=,z=} named fields or a 3-element
-- sequence {x,y,z}. texelIndex/pixelCenter require n >= 2 (scene grids are
-- 17/33/65 samples per side) and size > 0.
local M = {}

local sin, cos = math.sin, math.cos

local function center_xz(center)
    local x, z = center.x, center.z
    if type(x) ~= "number" or type(z) ~= "number" then
        x, z = center[1], center[3]
    end
    return x, z
end

-- Scene (cross, ground) -> world (x, z). y is the caller's DEM height.
function M.sceneToWorld(center, bearing, cross, ground)
    local cx, cz = center_xz(center)
    local s, c = sin(bearing), cos(bearing)
    return cx + cross * s + ground * c, cz - cross * c + ground * s
end

-- World (x, z) -> scene (cross, ground); inverse of sceneToWorld.
function M.worldToScene(center, bearing, x, z)
    local cx, cz = center_xz(center)
    local dx, dz = x - cx, z - cz
    local s, c = sin(bearing), cos(bearing)
    return dx * s - dz * c, dx * c + dz * s
end

-- Fractional texel coordinate for a scene point. No rounding and no clamping:
-- col/row are in [0, n-1] exactly at the patch edges and outside it beyond them.
function M.texelIndex(cross, ground, size, n)
    local last = n - 1
    return (cross / size + 0.5) * last, (ground / size + 0.5) * last
end

-- Clamp a fractional texel coordinate into the sampling range.
-- epsilon=0 gives [0, n-1]; PFA passes 1e-6 to keep its +1 neighbour in range
-- (src/sar_core/pfa.cjs clamps to count-1.000001).
function M.clampPixel(index, n, epsilon)
    local upper = (n - 1) - (epsilon or 0)
    if upper < 0 then upper = 0 end
    if index < 0 then return 0 end
    if index > upper then return upper end
    return index
end

-- Texel index (0..n-1) -> scene coordinate along one axis.
function M.pixelCenter(index, size, n)
    return (index / (n - 1) - 0.5) * size
end

-- Canonical MAP cell (col -> +x, row -> +z) -> world (x, z).
function M.mapCellToWorld(x0, z0, step, col, row)
    return x0 + col * step, z0 + row * step
end

-- World (x, z) -> fractional MAP cell (col, row); inverse of mapCellToWorld.
function M.worldToMapCell(x0, z0, step, x, z)
    return (x - x0) / step, (z - z0) / step
end

return M
