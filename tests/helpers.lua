-- tests/helpers.lua —— 测试辅助：恒速真值源、静态 RCS、收集 sink（与核心适配器契约一致）

local H = {}

local function advance(pos, vel, now)
  return {
    x = pos.x + vel.x * now,
    y = pos.y + vel.y * now,
    z = pos.z + vel.z * now,
  }
end

-- own = {pos=, vel=, heading=, pitch=, roll=}
-- targets = {{id=, label=, coalition=, pos=, vel=, blocked=, rcs_m2=, rcs_class=}, ...}
-- 适配器方法会被核心以 obj:method(...) 方式调用，故首个参数为 self（忽略）
function H.truth(own, targets)
  return {
    ownship = function(_, now)
      return {
        label = own.label, heading = own.heading, pitch = own.pitch, roll = own.roll,
        pos = advance(own.pos, own.vel, now), vel = own.vel,
      }
    end,
    targets = function(_, now)
      local out = {}
      for i, tg in ipairs(targets) do
        out[i] = {
          id = tg.id, label = tg.label or tg.typeName, coalition = tg.coalition,
          pos = advance(tg.pos, tg.vel, now), vel = tg.vel,
          blocked = tg.blocked, rcs_m2 = tg.rcs_m2, rcs_class = tg.rcs_class,
        }
      end
      return out
    end,
  }
end

function H.rcs_static(value)
  return { get = function(_, _target) return { rcs_m2 = value, source = "test" } end }
end

function H.sink()
  local s = { tracks_hist = {}, dwells = {} }
  function s:on_tracks(tracks) self.tracks_hist[#self.tracks_hist + 1] = tracks end
  function s:on_dwell(d) self.dwells[#self.dwells + 1] = d end
  return s
end

return H
