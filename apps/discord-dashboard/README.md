# AIRI Discord

Standalone Electron host for AIRI's Discord bot and local settings dashboard.

## Use

Build a local unsigned macOS app:

```shell
pnpm -F @proj-airi/discord-dashboard build:mac
```

The production build uses the workspace-provided esbuild binary. `electron-vite@5`
only declares Vite 5–7 support; with the monorepo's Vite 8 it can exit successfully
while emitting an empty Electron main entry. Keep `electron-vite` for local
development until it supports Vite 8, and use the explicit esbuild command for
packaging:

```shell
pnpm -F @proj-airi/discord-dashboard build
```

The packaged app stores `.env.local`, memory, logs, and dashboard state under the operating system's `AIRI Discord` user-data directory. It runs the Discord client and dashboard inside Electron and does not require the AIRI repository, `pnpm`, or workspace `node_modules` after packaging.

The **Service Sources → Voice Call** page can keep the classic STT/Chat/TTS pipeline or select Qwen Omni Realtime. Qwen settings include region, Bailian Workspace ID, model, voice, and semantic/server VAD controls. API keys remain in the Electron user-data `.env.local`; the renderer receives only configured/not-configured state.

## Versioning

The local AIRI Discord app follows a three-part version number:

- Bug fixes and small changes increment the patch version (`0.1.0` → `0.1.1`).
- Feature-sized changes increment the minor version (`0.1.1` → `0.2.0`).
- Major rewrites increment the major version (`0.2.0` → `1.0.0`).

Keep the packaged app metadata and the versioned desktop shortcut in sync.

## Do Not Use

- Do not embed Discord or model-provider tokens in the app bundle.
- Do not distribute the unsigned local build as an official AIRI release.
- Use `pnpm dev:discord` when developing the bot service from source.
