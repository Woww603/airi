# AIRI Desktop + Discord Launcher App

This folder contains a local macOS shortcut for AIRI desktop. Tamagotchi's Electron Main process owns the bundled Discord bridge and starts its internal utility process after Discord is enabled in AIRI settings.

The generated `AIRI + Discord.app` bundle is intentionally treated as a local build artifact. Keep the source launcher script in `scripts/dev-airi-discord.command`, then rebuild or copy the `.app` only for personal use on the machine that owns the checkout.

For the standalone Discord app that does not start AIRI desktop, use:

```shell
pnpm dev:discord
```

## When to use it

- Use this when you want AIRI desktop and its Main-owned Discord integration.
- Use it when Discord should reuse AIRI desktop settings, model providers, memory, and the local server channel.
- Run `scripts/dev-airi-discord.command` when you want the same behavior from a terminal.

## When not to use it

- Do not use this as a redistributable signed app bundle.
- Do not commit bot tokens, generated app bundles, or code signatures.
- Do not use it as the fully independent Discord backend; this launcher still depends on AIRI desktop for chat generation.

## Setup

1. Make sure AIRI desktop can start with:

   ```shell
   pnpm dev:tamagotchi
   ```

2. Start AIRI through the shortcut app or run the source launcher:

   ```shell
   ./scripts/dev-airi-discord.command
   ```

3. Open AIRI settings, configure the Discord bot token, and enable Discord.

The launcher starts only `@proj-airi/stage-tamagotchi`. It does not read server-channel configuration, inspect standalone service configuration, export credentials, or start an external Discord bot. Electron Main retains protected credentials and delivers the internal bridge bootstrap through a one-time MessagePort.

The launcher replaces itself with the Tamagotchi development process, so terminal signals and the final process status are preserved.

## Notes

Project AIRI is MIT licensed, but keep existing license notices and follow Discord's Developer Terms when using a bot account. Treat Discord bot tokens and model provider keys as private secrets.
