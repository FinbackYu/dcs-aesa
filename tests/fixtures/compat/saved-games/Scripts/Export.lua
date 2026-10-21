-- fixture Export.lua: mimics the deployed AESA marker block
--[[ AESA EXPORT BEGIN ]]
local ok, err = pcall(dofile, "Scripts/AESA/aesa_export.lua")
if not ok then
  -- fixture: no log call, this file is only read by compat_check
end
--[[ AESA EXPORT END ]]
