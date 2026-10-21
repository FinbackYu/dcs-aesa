-- Pure Lua 5.1 compatibility-profile accessor.
-- No DCS API, no io/os/require, no file reads: callers inject a profile table
-- (generated profiles live in src/adapters/dcs/compat/profiles/).
--
-- Capability states: "ok" | "degraded" | "unavailable" | "unknown".
-- Missing capability = unknown; explicit false = unavailable (never a default).
-- matrix_hash canonical form: sorted "KEY=state\n" rows, FNV-1a 32, 8 lowercase hex.

local P = {}

local SCHEMA = 1
local STATES = { ok = true, degraded = true, unavailable = true, unknown = true }
local FNV_OFFSET_HI = 0x811c
local FNV_OFFSET_LO = 0x9dc5
local FNV_PRIME = 16777619

-- Minimal fallback used when no generated dcs-generic profile was injected.
-- It deliberately knows nothing: every capability resolves to unknown, so
-- require() fails closed. Generated generic data may replace it via set_generic.
local BUILTIN_GENERIC = {
  schema = 1,
  id = "dcs-generic",
  build = "unknown",
  variant = "unknown",
  verified = "unknown",
  read_only = true,
  evidence = { "docs/dcs-compat.md#4.2" },
  required = { "BUILD", "EXP-SELF", "EXP-WORLD", "EXP-TIME" },
  capabilities = {}
}

local registered_generic = nil

local function xor8(a, b)
  local result = 0
  local bit = 1
  for _ = 1, 8 do
    local aa = a % 2
    local bb = b % 2
    if aa ~= bb then result = result + bit end
    a = math.floor(a / 2)
    b = math.floor(b / 2)
    bit = bit * 2
  end
  return result
end

local function fnv1a32(text)
  local hi = FNV_OFFSET_HI
  local lo = FNV_OFFSET_LO
  for index = 1, #text do
    local byte = string.byte(text, index)
    lo = lo - (lo % 256) + xor8(lo % 256, byte)
    local product = lo * FNV_PRIME
    local carry = math.floor(product / 65536)
    lo = product % 65536
    hi = (hi * FNV_PRIME + carry) % 65536
  end
  return string.format("%04x%04x", hi, lo)
end

local function normalize_state(value)
  if value == nil then return "unknown" end
  if value == true then return "ok" end
  if value == false then return "unavailable" end
  if type(value) == "string" then
    if STATES[value] then return value end
    return "unknown"
  end
  if type(value) == "table" and value.state ~= nil then
    return normalize_state(value.state)
  end
  return "unknown"
end

local function valid_profile(profile)
  if type(profile) ~= "table" then return false, "profile-not-table" end
  if profile.schema ~= SCHEMA then return false, "schema" end
  if type(profile.id) ~= "string" or profile.id == "" then return false, "id" end
  if not string.match(profile.id, "^dcs%-[a-z0-9][a-z0-9%.%-]*$") then return false, "id-format" end
  if type(profile.build) ~= "string" or profile.build == "" then return false, "build" end
  if profile.id == "dcs-generic" then
    if profile.build ~= "unknown" then return false, "generic-build" end
    return true
  end
  if not string.match(profile.build, "^%d+%.%d+%.%d+%.%d+$") then return false, "build-format" end
  local suffix = ""
  if type(profile.variant) == "string" and profile.variant ~= "" and profile.variant ~= "unknown" then
    suffix = "-" .. string.lower(profile.variant)
  end
  if profile.id ~= "dcs-" .. profile.build .. suffix then return false, "id-build-mismatch" end
  return true
end

local function matrix_canonical(entries)
  local rows = {}
  for index = 1, #entries do
    rows[index] = entries[index].key .. "=" .. entries[index].state .. "\n"
  end
  return table.concat(rows)
end

P.SCHEMA = SCHEMA
P.STATES = STATES
P.fnv1a32 = fnv1a32
P.matrix_canonical = matrix_canonical

-- Fixed cross-language vectors. compat_check.cjs and the Node/Python tests
-- must reproduce these exact FNV-1a 32 values.
P.HASH_VECTORS = {
  { input = "EXP-SELF=ok\n", hash = "d261c0ec" },
  { input = "EXP-SELF=ok\nEXP-VEL=degraded\n", hash = "8ebcf91c" },
  { input = "BUILD=ok\nEXP-SELF=unknown\nNAT-HASH=unavailable\n", hash = "1012a55e" }
}

function P.set_generic(profile)
  if type(profile) == "table" then registered_generic = profile end
  return P
end

function P.new(profile, source)
  local fallback = false
  local reason = nil
  if profile == nil then
    fallback = true
    reason = "missing"
  else
    local ok, why = valid_profile(profile)
    if not ok then
      fallback = true
      reason = why
      profile = nil
    end
  end
  if fallback then
    profile = registered_generic
    if profile == nil or not valid_profile(profile) then
      profile = BUILTIN_GENERIC
    end
  end
  local instance = {
    profile = profile,
    profile_source = fallback and "fallback" or (source or "injected"),
    fallback_reason = reason,
    requested_source = source
  }
  return setmetatable(instance, { __index = P })
end

function P:id()
  return self.profile.id
end

function P:is_fallback()
  return self.profile_source == "fallback"
end

function P:get(path, default)
  if type(path) ~= "string" or path == "" then return default end
  local node = self.profile
  for token in string.gmatch(path, "[^%.]+") do
    if type(node) ~= "table" then return default end
    local value = node[token]
    if value == nil and string.match(token, "^%d+$") then
      value = node[tonumber(token)]
    end
    if value == nil then return default end
    node = value
  end
  return node
end

function P:field(group, name)
  if type(group) ~= "string" or type(name) ~= "string" then return nil end
  return self:get("export.fields." .. group .. "." .. name)
end

function P:api(key)
  if type(key) ~= "string" then return nil end
  local value = self:get("export.apis." .. key)
  if value == true or value == false then return value end
  return nil
end

function P:cap(key)
  if type(key) ~= "string" then return "unknown" end
  local value
  if type(self.profile.capabilities) == "table" then
    value = self.profile.capabilities[key]
  end
  if value == nil then
    value = self:get(key)
  end
  return normalize_state(value)
end

function P:require(key)
  if key == nil then
    local required = self.profile.required
    if type(required) ~= "table" or #required == 0 then
      error({ code = "capability", key = "required", state = "unknown", profile_id = self:id() }, 0)
    end
    for index = 1, #required do
      self:require(required[index])
    end
    return true
  end
  local state = self:cap(key)
  if state ~= "ok" then
    error({ code = "capability", key = key, state = state, profile_id = self:id() }, 0)
  end
  return true
end

function P:matrix()
  local result = {}
  if type(self.profile.capabilities) == "table" then
    for key, value in pairs(self.profile.capabilities) do
      if type(key) == "string" then
        result[#result + 1] = { key = key, state = normalize_state(value) }
      end
    end
  end
  table.sort(result, function(a, b) return a.key < b.key end)
  return result
end

function P:matrix_hash()
  return fnv1a32(matrix_canonical(self:matrix()))
end

return P
