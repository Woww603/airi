---
title: Discord Bot
description: 参与并贡献 Project AIRI
---

### Discord Bot / 机器人

```shell
cd services/discord-bot
```

配置 `.env` 文件：

```shell
cp .env .env.local
```

编辑 `.env.local` 中的各类密钥和配置信息。

启动机器人：

```shell
pnpm -F @proj-airi/discord-bot start
```

### 独立 Discord App

如果只是非商业自用，可以在不启动 AIRI 桌面端的情况下运行 Discord 聊天：

```shell
pnpm dev:discord
```

这个命令会以 standalone 模式启动 `@proj-airi/discord-bot`，并默认打开本地 dashboard：`http://127.0.0.1:6122`。dashboard 会显示 Discord/DeepSeek 配置状态、最近事件和启动/停止控制，并把本地设置保存到 `services/discord-bot/.env.local`。

macOS 的 standalone Electron 窗口源码位于 `scripts/airi-discord-dashboard-window`。生成的 `.app` 和桌面软链接只属于本机，并由 Git 忽略。

如果使用 DeepSeek，配置 `DISCORD_TOKEN`、`DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL` 即可。`OPENAI_*` 字段只是 OpenAI-compatible 的可选兜底配置。

AIRI 桌面桥接现在由 Tamagotchi 的 Electron Main 进程内部管理。请在 AIRI 设置中配置；旧 bridge CLI 和环境变量 token 启动器已经退役。

::: tip

如果你使用 [@antfu/ni](https://github.com/antfu-collective/ni)，你可以：

```shell
nr -F @proj-airi/discord-bot start
```

:::
