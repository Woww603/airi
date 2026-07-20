# Baseline Commit Report

Report date: 2026-07-20 (Europe/Berlin)

This report records preservation of the pre-security working tree on `codex/security-airi-hardening`. These commits preserve existing work; they do not claim that every preserved behavior is correct. No security scan, push, merge, rebase, deployment, or pull request was performed.

## Decisions made

| Item | Decision | Reason |
| --- | --- | --- |
| Tracked Discord `.env` | Committed the verified placeholder-only template without renaming it. | Real credentials belong in ignored `.env.local`; renaming would alter the baseline and require a separate migration. |
| Root manifest/workspace/lockfile | Committed the complete reviewed files together in the source/configuration preservation commit. | Partial reconstruction would change the baseline and could make the lockfile inconsistent with manifests. |
| Three deleted Electron preloads | Committed the deletions with the replacement preload, window wiring, sandbox, storage, configuration, and tests. | Current references use the replacement boundary; either side alone would be incomplete. |
| `design-qa.md` | Deliberately excluded as a local-only untracked QA artifact. | Its evidence exists only under machine-local `/private/tmp` screenshot paths. |
| `security_best_practices_report.md` | Committed with the prior-security-task preservation group. | It contains no credential signature and provides audit context for the next review. |
| AIRI chat-experience agent skill | Approved and committed as repository tooling. | It is complete, AIRI-specific, reproducible, and useful to other contributors. |
| Discord launcher source/docs | Approved and committed with focused tests and contributor-doc references. | The repository references maintained source; generated app bundles and runtime state remain excluded. |

The full rationale is in `BASELINE_COMMIT_DECISIONS.md`.

## Commits created

| Hash | Commit | Files |
| --- | --- | ---: |
| `496d6df875718a5613a6f4920e461b9d4cf11891` | chore(repo): preserve pre-security baseline metadata | 5 |
| `996b2650a7f352c2a21d2f4ccd5da07a2aadb7b1` | chore(repo): preserve project baseline source and config | 257 |
| `174822d80e9cf883357789d2eef613d56331d2ed` | test(repo): preserve pre-security baseline coverage | 93 |
| `8a1ba7909b2c7a24a26ef7e65820349a8958f891` | chore(security): preserve prior hardening baseline | 101 |
| `HEAD (self)` | chore(tooling): preserve contributor tooling baseline | 17 |


The final row is necessarily self-referential: a commit cannot embed its own final object hash because changing the report changes that hash. After creation, `git rev-parse HEAD` is the authoritative hash and is reported in the task handoff.

## Files included in each commit

### chore(repo): preserve pre-security baseline metadata

Hash: `496d6df875718a5613a6f4920e461b9d4cf11891`

- `.gitignore`
- `AGENTS.md`
- `BASELINE_COMMIT_DECISIONS.md`
- `PRE_SECURITY_BASELINE.md`
- `SAFE_BASELINE_REVIEW.md`

### chore(repo): preserve project baseline source and config

Hash: `996b2650a7f352c2a21d2f4ccd5da07a2aadb7b1`

- `apps/component-calling/package.json`
- `apps/discord-dashboard/README.md`
- `apps/discord-dashboard/electron-builder.config.ts`
- `apps/discord-dashboard/electron.vite.config.ts`
- `apps/discord-dashboard/package.json`
- `apps/discord-dashboard/src/main/copy-opusscript-runtime.mjs`
- `apps/discord-dashboard/src/main/ffmpegStaticUnavailable.cjs`
- `apps/discord-dashboard/tsconfig.json`
- `apps/server/docs/ai-context/admin-flux-grants.md`
- `apps/server/docs/ai-context/verifications/streaming-tts.md`
- `apps/stage-pocket/package.json`
- `apps/stage-tamagotchi/package.json`
- `apps/stage-tamagotchi/src/main/configs/artistry.ts`
- `apps/stage-tamagotchi/src/main/index.ts`
- `apps/stage-tamagotchi/src/main/libs/electron/eventa.ts`
- `apps/stage-tamagotchi/src/main/services/airi/auth.ts`
- `apps/stage-tamagotchi/src/main/services/airi/channel-server/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/worker.ts`
- `apps/stage-tamagotchi/src/main/services/airi/http-server/errors/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/host/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/types.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-bridge.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-payload.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistryImageDownload.ts`
- `apps/stage-tamagotchi/src/renderer/App.vue`
- `apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue`
- `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue`
- `apps/stage-tamagotchi/src/renderer/main.ts`
- `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay-polling.ts`
- `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay.vue`
- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts`
- `apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.ts`
- `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/image-journal.ts`
- `apps/stage-tamagotchi/src/renderer/widgets/artistry/components/Comfy.vue`
- `apps/stage-tamagotchi/src/shared/eventa/index.ts`
- `apps/stage-web/package.json`
- `apps/stage-web/src/main.ts`
- `apps/stage-web/src/pages/devtools/model-driver-mediapipe.vue`
- `apps/ui-server-auth/package.json`
- `docs/ai/context/verification-automation.md`
- `docs/package.json`
- `package.json`
- `packages/audio/package.json`
- `packages/audio/src/audio-context/index.ts`
- `packages/audio/src/audio-context/processor.worklet.ts`
- `packages/cap-vite/package.json`
- `packages/cap-vite/src/bin/run.ts`
- `packages/cap-vite/src/vite-plugin.ts`
- `packages/ccc/package.json`
- `packages/ccc/src/define/card.ts`
- `packages/ccc/src/export/json.ts`
- `packages/ccc/src/export/types/character_book.ts`
- `packages/ccc/src/index.ts`
- `packages/ccc/src/lorebook.ts`
- `packages/core-agent/package.json`
- `packages/core-agent/src/contracts/hook-types.ts`
- `packages/core-agent/src/index.ts`
- `packages/core-agent/src/messages/prompt-contributions.ts`
- `packages/core-agent/src/runtime/agent-hooks.ts`
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`
- `packages/core-agent/src/types/chat.ts`
- `packages/core-agent/src/types/llm.ts`
- `packages/electron-eventa/package.json`
- `packages/electron-screen-capture/package.json`
- `packages/electron-vueuse/package.json`
- `packages/i18n/src/locales/en/settings.yaml`
- `packages/i18n/src/locales/ja/settings.yaml`
- `packages/i18n/src/locales/zh-Hans/settings.yaml`
- `packages/model-driver-mediapipe/tasks/prepare-tasks.ts`
- `packages/pipelines-audio/src/managers/playback-manager.ts`
- `packages/plugin-protocol/src/types/events.ts`
- `packages/plugin-sdk/package.json`
- `packages/plugin-sdk/src/channels/shared.ts`
- `packages/plugin-sdk/src/plugin-host/core.ts`
- `packages/plugin-sdk/src/plugin-host/index.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/node/context.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/node/index.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/node/loaders/fs.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/node/session.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/shared/services/tools.ts`
- `packages/plugin-sdk/src/plugin-host/shared/types.ts`
- `packages/plugin-sdk/src/plugin/index.ts`
- `packages/plugin-sdk/src/plugin/load.ts`
- `packages/scenarios-stage-tamagotchi-browser/package.json`
- `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/macos-26/texts/index.ts`
- `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/windows-11/index.ts`
- `packages/server-runtime/src/bin/processLifecycle.ts`
- `packages/server-runtime/src/bin/run.ts`
- `packages/server-runtime/src/index.ts`
- `packages/server-runtime/src/server-ws/airi/index.ts`
- `packages/server-runtime/src/server-ws/core/index.ts`
- `packages/server-runtime/src/server/index.ts`
- `packages/server-runtime/src/types/conn.ts`
- `packages/server-sdk/src/client.ts`
- `packages/server-sdk/src/index.ts`
- `packages/server-sdk/src/observer.ts`
- `packages/server-shared/src/errors.ts`
- `packages/stage-layouts/package.json`
- `packages/stage-layouts/src/components/Layouts/HeaderAvatar.vue`
- `packages/stage-pages/package.json`
- `packages/stage-pages/src/pages/devtools/context-flow/components/context-flow-prompt-projection.vue`
- `packages/stage-pages/src/pages/devtools/context-flow/components/promptContributionList.vue`
- `packages/stage-pages/src/pages/devtools/plugin-host.vue`
- `packages/stage-pages/src/pages/devtools/providers-transcription-realtime-aliyun-nls.vue`
- `packages/stage-pages/src/pages/devtools/websocket-inspector.vue`
- `packages/stage-pages/src/pages/settings/account/account-settings-page.vue`
- `packages/stage-pages/src/pages/settings/airi-card/components/CardCreationDialog.vue`
- `packages/stage-pages/src/pages/settings/airi-card/components/CardDetailDialog.vue`
- `packages/stage-pages/src/pages/settings/modules/hearing.vue`
- `packages/stage-pages/src/pages/settings/modules/memory-long-term.vue`
- `packages/stage-pages/src/pages/settings/modules/memory-short-term.vue`
- `packages/stage-pages/src/pages/settings/providers/chat/ollama.vue`
- `packages/stage-pages/src/pages/settings/providers/speech/mimo-audio-speech.vue`
- `packages/stage-pages/src/pages/settings/providers/transcription/aliyun-nls-transcription.vue`
- `packages/stage-pages/src/pages/settings/providers/transcription/browser-web-speech-api.vue`
- `packages/stage-pages/src/pages/settings/scene/index.vue`
- `packages/stage-shared/package.json`
- `packages/stage-shared/src/composables/index.ts`
- `packages/stage-shared/src/discord-bridge.ts`
- `packages/stage-shared/src/window.ts`
- `packages/stage-ui-live2d/package.json`
- `packages/stage-ui-live2d/src/utils/live2d-structure-report.ts`
- `packages/stage-ui-spine/package.json`
- `packages/stage-ui-spine/src/components/scenes/spine/Model.vue`
- `packages/stage-ui-spine/src/utils/spine-preview.ts`
- `packages/stage-ui-three/package.json`
- `packages/stage-ui/package.json`
- `packages/stage-ui/src/components/modules/MessagingDiscord.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/action-menu/index.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/action-menu/menu-items.ts`
- `packages/stage-ui/src/components/scenarios/chat/components/assistant-item.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/history.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/messageTextEditor.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/sessionPromptControls.vue`
- `packages/stage-ui/src/components/scenarios/chat/components/user-item.vue`
- `packages/stage-ui/src/components/scenarios/chat/index.ts`
- `packages/stage-ui/src/components/scenarios/dialogs/model-selector/Live2DReportModal.vue`
- `packages/stage-ui/src/components/scenarios/dialogs/onboarding/onboarding.vue`
- `packages/stage-ui/src/components/scenarios/providers/speech-playground-openai-compatible.vue`
- `packages/stage-ui/src/components/scenarios/providers/speech-playground.vue`
- `packages/stage-ui/src/components/scenarios/providers/transcription-playground.vue`
- `packages/stage-ui/src/components/scenes/Stage.vue`
- `packages/stage-ui/src/composables/audio/audio-analyzer.ts`
- `packages/stage-ui/src/composables/use-data-maintenance.ts`
- `packages/stage-ui/src/composables/use-modules-list.ts`
- `packages/stage-ui/src/composables/whisper.ts`
- `packages/stage-ui/src/database/repos/chat-memory.repo.ts`
- `packages/stage-ui/src/database/repos/discord-memory.repo.ts`
- `packages/stage-ui/src/libs/auth-config.ts`
- `packages/stage-ui/src/libs/auth.ts`
- `packages/stage-ui/src/libs/inference/adapters/background-removal.ts`
- `packages/stage-ui/src/libs/inference/adapters/kokoro.ts`
- `packages/stage-ui/src/libs/inference/adapters/whisper.ts`
- `packages/stage-ui/src/libs/inference/protocol.ts`
- `packages/stage-ui/src/libs/inference/worker-manager.ts`
- `packages/stage-ui/src/libs/speech/tts-session.ts`
- `packages/stage-ui/src/libs/workers/worker.ts`
- `packages/stage-ui/src/stores/ai/models/vad.ts`
- `packages/stage-ui/src/stores/auth.ts`
- `packages/stage-ui/src/stores/chat-memory.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/chat/maintenance.ts`
- `packages/stage-ui/src/stores/chat/memory-store.ts`
- `packages/stage-ui/src/stores/chat/session-store.ts`
- `packages/stage-ui/src/stores/configurator.ts`
- `packages/stage-ui/src/stores/devtools/context-observability.ts`
- `packages/stage-ui/src/stores/devtools/plugin-host-debug.ts`
- `packages/stage-ui/src/stores/devtools/websocket-inspector.ts`
- `packages/stage-ui/src/stores/index.ts`
- `packages/stage-ui/src/stores/mods/api/channel-server.ts`
- `packages/stage-ui/src/stores/mods/api/context-bridge.ts`
- `packages/stage-ui/src/stores/modules/airi-card.ts`
- `packages/stage-ui/src/stores/modules/artistry-autonomous.ts`
- `packages/stage-ui/src/stores/modules/artistry.ts`
- `packages/stage-ui/src/stores/modules/consciousness.ts`
- `packages/stage-ui/src/stores/modules/discord.ts`
- `packages/stage-ui/src/stores/modules/twitter.ts`
- `packages/stage-ui/src/stores/providers.ts`
- `packages/stage-ui/src/stores/providers/web-speech-api/index.ts`
- `packages/stage-ui/src/types/chat-session.ts`
- `packages/stage-ui/src/types/chat.ts`
- `packages/stage-ui/src/workers/background-removal/worker.ts`
- `packages/stage-ui/src/workers/kokoro/worker.ts`
- `packages/ui-loading-screens/package.json`
- `packages/ui-loading-screens/src/components/LoadingSciFiCircle/index.vue`
- `packages/ui-transitions/package.json`
- `packages/ui/package.json`
- `packages/unocss-preset-fonts/package.json`
- `packages/vishot-runtime/package.json`
- `plugins/airi-plugin-game-chess/package.json`
- `plugins/airi-plugin-web-extension/package.json`
- `plugins/airi-plugin-web-extension/src/background/client.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `services/computer-use-mcp/chrome-extension/msg_bridge.js`
- `services/computer-use-mcp/src/bin/demo-hello-world.ts`
- `services/computer-use-mcp/src/bin/runner.ts`
- `services/computer-use-mcp/src/browser-dom/cdp-bridge.ts`
- `services/computer-use-mcp/src/desktop-grounding-types.ts`
- `services/computer-use-mcp/src/desktop-grounding.ts`
- `services/computer-use-mcp/src/executors/linux-x11.ts`
- `services/computer-use-mcp/src/executors/macos-local.ts`
- `services/computer-use-mcp/src/runner/client.ts`
- `services/computer-use-mcp/src/runner/service.ts`
- `services/computer-use-mcp/src/runtime-probes.ts`
- `services/computer-use-mcp/src/server/action-executor.ts`
- `services/computer-use-mcp/src/server/cdp-manager.ts`
- `services/computer-use-mcp/src/server/register-accessibility.ts`
- `services/computer-use-mcp/src/server/register-cdp.ts`
- `services/computer-use-mcp/src/server/register-chrome-session.ts`
- `services/computer-use-mcp/src/server/register-desktop-grounding.ts`
- `services/computer-use-mcp/src/server/register-display.ts`
- `services/computer-use-mcp/src/server/register-pty.ts`
- `services/computer-use-mcp/src/server/tool-descriptors/desktop.ts`
- `services/computer-use-mcp/src/server/workflow-prep-tools.ts`
- `services/computer-use-mcp/src/snap-resolver.ts`
- `services/computer-use-mcp/src/terminal/pty-runner.ts`
- `services/computer-use-mcp/src/types.ts`
- `services/computer-use-mcp/src/utils/screenshot.ts`
- `services/computer-use-mcp/src/workflows/engine.ts`
- `services/discord-bot/.env`
- `services/discord-bot/package.json`
- `services/discord-bot/src/adapters/airi-adapter.ts`
- `services/discord-bot/src/adapters/discordIngressScheduler.ts`
- `services/discord-bot/src/bots/discord/commands/index.ts`
- `services/discord-bot/src/bots/discord/commands/summon.ts`
- `services/discord-bot/src/bots/discord/commands/voiceDiagnostics.ts`
- `services/discord-bot/src/index.ts`
- `services/discord-bot/src/pipelines/classic-voice-audio.ts`
- `services/discord-bot/src/pipelines/openai-speech.ts`
- `services/discord-bot/src/standalone/app-controller.ts`
- `services/discord-bot/src/standalone/app-runtime.ts`
- `services/discord-bot/src/standalone/capability-diagnostics.ts`
- `services/discord-bot/src/standalone/character-card.ts`
- `services/discord-bot/src/standalone/chat-runtime.ts`
- `services/discord-bot/src/standalone/discord-reply-text.ts`
- `services/discord-bot/src/standalone/qwen-realtime.ts`
- `services/discord-bot/src/standalone/realtime-provider-failure.ts`
- `services/discord-bot/src/standalone/rules.ts`
- `services/discord-bot/src/standalone/speech-runtime.ts`
- `services/discord-bot/src/standalone/voiceDiagnostics.ts`
- `services/discord-bot/src/utils/audio.ts`
- `services/discord-bot/src/utils/opus.ts`
- `services/minecraft/package.json`
- `services/minecraft/src/cognitive/conscious/brain.ts`
- `services/minecraft/src/cognitive/conscious/map-renderer.ts`
- `services/minecraft/src/debug/server.ts`
- `services/minecraft/src/debug/tool-executor.ts`
- `services/minecraft/src/utils/mcdata.ts`
- `services/satori-bot/package.json`
- `services/telegram-bot/package.json`
- `services/twitter-services/package.json`
- `services/twitter-services/src/adapters/airi-adapter.ts`
- `services/twitter-services/src/core/services/tweet.ts`
- `services/twitter-services/src/parsers/profile-parser.ts`
- `services/twitter-services/src/parsers/tweet-parser.ts`

### test(repo): preserve pre-security baseline coverage

Hash: `174822d80e9cf883357789d2eef613d56331d2ed`

- `.github/workflows/ci.yml`
- `apps/discord-dashboard/scripts/classicVoiceAudioBundleSmoke.mjs`
- `apps/discord-dashboard/src/main/copy-opusscript-runtime.test.mjs`
- `apps/discord-dashboard/vitest.config.ts`
- `apps/server/scripts/e2e-llm-router.ts`
- `apps/server/src/utils/envelope-crypto.test.ts`
- `apps/stage-tamagotchi/scripts/desktop-overlay-live-window-smoke.ts`
- `apps/stage-tamagotchi/src/main/libs/electron/eventa.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/index.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/worker.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/index.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-bridge.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-payload.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/widgets/artistryImageDownload.test.ts`
- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.test.ts`
- `apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.test.ts`
- `packages/ccc/src/character-book-export.test.ts`
- `packages/ccc/src/lorebook.test.ts`
- `packages/ccc/vitest.config.ts`
- `packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts`
- `packages/plugin-sdk/src/plugin-host/core.test.ts`
- `packages/plugin-sdk/src/plugin-host/runtimes/shared/services/tools.test.ts`
- `packages/server-runtime/src/bin/processLifecycle.test.ts`
- `packages/server-runtime/src/server-ws/airi/index.test.ts`
- `packages/server-runtime/src/server-ws/core/index.test.ts`
- `packages/server-runtime/src/server.lifecycle.test.ts`
- `packages/server-runtime/src/server.test.ts`
- `packages/server-sdk/test/client.test.ts`
- `packages/stage-ui/src/components/scenarios/chat/components/action-menu/index.test.ts`
- `packages/stage-ui/src/components/scenarios/chat/components/history.browser.test.ts`
- `packages/stage-ui/src/database/repos/chat-memory.repo.test.ts`
- `packages/stage-ui/src/database/repos/discord-memory.repo.test.ts`
- `packages/stage-ui/src/libs/auth.test.ts`
- `packages/stage-ui/src/libs/speech/tts-session.test.ts`
- `packages/stage-ui/src/stores/chat.contract.test.ts`
- `packages/stage-ui/src/stores/chat/session-store.test.ts`
- `packages/stage-ui/src/stores/devtools/websocket-inspector.test.ts`
- `packages/stage-ui/src/stores/mods/api/channel-server.test.ts`
- `packages/stage-ui/src/stores/mods/api/context-bridge-performance-call.test.ts`
- `packages/stage-ui/src/stores/mods/api/context-bridge.contract.browser.test.ts`
- `packages/stage-ui/src/stores/modules/discord.persistence.browser.test.ts`
- `packages/stage-ui/src/stores/modules/discord.test.ts`
- `scripts/verify-ci-command-contract.mjs`
- `scripts/verify-ci-command-contract.test.mjs`
- `scripts/vitest.ci-command-contract.config.mts`
- `services/computer-use-mcp/src/bin/e2e-airi-chat-observable.ts`
- `services/computer-use-mcp/src/bin/e2e-airi-chat-terminal-self-acquire.ts`
- `services/computer-use-mcp/src/bin/e2e-airi-discord-agentic.ts`
- `services/computer-use-mcp/src/bin/e2e-airi-discord-observable.ts`
- `services/computer-use-mcp/src/desktop-grounding-capture.test.ts`
- `services/computer-use-mcp/src/desktop-grounding.test.ts`
- `services/computer-use-mcp/src/server/register-chrome-session.test.ts`
- `services/computer-use-mcp/src/server/register-desktop-grounding.test.ts`
- `services/computer-use-mcp/src/server/register-tools-pty-approval.test.ts`
- `services/computer-use-mcp/src/terminal/runner.test.ts`
- `services/discord-bot/src/adapters/airi-adapter.lifecycle.test.ts`
- `services/discord-bot/src/adapters/airi-adapter.test.ts`
- `services/discord-bot/src/adapters/airi-adapter.turn-correlation.test.ts`
- `services/discord-bot/src/adapters/airi-adapter.voice-boundaries.test.ts`
- `services/discord-bot/src/adapters/airi-adapter.voice-public.integration.test.ts`
- `services/discord-bot/src/adapters/discordIngressScheduler.test.ts`
- `services/discord-bot/src/bots/discord/commands/classic-voice-audio.integration.test.ts`
- `services/discord-bot/src/bots/discord/commands/index.test.ts`
- `services/discord-bot/src/bots/discord/commands/ping.test.ts`
- `services/discord-bot/src/bots/discord/commands/qwen-realtime-consent-audio.integration.test.ts`
- `services/discord-bot/src/bots/discord/commands/qwen-realtime-voice-manager.integration.test.ts`
- `services/discord-bot/src/bots/discord/commands/summon-standalone.test.ts`
- `services/discord-bot/src/bots/discord/commands/summon.test.ts`
- `services/discord-bot/src/pipelines/openai-speech.test.ts`
- `services/discord-bot/src/pipelines/tts.test.ts`
- `services/discord-bot/src/standalone/app-controller.lifecycle.test.ts`
- `services/discord-bot/src/standalone/app-controller.test.ts`
- `services/discord-bot/src/standalone/app-runtime.test.ts`
- `services/discord-bot/src/standalone/capability-diagnostics.production.test.ts`
- `services/discord-bot/src/standalone/capability-diagnostics.test.ts`
- `services/discord-bot/src/standalone/character-card.test.ts`
- `services/discord-bot/src/standalone/chat-runtime.test.ts`
- `services/discord-bot/src/standalone/discord-reply-text.test.ts`
- `services/discord-bot/src/standalone/qwen-realtime.test.ts`
- `services/discord-bot/src/standalone/readmeConsent.test.ts`
- `services/discord-bot/src/standalone/speech-runtime.test.ts`
- `services/discord-bot/src/standalone/voiceDiagnostics.test.ts`
- `services/discord-bot/src/test/discordVoiceHarness.ts`
- `services/discord-bot/src/test/pcmFixtures.ts`
- `services/discord-bot/src/utils/audio.test.ts`
- `services/discord-bot/vitest.config.ts`
- `services/minecraft/src/cognitive/conscious/brain.test.ts`
- `services/minecraft/src/cognitive/conscious/map-renderer.test.ts`
- `services/minecraft/src/cognitive/perception/rules/rules.test.ts`
- `services/minecraft/src/utils/mcdata.test.ts`
- `services/twitter-services/src/parsers/command-parser.test.ts`
- `services/twitter-services/vitest.config.ts`
- `vitest.config.ts`

### chore(security): preserve prior hardening baseline

Hash: `8a1ba7909b2c7a24a26ef7e65820349a8958f891`

- `.github/workflows/release-tamagotchi.yml`
- `apps/discord-dashboard/src/main/application-menu.test.ts`
- `apps/discord-dashboard/src/main/application-menu.ts`
- `apps/discord-dashboard/src/main/index.logging-security.test.mjs`
- `apps/discord-dashboard/src/main/index.ts`
- `apps/stage-tamagotchi/build/entitlements.mac.plist`
- `apps/stage-tamagotchi/electron-builder.config.ts`
- `apps/stage-tamagotchi/electron.vite.config.ts`
- `apps/stage-tamagotchi/scripts/packaging-security.test.ts`
- `apps/stage-tamagotchi/src/main/app/console-write-guard.test.ts`
- `apps/stage-tamagotchi/src/main/app/console-write-guard.ts`
- `apps/stage-tamagotchi/src/main/app/file-logger.ts`
- `apps/stage-tamagotchi/src/main/services/airi/http-server/static-assets/route.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/http-server/static-assets/route.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/policy.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/policy.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/window-policy.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/window-policy.ts`
- `apps/stage-tamagotchi/src/main/services/electron/protected-storage.test.ts`
- `apps/stage-tamagotchi/src/main/services/electron/protected-storage.ts`
- `apps/stage-tamagotchi/src/main/services/electron/secure-storage.test.ts`
- `apps/stage-tamagotchi/src/main/services/electron/secure-storage.ts`
- `apps/stage-tamagotchi/src/main/windows/about/index.ts`
- `apps/stage-tamagotchi/src/main/windows/about/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/beat-sync/index.ts`
- `apps/stage-tamagotchi/src/main/windows/caption/index.ts`
- `apps/stage-tamagotchi/src/main/windows/chat/index.ts`
- `apps/stage-tamagotchi/src/main/windows/chat/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/dashboard/index.ts`
- `apps/stage-tamagotchi/src/main/windows/dashboard/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/index.ts`
- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/window-contract.test.ts`
- `apps/stage-tamagotchi/src/main/windows/desktop-overlay/window-contract.ts`
- `apps/stage-tamagotchi/src/main/windows/devtools/index.ts`
- `apps/stage-tamagotchi/src/main/windows/inlay/index.ts`
- `apps/stage-tamagotchi/src/main/windows/inlay/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/main/index.ts`
- `apps/stage-tamagotchi/src/main/windows/main/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/notice/index.ts`
- `apps/stage-tamagotchi/src/main/windows/onboarding/index.ts`
- `apps/stage-tamagotchi/src/main/windows/settings/index.ts`
- `apps/stage-tamagotchi/src/main/windows/settings/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/main/windows/shared/preload.ts`
- `apps/stage-tamagotchi/src/main/windows/shared/referenced-window.ts`
- `apps/stage-tamagotchi/src/main/windows/shared/security.test.ts`
- `apps/stage-tamagotchi/src/main/windows/shared/security.ts`
- `apps/stage-tamagotchi/src/main/windows/widgets/index.ts`
- `apps/stage-tamagotchi/src/main/windows/widgets/rpc/index.electron.ts`
- `apps/stage-tamagotchi/src/preload/beat-sync.ts`
- `apps/stage-tamagotchi/src/preload/index.ts`
- `apps/stage-tamagotchi/src/preload/pluginSandbox.cjs`
- `apps/stage-tamagotchi/src/preload/renderer.cjs`
- `apps/stage-tamagotchi/src/preload/shared.ts`
- `apps/stage-tamagotchi/src/renderer/plugin-sandbox.html`
- `apps/stage-tamagotchi/src/renderer/plugin-sandbox.main.ts`
- `apps/stage-tamagotchi/src/shared/eventa/plugin/sandbox.ts`
- `apps/stage-tamagotchi/src/shared/plugin/sandbox-bridge.ts`
- `packages/server-runtime/src/gateway-security.test.ts`
- `packages/server-runtime/src/logging-security.test.ts`
- `packages/stage-shared/src/composables/use-sensitive-storage/index.test.ts`
- `packages/stage-shared/src/composables/use-sensitive-storage/index.ts`
- `packages/stage-ui/src/libs/chat-safety-policy.test.ts`
- `packages/stage-ui/src/libs/chat-safety-policy.ts`
- `security_best_practices_report.md`
- `services/discord-bot/README.md`
- `services/discord-bot/src/adapters/airi-adapter.logging-security.test.ts`
- `services/discord-bot/src/adapters/discordMention.test.ts`
- `services/discord-bot/src/adapters/discordMention.ts`
- `services/discord-bot/src/adapters/discordSend.test.ts`
- `services/discord-bot/src/adapters/discordSend.ts`
- `services/discord-bot/src/adapters/standalone-adapter.authorization.test.ts`
- `services/discord-bot/src/adapters/standalone-adapter.test.ts`
- `services/discord-bot/src/adapters/standalone-adapter.ts`
- `services/discord-bot/src/bots/discord/commands/authorization.test.ts`
- `services/discord-bot/src/bots/discord/commands/authorization.ts`
- `services/discord-bot/src/bots/discord/commands/registration.ts`
- `services/discord-bot/src/pipelines/tts.ts`
- `services/discord-bot/src/standalone/dashboard-server.test.ts`
- `services/discord-bot/src/standalone/dashboard-state-store.test.ts`
- `services/discord-bot/src/standalone/dashboard-state-store.ts`
- `services/discord-bot/src/standalone/dashboard-state.test.ts`
- `services/discord-bot/src/standalone/dashboard-state.ts`
- `services/discord-bot/src/standalone/dashboard-ui.lifecycle.test.ts`
- `services/discord-bot/src/standalone/dashboard-ui.test.ts`
- `services/discord-bot/src/standalone/dashboard-ui.ts`
- `services/discord-bot/src/standalone/dashboard.ts`
- `services/discord-bot/src/standalone/env-file.test.ts`
- `services/discord-bot/src/standalone/env-file.ts`
- `services/discord-bot/src/standalone/filter.test.ts`
- `services/discord-bot/src/standalone/filter.ts`
- `services/discord-bot/src/standalone/memory-extractor.test.ts`
- `services/discord-bot/src/standalone/memory-extractor.ts`
- `services/discord-bot/src/standalone/memory-store.test.ts`
- `services/discord-bot/src/standalone/memory-store.ts`
- `services/discord-bot/src/standalone/rotating-file-log.test.ts`
- `services/discord-bot/src/standalone/rotating-file-log.ts`
- `services/discord-bot/src/standalone/safety-policy.ts`
- `services/discord-bot/src/utils/audio-monitor.test.ts`
- `services/discord-bot/src/utils/audio-monitor.ts`

### chore(tooling): preserve contributor tooling baseline

Hash: `HEAD (self; resolve with git rev-parse HEAD after commit)`

- `.agents/skills/airi-chat-experience/SKILL.md`
- `.agents/skills/airi-chat-experience/agents/openai.yaml`
- `.agents/skills/airi-chat-experience/references/airi-chat-architecture.md`
- `.agents/skills/airi-chat-experience/references/chat-feature-invariants.md`
- `.agents/skills/airi-chat-experience/references/clean-room-research.md`
- `apps/stage-tamagotchi/scripts/discord-launcher-contract.test.ts`
- `docs/content/en/docs/contributing/services/discord.md`
- `docs/content/ja/docs/contributing/services/discord.md`
- `docs/content/zh-Hans/docs/contributing/services/discord.md`
- `scripts/airi-discord-dashboard-window/README.md`
- `scripts/airi-discord-dashboard-window/main.cjs`
- `scripts/airi-discord-dashboard-window/readiness.cjs`
- `scripts/airi-discord-dashboard-window/readiness.d.cts`
- `scripts/airi-discord-launcher-app/README.md`
- `scripts/dev-airi-discord.command`
- `services/discord-bot/src/standalone/dashboard-window-readiness.test.ts`
- `BASELINE_COMMIT_REPORT.md`

## Files deliberately excluded

| Path or group | Disposition | Reason |
| --- | --- | --- |
| `design-qa.md` | Left untracked and unstaged | Local-only QA report whose evidence references uncommitted `/private/tmp` screenshots. |
| `scripts/airi-discord-dashboard-window/*.app` | Ignored; observed symlink was removed before commits | Generated local application bundles/symlinks. |
| `scripts/airi-discord-launcher-app/*.app` | Ignored | Generated local application bundles. |
| `services/discord-bot/.airi-discord-dashboard-state.json` | Ignored; observed runtime file was removed before commits | Reproducible local counter/version state. |
| `services/discord-bot/.airi-discord-memory.json` | Ignored | Local runtime memory state. |
| `*.local`, `*.local.*`, build output, caches, logs, dependencies, screenshots, recordings, local databases, and editor state | Ignored/not staged | Personal, generated, sensitive-capable, or reproducible local material. |

No ignored file was staged.

## Remaining working-tree changes

Expected after the final commit:

| Status | Path | Reason |
| --- | --- | --- |
| `??` | `design-qa.md` | Intentionally excluded local-only QA artifact. |

Expected remaining tracked changes: **0**.

Expected remaining untracked files: **1**, intentionally excluded.

## Secret-check result

The staged-content checker read blobs from the Git index and emitted paths/types only. It checked credential/private-key filenames, private-key blocks, AWS/GitHub/Slack/Discord/OpenAI token signatures, and non-placeholder sensitive values in staged `.env` files.

| Commit group | Result |
| --- | --- |
| Git hygiene and baseline documentation | CLEAR — 5 staged blobs, 0 placeholder signature matches |
| Existing project source and configuration | CLEAR — 255 staged blobs plus 2 deletions, 6 known placeholder matches |
| Existing tests and test infrastructure | CLEAR — 93 staged blobs, 5 known fixture matches |
| Previous security-task/Electron boundary | CLEAR — 98 staged blobs plus 3 deletions, 1 known fixture match |
| Repository agent/launcher tooling and this report | CLEAR — 17 staged blobs, 0 placeholder signature matches |

No possible real or uncertain secret was identified. The tracked `services/discord-bot/.env` contained placeholders only, consistent with its inspected Git history.

## Validation

| Check | Result |
| --- | --- |
| Focused Electron preload/security tests | PASS — 3 files, 10 tests |
| `pnpm typecheck` | PASS — all selected workspace projects completed |
| `pnpm lint` | PASS — 0 warnings, 0 errors |
| Staged diff checks | PASS before each completed commit |
| Security scan | NOT STARTED |

## Readiness for security scanning

`READY_FOR_SECURITY_SCAN`

The only expected remaining status entry is the intentionally excluded local-only `design-qa.md`. No project source, test, required configuration, approved tooling, or possible sensitive file remains uncommitted.
