-- DO NOT EDIT WITHOUT UPDATING tests/test_gate2_config.cjs
-- HANDWRITTEN SOURCE -- not a generated artifact; logic preserved from src/aesa/config.lua.
-- generator: none (hand-written module; generated files are produced by scripts/gen_config.cjs)
-- source-sha256: 81061c2da323fd329af0e7066bc235c8c423b7cfb33c53c7f0ec43a8d31c6e20
-- aesa/config_validate.lua —— 配置注入校验（手写，不生成）
-- 逻辑与 src/aesa/config.lua 的 config.validate 保持一致，供后续 init.build(root, {config=...})
-- 在注入自定义配置后显式调用。生成物 src/shared/config.lua 不自动 require 本文件。

local M = {}

local function finite_number(v)
  return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

-- 配置自检：搜索俯仰条带中心必须升序，且相邻间距 <= 俯仰波束 HPBW。
-- 间距大于 HPBW 会在条带之间留下盲带；这里 fail-closed，禁止静默接受。
function M.validate(cfg)
  if type(cfg) ~= "table" then error("config must be a table", 2) end
  local radar = cfg.radar
  if type(radar) ~= "table" then error("config.radar missing", 2) end
  local hpbw = radar.hpbw_el_deg
  if not finite_number(hpbw) or hpbw <= 0 then
    error("config.radar.hpbw_el_deg must be a positive finite number", 2)
  end

  local search = cfg.scheduler and cfg.scheduler.search
  if type(search) ~= "table" then error("config.scheduler.search missing", 2) end
  local bars = search.el_bars_deg
  if type(bars) ~= "table" or #bars < 1 then
    error("config.scheduler.search.el_bars_deg must be a non-empty sequence", 2)
  end

  local prev
  for i = 1, #bars do
    local el = bars[i]
    if not finite_number(el) then
      error(string.format(
        "config.scheduler.search.el_bars_deg[%d] must be a finite number", i), 2)
    end
    if prev ~= nil then
      local step = el - prev
      if step <= 0 then
        error(string.format(
          "config.scheduler.search.el_bars_deg must be strictly increasing: "
          .. "[%d]=%.6f, [%d]=%.6f", i - 1, prev, i, el), 2)
      end
      if step > hpbw then
        error(string.format(
          "elevation blind band: el_bars_deg[%d]=%.3f and [%d]=%.3f are %.3f deg apart; "
          .. "spacing must be <= hpbw_el_deg=%.3f",
          i - 1, prev, i, el, step, hpbw), 2)
      end
    end
    prev = el
  end
  return true
end

return M
