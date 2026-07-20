# `discord-bot`

Allow アイリ to talk to you and many other users in Discord voice channels.

## Getting started

```shell
git clone git@github.com:moeru-ai/airi.git
pnpm i
```

In [Discord Developer Portal](https://discord.com/developers/home), create a new application and this will be the bot
you will add to your server.

In the **"Bot"** tab, find "Privileged Gateway Intents" section, toggle on the following intents:

- **"Server Members Intent"**
- **"Message Content Intent"**

Now look above the "Privileged Gateway Intents" section, you will find the "Token" section,
for newly created bots, click "Reset Token" to generate a new token, and copy the token for later use.

> [!NOTE]
> If you ever forgot the token or lost it, you can always click "Reset Token" to generate a new token,
> but remember to update the token in your `.env.local` file, or configure through the UI as well.

Create a `.env.local` file:

```shell
cd services/discord-bot
cp .env .env.local
```

Fill-in the following credentials as configurations:

```shell
DISCORD_TOKEN=''
DISCORD_BOT_CLIENT_ID=''

AIRI_DISCORD_SYSTEM_PROMPT=''
AIRI_DISCORD_HISTORY_LIMIT='24'
AIRI_DISCORD_MODEL_TIMEOUT_MS='90000'
AIRI_DISCORD_DASHBOARD_ENABLED='true'
AIRI_DISCORD_DASHBOARD_HOST='127.0.0.1'
AIRI_DISCORD_DASHBOARD_PORT='6122'
AIRI_DISCORD_DASHBOARD_RGB_ON='false'
AIRI_DISCORD_ALLOWED_CHANNEL_IDS=''
AIRI_DISCORD_BLOCKED_USER_IDS=''
AIRI_DISCORD_BLOCKED_GUILD_IDS=''
AIRI_DISCORD_BLOCKED_TERMS=''
AIRI_DISCORD_ALLOW_DIRECT_MESSAGES='true'
AIRI_DISCORD_PRIVACY_NOTICE_ENABLED='true'
AIRI_DISCORD_PRIVACY_NOTICE_TEXT=''
AIRI_DISCORD_MESSAGE_PACING_MS='600'
AIRI_DISCORD_RATE_LIMIT_MAX_MESSAGES='6'
AIRI_DISCORD_RATE_LIMIT_WINDOW_MS='30000'
AIRI_DISCORD_USER_RATE_LIMIT_MAX_MESSAGES='12'
AIRI_DISCORD_GUILD_RATE_LIMIT_MAX_MESSAGES='120'
AIRI_DISCORD_GLOBAL_RATE_LIMIT_MAX_MESSAGES='300'
AIRI_DISCORD_MEMORY_ENABLED='true'
AIRI_DISCORD_MEMORY_AUTO_CAPTURE='true'
AIRI_DISCORD_MEMORY_CONSENT_REQUIRED='true'
AIRI_DISCORD_MEMORY_FILE=''
AIRI_DISCORD_MEMORY_MAX_PROMPT='8'
AIRI_DISCORD_MEMORY_MAX_STORED='1000'
AIRI_DISCORD_MEMORY_AUTO_TTL_DAYS='180'

DEEPSEEK_MODEL='deepseek-v4-flash'
DEEPSEEK_API_KEY=''
DEEPSEEK_API_BASE_URL=''

OPENAI_MODEL=''
OPENAI_API_KEY=''
OPENAI_API_BASE_URL=''

OPENAI_STT_API_KEY=''
OPENAI_STT_API_BASE_URL=''
OPENAI_STT_MODEL='whisper-1'
AIRI_DISCORD_STT_TIMEOUT_MS='30000'

OPENAI_TTS_API_KEY=''
OPENAI_TTS_API_BASE_URL=''
OPENAI_TTS_MODEL='tts-1'
OPENAI_TTS_VOICE='alloy'
AIRI_DISCORD_TTS_TIMEOUT_MS='30000'

AIRI_DISCORD_VOICE_CALL_MODE='classic'
DASHSCOPE_API_KEY=''
QWEN_REALTIME_REGION='singapore'
QWEN_REALTIME_WORKSPACE_ID=''
QWEN_REALTIME_MODEL='qwen3.5-omni-flash-realtime'
QWEN_REALTIME_VOICE='Ethan'
QWEN_REALTIME_INTERRUPTION_SENSITIVITY='40'
QWEN_REALTIME_VAD_SILENCE_DURATION_MS='600'

ELEVENLABS_API_KEY=''
ELEVENLABS_API_BASE_URL=''
```

Run AIRI as a standalone Discord app, without starting AIRI desktop:

```shell
pnpm dev:discord
```

or from the service workspace:

```shell
pnpm -F @proj-airi/discord-bot start:standalone
```

On macOS, `scripts/airi-discord-dashboard-window` contains the local Electron window wrapper for this standalone mode. Its generated `.app` bundle and Desktop symlink are machine-local artifacts; the terminal command above remains the canonical startup entrypoint.

Standalone mode responds to direct messages and guild messages that mention the bot. It opens a local AIRI-style dashboard at `http://127.0.0.1:6122` by default, where you can view status, save Discord/DeepSeek settings, manage local memory cards, edit Discord filters, toggle RGB ON accent animation, and start or restart the bot. It does not start AIRI desktop, Pinia stores, the server channel websocket, or the desktop memory UI.

Standalone mode registers the Manage Server-restricted `/summon` and `/dismiss` commands. `/summon` joins your current voice channel; `/dismiss` leaves and closes the active provider session and microphone monitors. The Dashboard's **Voice Call** service source selects one of two paths:

- `classic`: batches each participant's audio into STT requests, routes the transcription through that user's isolated standalone chat session, generates TTS for AIRI's final reply, and plays it back in the same channel. The separate Speech and Transcription tabs configure OpenAI-compatible credentials, models, base URLs, and the TTS voice.
- `qwen-realtime`: opens one native Qwen Omni Realtime audio-to-audio WebSocket per Discord voice channel. Discord PCM is streamed at 16 kHz mono; Qwen's 24 kHz mono reply is converted to Discord's 48 kHz stereo raw stream. A local PCM16 energy gate first requires 120 ms of sustained volume and preserves 250 ms of pre-roll. Qwen `semantic_vad` then confirms actual speech before it interrupts playback, commits input, or creates a response; energy-only buffers rejected as noise are cleared without a model reply. Discord speaking boundaries add bounded trailing silence after a 600 ms debounce so semantic VAD can finish the turn without a manual forced response. `QWEN_REALTIME_INTERRUPTION_SENSITIVITY` controls both layers from `0` (strongest noise rejection) to `100` (softest voice activation); the Dashboard provides 25, 40, and 70 presets and defaults to balanced 40. The upstream socket reconnects with bounded backoff after transient failures and rotates after 110 minutes, before Qwen's 120-minute session limit.

Qwen mode requires a region-matching Bailian API key and business Workspace ID. The upstream hostname is derived only from the selected Beijing or Singapore region and the validated Workspace ID; the Dashboard cannot redirect the key to an arbitrary host. The key is stored in the local `.env.local` file and public Dashboard responses expose only whether it is configured.

`/summon` first posts the selected provider disclosure and public **Opt in to voice** / **Withdraw consent** controls for that exact voice-consent session. Every current participant must opt in before AIRI joins. Consent is not carried into another session: New participants are not opted in automatically, and their receiver audio is not subscribed until they opt in. Explicit withdrawal immediately marks the session pending and invalidates the active channel generation in both modes, stopping its capture, playback, and provider work while retaining the other participants' consent records. On a normal participant leave, Qwen commits any already-admitted trailing input before releasing that speaker's capture; classic mode cancels that departing speaker's pending debounced turn and releases its capture. Qwen invalidates the channel generation on withdrawal, move, or policy revocation when audio may already be present in its aggregate provider buffer because that audio cannot be removed per speaker.

Blocked users, blocked servers, and channel allowlists are checked before Discord audio is subscribed. Qwen raw Realtime audio cannot pass through text content filters or other post-transcription controls before it reaches the provider; use classic mode when those controls must run on transcribed text before chat generation.

Turns sharing one exact Discord session are generated serially so rapid messages cannot overwrite each other's history. Different users/channels can still generate concurrently. `AIRI_DISCORD_MODEL_TIMEOUT_MS` bounds each provider request between 5 seconds and 5 minutes; the default is 90 seconds.

Classic voice creates one absolute turn deadline at speaking admission (180 seconds by default, clamped between 5 seconds and 5 minutes) and carries it through decode, STT, chat, TTS, and audio handoff. STT and TTS also have 30-second provider caps through `AIRI_DISCORD_STT_TIMEOUT_MS` and `AIRI_DISCORD_TTS_TIMEOUT_MS`, each clamped between 5 seconds and 2 minutes; every phase uses the earlier provider cap and the original turn deadline, so the full deadline is never reset between phases. Voice-session stop, move, disconnect, and replacement cancel the exact in-flight request. Providers that ignore cancellation remain tracked until actual settlement, with hard limits of four detached requests per exact speaker generation, eight across replacement generations for one participant, and 64 process-wide (16 slots remain available to new participants); their late results are discarded.

Standalone filters run before DeepSeek/model generation. The dashboard and `.env.local` can control guild channel allowlists, blocked user ids, blocked server ids, blocked terms, direct-message access, privacy notices, message pacing, and per-session rate limits. Save filter changes, then restart the bot from the dashboard to apply them to the running Discord client.

Standalone memory cards are stored in `services/discord-bot/.airi-discord-memory.json` by default. The dashboard can add, delete, and clear cards. When both memory and automatic capture are enabled, every successful turn in a memory-enabled Discord session is evaluated by the configured chat model for durable first-person facts. DMs are enabled by default; guild sessions still require explicit consent when `AIRI_DISCORD_MEMORY_CONSENT_REQUIRED='true'`. A turn may correctly produce no memory when it contains no reliable person fact. The model must return an exact contiguous excerpt from the user's current message; paraphrased, invented, low-confidence, sensitive, third-party, or unsafe evidence is rejected before storage. The assistant reply is never accepted as memory evidence.

Automatically captured cards are isolated to the exact server/channel/user session, expire after `AIRI_DISCORD_MEMORY_AUTO_TTL_DAYS` days, and record the source Discord message (when text has one), source session, extraction model, semantic class, fact key, and confidence. A newer fact with the same semantic key supersedes the older card in that exact scope; the older provenance remains inspectable in the dashboard but is excluded from prompts. Stable Discord ids own memory scope; mutable display names are dashboard metadata and are not used as prompt identity. Obvious token/API-key/password text is rejected; keep secrets in `.env.local`. Automatic extraction adds one bounded model request after a successful reply for each memory-enabled turn.

`AIRI_DISCORD_MEMORY_CONSENT_REQUIRED='true'` is the default for guild sessions. A DM starts with memory enabled and receives the configured privacy notice as a separate Discord message; an explicit preference always overrides that default. Guild sessions do not read, inject, or extract memory before consent. The same Discord user can manage only that exact session with `!airi memory on`, `!airi memory off`, `!airi memory status`, and `!airi memory forget`; Chinese equivalents are `记忆 开启`, `记忆 关闭`, `记忆 状态`, and `记忆 遗忘`. `off` persists an opt-out without deleting cards. `forget` removes captured memories, including superseded provenance, for that exact session and persists the opt-out. Explicit `记住...` / `remember...` requests still have a safe source-text fallback if structured extraction is temporarily unavailable.

Rate limiting is applied to the exact session, Discord user, guild, and whole bot. User/guild/global defaults are 2x, 20x, and 50x the configured session limit unless their dedicated environment values are set.

The standalone runtime accepts DeepSeek-specific aliases: `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, and optional `DEEPSEEK_API_BASE_URL`. It also supports OpenAI-compatible fallback fields: `OPENAI_API_KEY`, `OPENAI_MODEL`, and optional `OPENAI_API_BASE_URL`.

For DeepSeek, `.env.local` can be as small as:

```shell
AIRI_DISCORD_DASHBOARD_ENABLED='true'
DISCORD_TOKEN='your-discord-bot-token'
DEEPSEEK_API_KEY='your-deepseek-api-key'
DEEPSEEK_MODEL='deepseek-v4-flash'
```

If `DEEPSEEK_API_KEY` is set and no base URL is provided, the bot uses DeepSeek's OpenAI-compatible endpoint: `https://api.deepseek.com`.

The default `start` command always runs the standalone service:

```shell
pnpm -F @proj-airi/discord-bot start
```

## AIRI desktop integration

The desktop bridge is owned entirely by Tamagotchi's Electron Main process. Enable Discord and manage its bot token in AIRI settings; Main reads protected storage and starts the bundled utility process. There is intentionally no bridge CLI, environment-token launcher, or generic server-channel configuration path.

## Other similar projects

- [pladisdev/Discord-AI-With-STT](https://github.com/pladisdev/Discord-AI-With-STT)

## Acknowledgements

- Implementation of Audio handling and processing https://github.com/TheTrueSCP/CharacterAIVoice/blob/54d6a41b4e0eba9ad996c5f9ddcc6230277af2f8/src/VoiceHandler.js
- Example of usage https://github.com/discordjs/voice-examples/blob/da0c3b419107d41053501a4dddf3826ad53c03f7/radio-bot/src/bot.ts
- Excellent library https://github.com/discordjs/discord.js
