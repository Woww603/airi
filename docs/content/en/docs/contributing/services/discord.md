---
title: Discord Bot
description: Contribute to Project AIRI
---

### Discord bot integration

```shell
cd services/discord-bot
```

Configure `.env`

```shell
cp .env .env.local
```

Edit the credentials in `.env.local`.

Run the bot

```shell
pnpm -F @proj-airi/discord-bot start
```

### Standalone Discord app

For personal, non-commercial use, you can run Discord chat without starting AIRI desktop:

```shell
pnpm dev:discord
```

This starts `@proj-airi/discord-bot` in standalone mode and opens a local dashboard at `http://127.0.0.1:6122` by default. The dashboard shows Discord/DeepSeek config status, recent events, and start/stop controls. It saves local settings to `services/discord-bot/.env.local`.

The macOS Electron wrapper for standalone mode lives under `scripts/airi-discord-dashboard-window`. Generated `.app` bundles and Desktop symlinks are local artifacts ignored by Git.

For DeepSeek, configure `DISCORD_TOKEN`, `DEEPSEEK_API_KEY`, and `DEEPSEEK_MODEL`. The OpenAI-compatible `OPENAI_*` fields are optional fallback fields.

The AIRI desktop bridge is managed internally by Tamagotchi's Electron Main process. Configure it in AIRI settings; the former source-level bridge CLI and environment-token launcher are retired.

::: tip

For [@antfu/ni](https://github.com/antfu-collective/ni) users, you can

```shell
nr -F @proj-airi/discord-bot start
```

:::
