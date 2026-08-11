local wezterm = require("wezterm")
local config = {}

if wezterm.config_builder then
  config = wezterm.config_builder()
end

config.enable_kitty_keyboard = true

-- pin shell: GUI session SHELL env is stale until desktop re-login
config.default_prog = { "/home/linuxbrew/.linuxbrew/bin/zsh", "-l" }

return config
