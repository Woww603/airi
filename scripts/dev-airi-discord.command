#!/bin/zsh

set -euo pipefail

export PATH="$HOME/Library/pnpm:$HOME/.local/share/pnpm:/opt/homebrew/bin:/usr/local/bin:$PATH"

script_dir="${0:A:h}"
repo_dir="${script_dir:h}"

cd "${repo_dir}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm was not found on PATH."
  echo "Open a normal terminal in ${repo_dir} and run: pnpm dev:tamagotchi"
  exit 127
fi

echo "Starting AIRI desktop with its Main-owned Discord bridge..."
echo "Repository: ${repo_dir}"
echo "Configure and enable Discord in AIRI settings."
echo "Press Ctrl-C in this window to stop AIRI."
echo

# Replacing the launcher process keeps exit codes and terminal signals attached
# to Tamagotchi. Electron Main owns the internal Discord utility process and its
# protected credential bootstrap; this shell must never become a secret owner.
exec pnpm -F @proj-airi/stage-tamagotchi dev
