---
title: Discord Bot
description: Project AIRI への貢献
---

### Discord bot 統合

```shell
cd services/discord-bot
```

`.env` の設定

```shell
cp .env .env.local
```

`.env.local` 内の認証情報を編集します。

ボットの実行

```shell
pnpm -F @proj-airi/discord-bot start
```

### 単体 Discord アプリ

個人利用・非商用利用では、AIRI デスクトップを起動せずに Discord チャットを実行できます。

```shell
pnpm dev:discord
```

このコマンドは `@proj-airi/discord-bot` を standalone モードで起動し、既定で `http://127.0.0.1:6122` にローカル dashboard を開きます。dashboard では Discord/DeepSeek 設定状態、最近のイベント、start/stop 操作を確認できます。ローカル設定は `services/discord-bot/.env.local` に保存されます。

macOS 向け standalone Electron ウィンドウのソースは `scripts/airi-discord-dashboard-window` にあります。生成された `.app` と Desktop のシンボリックリンクはローカル成果物として Git から除外されます。

DeepSeek を使う場合は、`DISCORD_TOKEN`、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL` を設定します。`OPENAI_*` は OpenAI-compatible 用の任意のフォールバック設定です。

AIRI デスクトップ bridge は Tamagotchi の Electron Main プロセスが内部管理します。AIRI 設定から構成してください。旧 bridge CLI と環境変数 token ランチャーは廃止されました。

::: tip

[@antfu/ni](https://github.com/antfu-collective/ni) ユーザーの場合：

```shell
nr -F @proj-airi/discord-bot start
```

:::
