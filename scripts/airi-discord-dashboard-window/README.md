# AIRI Discord Dashboard Window

This local macOS app bundle opens the standalone Discord dashboard in an Electron window instead of a browser tab.

The maintained source is `main.cjs` plus this README. The generated `.app` bundle and any Desktop symlink are local artifacts ignored by Git.

Use it for personal development only:

- It starts `pnpm dev:discord` from the repository root.
- It shows `http://127.0.0.1:6122` inside a desktop window.
- It stops the spawned bot process when the window quits.

For terminal-only startup, run `pnpm dev:discord`. The separate `airi-discord-launcher-app` folder is the legacy bridge workflow that also starts AIRI desktop.

Keep tokens in `services/discord-bot/.env.local`; do not commit generated bundles, local desktop aliases, or secrets.
