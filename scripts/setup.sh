#!/usr/bin/env bash
# Fresh-machine bootstrap for the viandikafauzi/dotfiles repo.
#
# Requires the repo to already be applied via chezmoi:
#   sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply viandikafauzi
# Then:
#   ~/.local/share/chezmoi/scripts/setup.sh
#
# Idempotent — safe to re-run.
set -euo pipefail

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

# --- zsh (brew on macOS/Bazzite, distro pkg elsewhere) ---
if ! command -v zsh >/dev/null 2>&1; then
  log "installing zsh"
  if command -v brew >/dev/null 2>&1; then
    brew install zsh
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y zsh
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y zsh
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --noconfirm zsh
  else
    log "no package manager found — install zsh manually"
  fi
fi

# --- oh-my-zsh: skipped, the zshrc sources the distro config instead ---
# On CachyOS that is /usr/share/cachyos-zsh-config (system oh-my-zsh + p10k).
# On a distro without it, install your own oh-my-zsh framework here.

# --- mise: installs node/pnpm/bun/gh from config.toml ---
if ! command -v mise >/dev/null 2>&1; then
  log "installing mise"
  curl -fsSL https://mise.run | sh
fi
log "installing mise tools from config.toml"
mise install

# --- make zsh the login shell ---
ZSH_BIN="$(command -v zsh)"
if [ "$SHELL" != "$ZSH_BIN" ]; then
  log "setting login shell to $ZSH_BIN"
  if ! grep -qx "$ZSH_BIN" /etc/shells 2>/dev/null; then
    echo "$ZSH_BIN" | sudo tee -a /etc/shells >/dev/null
  fi
  if command -v chsh >/dev/null 2>&1; then
    chsh -s "$ZSH_BIN" || sudo chsh -s "$ZSH_BIN" "$USER"
  else
    sudo usermod -s "$ZSH_BIN" "$USER"   # Bazzite ships no chsh
  fi
fi

log "done. Open a new terminal (or 'exec zsh')."
