# Pre-Security Git Baseline

Snapshot date: 2026-07-20 (Europe/Berlin)

This is a read-only inventory of the repository state immediately before this report was created. No files were deleted, reset, cleaned, reverted, staged, committed, pushed, or otherwise modified during inspection. `PRE_SECURITY_BASELINE.md` is the sole output and is excluded from the pre-report counts; after creation it is one additional untracked documentation file.

“Intended” in categories 1–3 is a retention-oriented classification, not proof that a particular prior task or person authored or authorized the change. Because HEAD equals the locally available `origin/main`, no commit boundary exists to establish provenance.

## 1. Current branch and HEAD

- Branch: `codex/security-airi-hardening`
- HEAD: `a3dc9c24b098f5582bbf96a32cfb0094f5346d8e`
- HEAD subject: `style(stage): refine mobile TTS stop button`
- HEAD timestamp: `2026-06-06T00:58:27+08:00`
- Local `origin/main`: `a3dc9c24b098f5582bbf96a32cfb0094f5346d8e`
- Merge base with `origin/main`: same commit
- Committed changes compared with locally available `origin/main`: 0 files, 0 additions, 0 deletions
- Configured upstream for current branch: none
- No network fetch was performed, so `origin/main` means the local remote-tracking ref as it existed at inspection time.

## 2. File counts

Pre-report snapshot:

| State | File/path count |
| --- | ---: |
| Staged | 0 |
| Tracked modified, unstaged | 288 |
| Tracked deleted, unstaged | 5 |
| Untracked | 179 |
| Total pre-existing changed/untracked paths | 472 |
| Unmerged/conflicted | 0 |

After creating this report, the repository has 180 untracked paths: the 179 inventoried paths plus `PRE_SECURITY_BASELINE.md`.

## 3. Diff statistics

### Tracked working-tree diff against HEAD

- 293 tracked files changed
- 23,574 insertions
- 2,746 deletions
- No staged diff
- Five deletions; all are listed in category 10
- No committed diff between HEAD and local `origin/main`

### Untracked contribution

- 179 untracked paths
- 178 regular text files measured
- 73,719 lines
- 2,850,104 bytes (about 2.72 MiB)
- One additional untracked symbolic link, excluded from line/byte totals

For an untracked text file, every line appears as an addition in a review pane. Therefore:

- 23,574 tracked insertions + 73,719 untracked lines = 97,293 visible additions
- This accounts for the pane's approximate 97,294 additions; the one-line discrepancy is consistent with UI/trailing-line counting and the stated approximation.
- The 2,746 deletions exactly match the tracked diff.

### Largest contributors to visible additions

| Path group | Tracked insertions | Untracked lines | Combined contribution |
| --- | ---: | ---: | ---: |
| `services/discord-bot` | 9,419 | 56,488 | 65,907 |
| `packages/stage-ui` | 7,519 | 5,468 | 12,987 |
| `apps/stage-tamagotchi` | 1,073 | 5,706 | 6,779 |
| `packages/server-runtime` | 1,573 | 1,781 | 3,354 |
| `packages/core-agent` | 1,524 | 100 | 1,624 |
| `apps/discord-dashboard` | 0 | 977 | 977 |
| `packages/server-sdk` | 741 | 223 | 964 |
| `scripts/airi-discord-dashboard-window` | 0 | 793 | 793, plus one symlink |
| All other paths | 1,725 | 2,183 | 3,908 |
| **Total** | **23,574** | **73,719** | **97,293** |

Largest individual tracked insertions:

| Path | Additions | Deletions |
| --- | ---: | ---: |
| `services/discord-bot/src/bots/discord/commands/summon.ts` | 4,728 | 267 |
| `services/discord-bot/src/adapters/airi-adapter.ts` | 3,812 | 219 |
| `packages/stage-ui/src/stores/mods/api/context-bridge.contract.browser.test.ts` | 1,548 | 3 |
| `packages/stage-ui/src/stores/mods/api/context-bridge.ts` | 1,079 | 63 |
| `packages/stage-ui/src/stores/chat.contract.test.ts` | 951 | 5 |
| `packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts` | 913 | 7 |
| `packages/stage-ui/src/stores/modules/discord.ts` | 880 | 10 |
| `packages/stage-ui/src/stores/mods/api/channel-server.test.ts` | 775 | 6 |

Largest individual untracked text files:

| Path | Lines |
| --- | ---: |
| `services/discord-bot/src/bots/discord/commands/summon.test.ts` | 8,397 |
| `services/discord-bot/src/standalone/dashboard-ui.ts` | 4,331 |
| `services/discord-bot/src/adapters/standalone-adapter.test.ts` | 2,988 |
| `services/discord-bot/src/standalone/qwen-realtime.test.ts` | 2,816 |
| `services/discord-bot/src/standalone/chat-runtime.test.ts` | 2,615 |
| `services/discord-bot/src/standalone/memory-store.test.ts` | 2,146 |
| `services/discord-bot/src/adapters/airi-adapter.turn-correlation.test.ts` | 2,114 |
| `services/discord-bot/src/adapters/standalone-adapter.ts` | 1,867 |
| `services/discord-bot/src/standalone/dashboard-ui.lifecycle.test.ts` | 1,862 |
| `packages/stage-ui/src/database/repos/discord-memory.repo.ts` | 1,747 |

The exhaustive per-path status and line statistics appear in section 13.

## 4. Classification summary

| Category | Paths | Modified | Deleted | Untracked | Staged |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. INTENDED SOURCE CHANGE | 199 | 159 | 0 | 40 | 0 |
| 2. INTENDED TEST CHANGE | 70 | 19 | 0 | 51 | 0 |
| 3. INTENDED DOCUMENTATION OR CONFIGURATION | 54 | 44 | 0 | 10 | 0 |
| 4. PREVIOUS SECURITY-TASK OUTPUT | 72 | 10 | 0 | 62 | 0 |
| 5. GENERATED BUILD OUTPUT | 1 | 0 | 0 | 1 | 0 |
| 6. DEPENDENCY OR VENDOR CONTENT | 0 | 0 | 0 | 0 | 0 |
| 7. CACHE, LOG, TEMPORARY, OR RUNTIME DATA | 1 | 0 | 0 | 1 | 0 |
| 8. LOCAL DEVELOPMENT CONFIGURATION | 11 | 0 | 0 | 11 | 0 |
| 9. POSSIBLE SECRET OR CREDENTIAL FILE | 1 | 1 | 0 | 0 | 0 |
| 10. UNKNOWN — REQUIRES HUMAN REVIEW | 63 | 55 | 5 | 3 | 0 |

Classification totals cover all 472 pre-existing changed/untracked paths. The report itself is category 3 but is deliberately excluded from the snapshot total.

## 5. Largest directories responsible for the additions

The review pane is dominated by source and tests, not dependency trees:

- `services/discord-bot`: 65,907 visible additions (67.7% of the measured total).
- `packages/stage-ui`: 12,987 (13.3%).
- `apps/stage-tamagotchi`: 6,779 (7.0%).
- `packages/server-runtime`: 3,354 (3.4%).
- `packages/core-agent`: 1,624 (1.7%).

Together those five groups account for 90,651 of 97,293 visible additions (93.2%). The Discord-bot group alone contains 80 untracked paths and 11 tracked modifications.

Disk size and Git addition count are different. `apps/discord-dashboard` occupies about 288,416 KiB on disk, but about 279,968 KiB is its ignored `dist` directory. Only 14 source/config paths and one external symlink are untracked there or point into it.

## 6. Possible generated or dependency content

Generated/runtime candidates found in the changed set:

- `scripts/airi-discord-dashboard-window/AIRI Discord v0.1.7.app` — untracked symbolic link to `apps/discord-dashboard/dist/mac-arm64/AIRI Discord.app`; generated/package output, do not commit.
- `services/discord-bot/.airi-discord-dashboard-state.json` — untracked local runtime state, do not commit without an explicit product decision.

Dependency/vendor findings:

- No `node_modules`, vendor tree, copied repository, coverage directory, cache directory, log, screenshot, recording, runtime database, generated media, certificate, or private-key file appears in Git status.
- Existing ignored `node_modules` directories and the ignored dashboard `dist` directory are present on disk but are not part of the 97,293 additions.
- `pnpm-lock.yaml` is tracked dependency metadata, not vendored dependency content. Its change is mixed with a security override and broad catalog churn, so it is category 10 until reconciled.
- Category 6 contains zero paths.

Possible overlaps requiring review, not confirmed duplication:

- `apps/discord-dashboard` versus `scripts/airi-discord-dashboard-window` and `scripts/airi-discord-launcher-app`.
- `protected-storage.*` versus `secure-storage.*` under the Electron services.
- Discord memory implementations under `services/discord-bot/src/standalone` versus `packages/stage-ui/src/database/repos`.

## 7. Possible sensitive files

Paths only; no values are reproduced:

- `services/discord-bot/.env` — tracked, modified environment/credential container.
- `services/discord-bot/.airi-discord-dashboard-state.json` — untracked local runtime state; may contain local operational metadata.
- `security_best_practices_report.md` — untracked security report containing operational review metadata.
- `apps/server/scripts/e2e-llm-router.ts` — token-shaped fixture/signature match in current file.
- `apps/server/src/utils/envelope-crypto.test.ts` — token-shaped fixture/signature match in current file.
- `packages/stage-ui/src/database/repos/chat-memory.repo.test.ts` — token-shaped fixture/signature match in current file.
- `packages/stage-ui/src/libs/chat-safety-policy.test.ts` — token-shaped fixture/signature match in current file.

The strong-signature filename-only scan found no newly added matching line in tracked diffs. The two untracked test matches are likely fixtures, but they still require human confirmation. This inventory did not print or copy any matching value.

## 8. Files likely belonging to the previous security task

Category 4 contains 72 high-confidence paths. Evidence includes:

- The untracked `security_best_practices_report.md`, which scopes a Discord bot/dashboard review and names specific fixed files.
- Explicit `security`, `logging-security`, `console-write-guard`, `protected-storage`, `secure-storage`, sandbox-policy, release-signing, and Electron-hardening paths.
- Direct correspondence between report findings and changed Discord mention handling, output safety, dashboard HTTP/Electron defenses, runtime logging/state permissions, memory loading/safety, and voice lifecycle files.

Do not attribute all Discord work to the security task. Large standalone app, voice, memory, dashboard, bridge, and chat-runtime additions look like broader feature development that the security review later touched. They are categorized by source/test type unless a direct security-task link was found.

The exact category-4 path list appears in section 13.

## 9. Files that appear safe to preserve

Preserve on disk pending review:

- Categories 1 and 2: coherent source and adjacent tests across Discord, chat/context, server lifecycle, plugin SDK, Electron bridge/sandbox, and UI work.
- Category 3: manifests, CI configuration, docs, translations, and test configuration, except mixed root files separately placed in category 10.
- Category 4: security-task source/tests/report, pending a dedicated security commit split.
- Categories 7–9 should also be preserved temporarily to avoid data loss, but they should not be committed as-is.

“Safe to preserve” does not mean “safe to commit together.” No provenance boundary exists, and the work spans multiple independent features.

## 10. Files requiring human review

Highest-priority review:

1. `services/discord-bot/.env`: determine whether it contains only safe placeholders. If any real credential ever entered Git history or a patch, rotate it before committing.
2. All five deletions: three Electron preload files and two scenario platform entry files. Confirm replacements and imports before accepting deletion.
3. `pnpm-workspace.yaml` and `pnpm-lock.yaml`: separate the documented `undici` security override from unrelated catalog normalization.
4. `package.json`: it combines Discord scripts with a root lint-command rewrite; split by intent.
5. `AGENTS.md`: project-governance changes should not be swept into a feature/security commit.
6. Category 8 local agent and launcher material: decide whether these are team-owned project assets or machine-local helpers.
7. `design-qa.md`: unrelated review artifact with no proven connection to the security task.
8. The 54 changed paths under `services/computer-use-mcp`, `services/minecraft`, and `services/twitter-services`: outside the evidenced Discord/security scope and therefore category 10.
9. The large Discord feature cluster: keep it, but reconstruct task boundaries before any commit.
10. Potentially overlapping storage, dashboard-launcher, and memory implementations listed in section 6.

The exact 63 category-10 paths are listed in section 13.

## 11. Existing .gitignore coverage and recommended additions

Existing HEAD rules already cover:

- `node_modules`
- logs
- certificate/private-key extensions
- `coverage/`
- `out/`, `bundle/`, `dist`
- temp/cache/Vite/Turbo/build outputs
- common local overrides via `*.local` and `*.local.*`
- generated assets, model assets, plugin-development directories, and common runtime data

The current unstaged `.gitignore` change proposes:

- `scripts/airi-discord-launcher-app/*.app/`
- `scripts/airi-discord-dashboard-window/*.app/`
- `.pnpm-store/`
- `services/discord-bot/.airi-discord-memory.json`

Observed gaps:

- The `*.app/` rules do not ignore the current `.app` symbolic link because the trailing slash restricts the rule to directories.
- `services/discord-bot/.airi-discord-dashboard-state.json` is not ignored.
- `services/discord-bot/.env` is tracked and no general `.env` rule exists.
- Ignoring a tracked file later does not remove it from Git; that requires a separate, explicit human-approved migration.

Recommended additions or corrections, without applying them:

```gitignore
# Local environment/credentials; keep documented templates
**/.env
**/.env.*
!**/.env.example

# Discord dashboard/runtime state
services/discord-bot/.airi-discord-dashboard-state.json
services/discord-bot/.airi-discord-memory.json

# Generated application bundles and symlinks
scripts/airi-discord-launcher-app/*.app
scripts/airi-discord-dashboard-window/*.app

# Local package-manager store
.pnpm-store/
```

Before adding the `.env` rules, migrate any intentionally tracked safe defaults to `.env.example` and confirm consumers do not require a tracked `.env`.

## 12. Proposed safe commit plan

No staging or committing was performed. Proposed order:

1. **Credential/runtime quarantine:** inspect `services/discord-bot/.env` locally without copying values into review text; migrate safe placeholders to `.env.example`; rotate any real credential; exclude dashboard state and generated `.app` output.
2. **Security-task commit:** stage only verified category-4 hardening code and its directly associated tests. Decide separately whether the security report itself belongs in Git.
3. **Discord feature commits:** split Discord bot standalone/voice/memory/dashboard/bridge production code into reviewable domain commits, each with adjacent tests and docs. Do not combine all 65,907 lines.
4. **Chat/context commits:** isolate core-agent, stage-ui chat/context bridge, prompt contribution, session storage, and memory changes by stable domain boundary.
5. **Server lifecycle/protocol commits:** isolate server-runtime, server-sdk, server-shared, and plugin protocol/SDK changes with their tests.
6. **Electron sandbox/storage commit:** after resolving whether protected/secure storage implementations overlap, commit Electron preload/window/plugin-sandbox changes with the five deletion decisions explicit.
7. **Dependency and CI commit:** reconstruct the lockfile from only approved manifest/catalog/security changes. Keep the `undici` override separate from unrelated dependency normalization where practical.
8. **Local tooling decision:** either commit category-8 assets as documented team tooling in their own commit or keep them ignored/local; do not mix them with application features.
9. **Unknown-scope cleanup decision:** assign ownership for category 10. Reject or separately commit unrelated computer-use, Minecraft, Twitter, governance, design-QA, and root-tooling changes.
10. Run scoped tests for each commit group, then required root typecheck/lint only after the baseline has been partitioned.

## 13. Exhaustive path classification and statistics

Status codes are Git porcelain codes: ` M` is unstaged tracked modification, ` D` is unstaged tracked deletion, and `??` is untracked.

### 1. INTENDED SOURCE CHANGE (199)

Plausible production-source work. “Intended” means structurally coherent and potentially preservable; authorship and authorization are not proven.

- `??` `apps/discord-dashboard/scripts/classicVoiceAudioBundleSmoke.mjs` — untracked; 199 lines, 7.8 KiB
- `??` `apps/discord-dashboard/src/main/copy-opusscript-runtime.mjs` — untracked; 88 lines, 3.3 KiB
- `??` `apps/discord-dashboard/src/main/ffmpegStaticUnavailable.cjs` — untracked; 8 lines, 474 B
- ` M` `apps/server/scripts/e2e-llm-router.ts` — modified; +13/−13
- ` M` `apps/stage-tamagotchi/scripts/desktop-overlay-live-window-smoke.ts` — modified; +9/−6
- ` M` `apps/stage-tamagotchi/src/main/configs/artistry.ts` — modified; +41/−13
- ` M` `apps/stage-tamagotchi/src/main/index.ts` — modified; +48/−11
- `??` `apps/stage-tamagotchi/src/main/libs/electron/eventa.ts` — untracked; 105 lines, 3.2 KiB
- ` M` `apps/stage-tamagotchi/src/main/services/airi/auth.ts` — modified; +5/−47
- ` M` `apps/stage-tamagotchi/src/main/services/airi/channel-server/index.ts` — modified; +135/−25
- `??` `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/index.ts` — untracked; 725 lines, 22.6 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/worker.ts` — untracked; 437 lines, 13.7 KiB
- ` M` `apps/stage-tamagotchi/src/main/services/airi/http-server/errors/index.ts` — modified; +2/−0
- ` M` `apps/stage-tamagotchi/src/main/services/airi/plugins/host/index.ts` — modified; +9/−1
- ` M` `apps/stage-tamagotchi/src/main/services/airi/plugins/types.ts` — modified; +3/−1
- ` M` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-bridge.ts` — modified; +37/−40
- `??` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-payload.ts` — untracked; 106 lines, 2.9 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistryImageDownload.ts` — untracked; 109 lines, 3.8 KiB
- ` M` `apps/stage-tamagotchi/src/main/windows/about/index.ts` — modified; +10/−9
- ` M` `apps/stage-tamagotchi/src/main/windows/about/rpc/index.electron.ts` — modified; +2/−2
- ` M` `apps/stage-tamagotchi/src/main/windows/beat-sync/index.ts` — modified; +12/−8
- ` M` `apps/stage-tamagotchi/src/main/windows/caption/index.ts` — modified; +17/−16
- ` M` `apps/stage-tamagotchi/src/main/windows/chat/index.ts` — modified; +10/−9
- ` M` `apps/stage-tamagotchi/src/main/windows/chat/rpc/index.electron.ts` — modified; +2/−2
- ` M` `apps/stage-tamagotchi/src/main/windows/dashboard/index.ts` — modified; +12/−12
- ` M` `apps/stage-tamagotchi/src/main/windows/dashboard/rpc/index.electron.ts` — modified; +2/−2
- ` M` `apps/stage-tamagotchi/src/main/windows/desktop-overlay/index.ts` — modified; +14/−5
- ` M` `apps/stage-tamagotchi/src/main/windows/desktop-overlay/rpc/index.electron.ts` — modified; +4/−3
- ` M` `apps/stage-tamagotchi/src/main/windows/desktop-overlay/window-contract.ts` — modified; +5/−4
- ` M` `apps/stage-tamagotchi/src/main/windows/devtools/index.ts` — modified; +8/−9
- ` M` `apps/stage-tamagotchi/src/main/windows/inlay/index.ts` — modified; +10/−9
- ` M` `apps/stage-tamagotchi/src/main/windows/inlay/rpc/index.electron.ts` — modified; +2/−2
- ` M` `apps/stage-tamagotchi/src/main/windows/main/index.ts` — modified; +12/−15
- ` M` `apps/stage-tamagotchi/src/main/windows/main/rpc/index.electron.ts` — modified; +3/−5
- ` M` `apps/stage-tamagotchi/src/main/windows/notice/index.ts` — modified; +8/−8
- ` M` `apps/stage-tamagotchi/src/main/windows/onboarding/index.ts` — modified; +13/−14
- ` M` `apps/stage-tamagotchi/src/main/windows/settings/index.ts` — modified; +8/−11
- ` M` `apps/stage-tamagotchi/src/main/windows/settings/rpc/index.electron.ts` — modified; +3/−5
- `??` `apps/stage-tamagotchi/src/main/windows/shared/preload.ts` — untracked; 4 lines, 175 B
- ` M` `apps/stage-tamagotchi/src/main/windows/shared/referenced-window.ts` — modified; +4/−4
- ` M` `apps/stage-tamagotchi/src/main/windows/widgets/index.ts` — modified; +14/−13
- ` M` `apps/stage-tamagotchi/src/main/windows/widgets/rpc/index.electron.ts` — modified; +2/−2
- `??` `apps/stage-tamagotchi/src/preload/renderer.cjs` — untracked; 130 lines, 4.6 KiB
- ` M` `apps/stage-tamagotchi/src/renderer/App.vue` — modified; +13/−6
- ` M` `apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue` — modified; +33/−1
- ` M` `apps/stage-tamagotchi/src/renderer/components/stage-islands/controls-island/index.vue` — modified; +4/−1
- ` M` `apps/stage-tamagotchi/src/renderer/main.ts` — modified; +17/−10
- ` M` `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay-polling.ts` — modified; +3/−1
- ` M` `apps/stage-tamagotchi/src/renderer/pages/desktop-overlay.vue` — modified; +3/−1
- ` M` `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts` — modified; +148/−1
- ` M` `apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.ts` — modified; +30/−24
- ` M` `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/image-journal.ts` — modified; +3/−2
- ` M` `apps/stage-tamagotchi/src/renderer/widgets/artistry/components/Comfy.vue` — modified; +1/−1
- ` M` `apps/stage-tamagotchi/src/shared/eventa/index.ts` — modified; +2/−0
- ` M` `apps/stage-web/src/main.ts` — modified; +17/−10
- ` M` `apps/stage-web/src/pages/devtools/model-driver-mediapipe.vue` — modified; +3/−2
- ` M` `packages/audio/src/audio-context/index.ts` — modified; +3/−1
- ` M` `packages/audio/src/audio-context/processor.worklet.ts` — modified; +3/−2
- ` M` `packages/cap-vite/src/bin/run.ts` — modified; +4/−1
- ` M` `packages/cap-vite/src/vite-plugin.ts` — modified; +4/−1
- ` M` `packages/ccc/src/define/card.ts` — modified; +2/−0
- ` M` `packages/ccc/src/export/json.ts` — modified; +1/−0
- ` M` `packages/ccc/src/export/types/character_book.ts` — modified; +8/−1
- ` M` `packages/ccc/src/index.ts` — modified; +1/−0
- `??` `packages/ccc/src/lorebook.ts` — untracked; 270 lines, 8.4 KiB
- ` M` `packages/core-agent/src/contracts/hook-types.ts` — modified; +31/−11
- ` M` `packages/core-agent/src/index.ts` — modified; +10/−1
- `??` `packages/core-agent/src/messages/prompt-contributions.ts` — untracked; 100 lines, 3.4 KiB
- ` M` `packages/core-agent/src/runtime/agent-hooks.ts` — modified; +98/−21
- ` M` `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts` — modified; +429/−90
- ` M` `packages/core-agent/src/types/chat.ts` — modified; +40/−1
- ` M` `packages/core-agent/src/types/llm.ts` — modified; +2/−0
- ` M` `packages/model-driver-mediapipe/tasks/prepare-tasks.ts` — modified; +2/−2
- ` M` `packages/pipelines-audio/src/managers/playback-manager.ts` — modified; +3/−1
- ` M` `packages/plugin-protocol/src/types/events.ts` — modified; +152/−1
- ` M` `packages/plugin-sdk/src/channels/shared.ts` — modified; +1/−1
- ` M` `packages/plugin-sdk/src/plugin-host/core.ts` — modified; +59/−23
- ` M` `packages/plugin-sdk/src/plugin-host/index.ts` — modified; +1/−0
- `??` `packages/plugin-sdk/src/plugin-host/runtimes/node/context.ts` — untracked; 32 lines, 1.1 KiB
- ` M` `packages/plugin-sdk/src/plugin-host/runtimes/node/index.ts` — modified; +2/−35
- ` M` `packages/plugin-sdk/src/plugin-host/runtimes/node/loaders/fs.ts` — modified; +3/−28
- `??` `packages/plugin-sdk/src/plugin-host/runtimes/node/session.ts` — untracked; 31 lines, 1.1 KiB
- ` M` `packages/plugin-sdk/src/plugin-host/runtimes/shared/services/tools.ts` — modified; +48/−1
- ` M` `packages/plugin-sdk/src/plugin-host/shared/types.ts` — modified; +33/−0
- ` M` `packages/plugin-sdk/src/plugin/index.ts` — modified; +1/−0
- `??` `packages/plugin-sdk/src/plugin/load.ts` — untracked; 48 lines, 1.7 KiB
- `??` `packages/server-runtime/src/bin/processLifecycle.ts` — untracked; 216 lines, 6.0 KiB
- ` M` `packages/server-runtime/src/bin/run.ts` — modified; +29/−16
- ` M` `packages/server-runtime/src/index.ts` — modified; +483/−212
- ` M` `packages/server-runtime/src/server-ws/airi/index.ts` — modified; +1/−0
- ` M` `packages/server-runtime/src/server-ws/core/index.ts` — modified; +141/−1
- ` M` `packages/server-runtime/src/server/index.ts` — modified; +234/−36
- ` M` `packages/server-runtime/src/types/conn.ts` — modified; +37/−1
- ` M` `packages/server-sdk/src/client.ts` — modified; +86/−24
- ` M` `packages/server-sdk/src/index.ts` — modified; +1/−0
- `??` `packages/server-sdk/src/observer.ts` — untracked; 223 lines, 5.6 KiB
- ` M` `packages/server-shared/src/errors.ts` — modified; +49/−1
- ` M` `packages/stage-layouts/src/components/Layouts/HeaderAvatar.vue` — modified; +3/−1
- ` M` `packages/stage-pages/src/pages/devtools/context-flow/components/context-flow-prompt-projection.vue` — modified; +7/−0
- `??` `packages/stage-pages/src/pages/devtools/context-flow/components/promptContributionList.vue` — untracked; 101 lines, 4.0 KiB
- ` M` `packages/stage-pages/src/pages/devtools/plugin-host.vue` — modified; +8/−7
- ` M` `packages/stage-pages/src/pages/devtools/providers-transcription-realtime-aliyun-nls.vue` — modified; +4/−3
- ` M` `packages/stage-pages/src/pages/devtools/websocket-inspector.vue` — modified; +1/−0
- ` M` `packages/stage-pages/src/pages/settings/account/account-settings-page.vue` — modified; +3/−1
- ` M` `packages/stage-pages/src/pages/settings/airi-card/components/CardCreationDialog.vue` — modified; +1/−1
- ` M` `packages/stage-pages/src/pages/settings/airi-card/components/CardDetailDialog.vue` — modified; +56/−5
- ` M` `packages/stage-pages/src/pages/settings/modules/hearing.vue` — modified; +4/−3
- ` M` `packages/stage-pages/src/pages/settings/modules/memory-long-term.vue` — modified; +147/−2
- ` M` `packages/stage-pages/src/pages/settings/modules/memory-short-term.vue` — modified; +44/−2
- ` M` `packages/stage-pages/src/pages/settings/providers/chat/ollama.vue` — modified; +2/−1
- ` M` `packages/stage-pages/src/pages/settings/providers/speech/mimo-audio-speech.vue` — modified; +7/−7
- ` M` `packages/stage-pages/src/pages/settings/providers/transcription/aliyun-nls-transcription.vue` — modified; +4/−3
- ` M` `packages/stage-pages/src/pages/settings/providers/transcription/browser-web-speech-api.vue` — modified; +2/−1
- ` M` `packages/stage-pages/src/pages/settings/scene/index.vue` — modified; +58/−5
- ` M` `packages/stage-shared/src/composables/index.ts` — modified; +1/−0
- `??` `packages/stage-shared/src/discord-bridge.ts` — untracked; 166 lines, 6.4 KiB
- ` M` `packages/stage-shared/src/window.ts` — modified; +23/−1
- ` M` `packages/stage-ui-live2d/src/utils/live2d-structure-report.ts` — modified; +15/−14
- ` M` `packages/stage-ui-spine/src/components/scenes/spine/Model.vue` — modified; +1/−1
- ` M` `packages/stage-ui-spine/src/utils/spine-preview.ts` — modified; +7/−1
- ` M` `packages/stage-ui/src/components/modules/MessagingDiscord.vue` — modified; +321/−5
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/action-menu/index.vue` — modified; +20/−0
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/action-menu/menu-items.ts` — modified; +19/−2
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/assistant-item.vue` — modified; +68/−4
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/history.vue` — modified; +36/−0
- `??` `packages/stage-ui/src/components/scenarios/chat/components/messageTextEditor.vue` — untracked; 41 lines, 859 B
- `??` `packages/stage-ui/src/components/scenarios/chat/components/sessionPromptControls.vue` — untracked; 125 lines, 5.0 KiB
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/user-item.vue` — modified; +39/−3
- ` M` `packages/stage-ui/src/components/scenarios/chat/index.ts` — modified; +1/−0
- ` M` `packages/stage-ui/src/components/scenarios/dialogs/model-selector/Live2DReportModal.vue` — modified; +3/−3
- ` M` `packages/stage-ui/src/components/scenarios/dialogs/onboarding/onboarding.vue` — modified; +5/−5
- ` M` `packages/stage-ui/src/components/scenarios/providers/speech-playground-openai-compatible.vue` — modified; +2/−1
- ` M` `packages/stage-ui/src/components/scenarios/providers/speech-playground.vue` — modified; +2/−1
- ` M` `packages/stage-ui/src/components/scenarios/providers/transcription-playground.vue` — modified; +3/−2
- ` M` `packages/stage-ui/src/components/scenes/Stage.vue` — modified; +142/−54
- ` M` `packages/stage-ui/src/composables/audio/audio-analyzer.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/composables/use-data-maintenance.ts` — modified; +1/−1
- ` M` `packages/stage-ui/src/composables/use-modules-list.ts` — modified; +4/−2
- ` M` `packages/stage-ui/src/composables/whisper.ts` — modified; +2/−2
- `??` `packages/stage-ui/src/database/repos/chat-memory.repo.ts` — untracked; 315 lines, 8.8 KiB
- `??` `packages/stage-ui/src/database/repos/discord-memory.repo.ts` — untracked; 1,747 lines, 50.8 KiB
- ` M` `packages/stage-ui/src/libs/auth-config.ts` — modified; +7/−4
- ` M` `packages/stage-ui/src/libs/auth.ts` — modified; +29/−18
- ` M` `packages/stage-ui/src/libs/inference/adapters/background-removal.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/libs/inference/adapters/kokoro.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/libs/inference/adapters/whisper.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/libs/inference/protocol.ts` — modified; +4/−2
- ` M` `packages/stage-ui/src/libs/inference/worker-manager.ts` — modified; +1/−3
- ` M` `packages/stage-ui/src/libs/speech/tts-session.ts` — modified; +107/−18
- ` M` `packages/stage-ui/src/libs/workers/worker.ts` — modified; +3/−2
- ` M` `packages/stage-ui/src/stores/ai/models/vad.ts` — modified; +2/−2
- ` M` `packages/stage-ui/src/stores/auth.ts` — modified; +6/−5
- `??` `packages/stage-ui/src/stores/chat-memory.ts` — untracked; 1 lines, 36 B
- ` M` `packages/stage-ui/src/stores/chat.ts` — modified; +253/−21
- ` M` `packages/stage-ui/src/stores/chat/maintenance.ts` — modified; +1/−1
- `??` `packages/stage-ui/src/stores/chat/memory-store.ts` — untracked; 214 lines, 6.7 KiB
- ` M` `packages/stage-ui/src/stores/chat/session-store.ts` — modified; +261/−2
- ` M` `packages/stage-ui/src/stores/configurator.ts` — modified; +41/−0
- ` M` `packages/stage-ui/src/stores/devtools/context-observability.ts` — modified; +4/−0
- ` M` `packages/stage-ui/src/stores/devtools/plugin-host-debug.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/stores/devtools/websocket-inspector.ts` — modified; +18/−6
- ` M` `packages/stage-ui/src/stores/index.ts` — modified; +1/−0
- ` M` `packages/stage-ui/src/stores/mods/api/channel-server.ts` — modified; +412/−60
- ` M` `packages/stage-ui/src/stores/mods/api/context-bridge.ts` — modified; +1079/−63
- ` M` `packages/stage-ui/src/stores/modules/airi-card.ts` — modified; +1/−0
- ` M` `packages/stage-ui/src/stores/modules/artistry-autonomous.ts` — modified; +10/−3
- ` M` `packages/stage-ui/src/stores/modules/artistry.ts` — modified; +4/−4
- ` M` `packages/stage-ui/src/stores/modules/consciousness.ts` — modified; +22/−1
- ` M` `packages/stage-ui/src/stores/modules/discord.ts` — modified; +880/−10
- ` M` `packages/stage-ui/src/stores/modules/twitter.ts` — modified; +6/−6
- ` M` `packages/stage-ui/src/stores/providers.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/stores/providers/web-speech-api/index.ts` — modified; +3/−1
- ` M` `packages/stage-ui/src/types/chat-session.ts` — modified; +24/−0
- ` M` `packages/stage-ui/src/types/chat.ts` — modified; +1/−0
- ` M` `packages/stage-ui/src/workers/background-removal/worker.ts` — modified; +2/−1
- ` M` `packages/stage-ui/src/workers/kokoro/worker.ts` — modified; +3/−2
- ` M` `packages/ui-loading-screens/src/components/LoadingSciFiCircle/index.vue` — modified; +3/−1
- ` M` `plugins/airi-plugin-web-extension/src/background/client.ts` — modified; +6/−2
- ` M` `services/discord-bot/src/adapters/airi-adapter.ts` — modified; +3812/−219
- `??` `services/discord-bot/src/adapters/discordIngressScheduler.ts` — untracked; 118 lines, 4.3 KiB
- ` M` `services/discord-bot/src/bots/discord/commands/index.ts` — modified; +2/−15
- ` M` `services/discord-bot/src/bots/discord/commands/summon.ts` — modified; +4728/−267
- `??` `services/discord-bot/src/bots/discord/commands/voiceDiagnostics.ts` — untracked; 180 lines, 6.5 KiB
- ` M` `services/discord-bot/src/index.ts` — modified; +49/−12
- `??` `services/discord-bot/src/pipelines/classic-voice-audio.ts` — untracked; 87 lines, 3.2 KiB
- `??` `services/discord-bot/src/pipelines/openai-speech.ts` — untracked; 419 lines, 14.8 KiB
- `??` `services/discord-bot/src/standalone/app-controller.ts` — untracked; 954 lines, 38.4 KiB
- `??` `services/discord-bot/src/standalone/app-runtime.ts` — untracked; 123 lines, 3.8 KiB
- `??` `services/discord-bot/src/standalone/capability-diagnostics.ts` — untracked; 505 lines, 20.0 KiB
- `??` `services/discord-bot/src/standalone/character-card.ts` — untracked; 363 lines, 12.1 KiB
- `??` `services/discord-bot/src/standalone/chat-runtime.ts` — untracked; 1,590 lines, 59.5 KiB
- `??` `services/discord-bot/src/standalone/discord-reply-text.ts` — untracked; 45 lines, 1.7 KiB
- `??` `services/discord-bot/src/standalone/qwen-realtime.ts` — untracked; 1,467 lines, 54.8 KiB
- `??` `services/discord-bot/src/standalone/realtime-provider-failure.ts` — untracked; 57 lines, 2.0 KiB
- `??` `services/discord-bot/src/standalone/rules.ts` — untracked; 407 lines, 14.6 KiB
- `??` `services/discord-bot/src/standalone/speech-runtime.ts` — untracked; 197 lines, 6.7 KiB
- `??` `services/discord-bot/src/standalone/voiceDiagnostics.ts` — untracked; 650 lines, 23.5 KiB
- ` M` `services/discord-bot/src/utils/audio.ts` — modified; +589/−1
- ` M` `services/discord-bot/src/utils/opus.ts` — modified; +7/−4

### 2. INTENDED TEST CHANGE (70)

Plausible tests or test fixtures associated with production work. Security-specific tests are instead in category 4.

- `??` `apps/discord-dashboard/src/main/copy-opusscript-runtime.test.mjs` — untracked; 60 lines, 2.6 KiB
- ` M` `apps/server/src/utils/envelope-crypto.test.ts` — modified; +1/−0
- `??` `apps/stage-tamagotchi/scripts/discord-launcher-contract.test.ts` — untracked; 198 lines, 6.4 KiB
- `??` `apps/stage-tamagotchi/src/main/libs/electron/eventa.test.ts` — untracked; 76 lines, 2.5 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/index.test.ts` — untracked; 1,041 lines, 34.5 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/discord-bridge/worker.test.ts` — untracked; 418 lines, 14.2 KiB
- ` M` `apps/stage-tamagotchi/src/main/services/airi/plugins/index.test.ts` — modified; +13/−4
- `??` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-bridge.test.ts` — untracked; 69 lines, 1.9 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistry-payload.test.ts` — untracked; 67 lines, 2.1 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/widgets/artistryImageDownload.test.ts` — untracked; 68 lines, 2.2 KiB
- ` M` `apps/stage-tamagotchi/src/main/windows/desktop-overlay/window-contract.test.ts` — modified; +3/−1
- ` M` `apps/stage-tamagotchi/src/renderer/stores/chat-sync.test.ts` — modified; +92/−5
- ` M` `apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.test.ts` — modified; +61/−1
- `??` `packages/ccc/src/character-book-export.test.ts` — untracked; 50 lines, 1.3 KiB
- `??` `packages/ccc/src/lorebook.test.ts` — untracked; 217 lines, 5.7 KiB
- ` M` `packages/core-agent/src/runtime/chat-orchestrator-runtime.test.ts` — modified; +913/−7
- ` M` `packages/plugin-sdk/src/plugin-host/core.test.ts` — modified; +75/−2
- `??` `packages/plugin-sdk/src/plugin-host/runtimes/shared/services/tools.test.ts` — untracked; 51 lines, 1.6 KiB
- `??` `packages/server-runtime/src/bin/processLifecycle.test.ts` — untracked; 309 lines, 9.9 KiB
- ` M` `packages/server-runtime/src/server-ws/airi/index.test.ts` — modified; +22/−2
- ` M` `packages/server-runtime/src/server-ws/core/index.test.ts` — modified; +97/−0
- `??` `packages/server-runtime/src/server.lifecycle.test.ts` — untracked; 61 lines, 2.2 KiB
- ` M` `packages/server-runtime/src/server.test.ts` — modified; +529/−7
- ` M` `packages/server-sdk/test/client.test.ts` — modified; +654/−11
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/action-menu/index.test.ts` — modified; +8/−4
- ` M` `packages/stage-ui/src/components/scenarios/chat/components/history.browser.test.ts` — modified; +55/−0
- `??` `packages/stage-ui/src/database/repos/chat-memory.repo.test.ts` — untracked; 416 lines, 13.0 KiB
- `??` `packages/stage-ui/src/database/repos/discord-memory.repo.test.ts` — untracked; 1,165 lines, 39.1 KiB
- `??` `packages/stage-ui/src/libs/auth.test.ts` — untracked; 125 lines, 2.9 KiB
- ` M` `packages/stage-ui/src/libs/speech/tts-session.test.ts` — modified; +135/−3
- ` M` `packages/stage-ui/src/stores/chat.contract.test.ts` — modified; +951/−5
- ` M` `packages/stage-ui/src/stores/chat/session-store.test.ts` — modified; +153/−0
- `??` `packages/stage-ui/src/stores/devtools/websocket-inspector.test.ts` — untracked; 250 lines, 9.1 KiB
- ` M` `packages/stage-ui/src/stores/mods/api/channel-server.test.ts` — modified; +775/−6
- ` M` `packages/stage-ui/src/stores/mods/api/context-bridge-performance-call.test.ts` — modified; +25/−0
- ` M` `packages/stage-ui/src/stores/mods/api/context-bridge.contract.browser.test.ts` — modified; +1548/−3
- `??` `packages/stage-ui/src/stores/modules/discord.persistence.browser.test.ts` — untracked; 126 lines, 4.3 KiB
- `??` `packages/stage-ui/src/stores/modules/discord.test.ts` — untracked; 437 lines, 14.3 KiB
- `??` `scripts/verify-ci-command-contract.test.mjs` — untracked; 134 lines, 5.1 KiB
- `??` `services/discord-bot/src/adapters/airi-adapter.lifecycle.test.ts` — untracked; 898 lines, 37.9 KiB
- `??` `services/discord-bot/src/adapters/airi-adapter.test.ts` — untracked; 418 lines, 11.6 KiB
- `??` `services/discord-bot/src/adapters/airi-adapter.turn-correlation.test.ts` — untracked; 2,114 lines, 90.4 KiB
- `??` `services/discord-bot/src/adapters/airi-adapter.voice-boundaries.test.ts` — untracked; 618 lines, 22.0 KiB
- `??` `services/discord-bot/src/adapters/airi-adapter.voice-public.integration.test.ts` — untracked; 1,184 lines, 42.8 KiB
- `??` `services/discord-bot/src/adapters/discordIngressScheduler.test.ts` — untracked; 103 lines, 4.5 KiB
- `??` `services/discord-bot/src/bots/discord/commands/classic-voice-audio.integration.test.ts` — untracked; 217 lines, 7.4 KiB
- `??` `services/discord-bot/src/bots/discord/commands/index.test.ts` — untracked; 47 lines, 2.5 KiB
- `??` `services/discord-bot/src/bots/discord/commands/ping.test.ts` — untracked; 22 lines, 531 B
- `??` `services/discord-bot/src/bots/discord/commands/qwen-realtime-consent-audio.integration.test.ts` — untracked; 923 lines, 42.3 KiB
- `??` `services/discord-bot/src/bots/discord/commands/qwen-realtime-voice-manager.integration.test.ts` — untracked; 367 lines, 15.4 KiB
- `??` `services/discord-bot/src/bots/discord/commands/summon-standalone.test.ts` — untracked; 558 lines, 21.5 KiB
- `??` `services/discord-bot/src/bots/discord/commands/summon.test.ts` — untracked; 8,397 lines, 332.8 KiB
- `??` `services/discord-bot/src/pipelines/openai-speech.test.ts` — untracked; 667 lines, 24.6 KiB
- `??` `services/discord-bot/src/pipelines/tts.test.ts` — untracked; 46 lines, 1.7 KiB
- `??` `services/discord-bot/src/standalone/app-controller.lifecycle.test.ts` — untracked; 953 lines, 31.5 KiB
- `??` `services/discord-bot/src/standalone/app-controller.test.ts` — untracked; 672 lines, 24.9 KiB
- `??` `services/discord-bot/src/standalone/app-runtime.test.ts` — untracked; 156 lines, 5.2 KiB
- `??` `services/discord-bot/src/standalone/capability-diagnostics.production.test.ts` — untracked; 493 lines, 25.1 KiB
- `??` `services/discord-bot/src/standalone/capability-diagnostics.test.ts` — untracked; 476 lines, 39.0 KiB
- `??` `services/discord-bot/src/standalone/character-card.test.ts` — untracked; 115 lines, 3.2 KiB
- `??` `services/discord-bot/src/standalone/chat-runtime.test.ts` — untracked; 2,615 lines, 89.2 KiB
- `??` `services/discord-bot/src/standalone/dashboard-window-readiness.test.ts` — untracked; 295 lines, 10.1 KiB
- `??` `services/discord-bot/src/standalone/discord-reply-text.test.ts` — untracked; 55 lines, 2.2 KiB
- `??` `services/discord-bot/src/standalone/qwen-realtime.test.ts` — untracked; 2,816 lines, 125.0 KiB
- `??` `services/discord-bot/src/standalone/readmeConsent.test.ts` — untracked; 42 lines, 2.1 KiB
- `??` `services/discord-bot/src/standalone/speech-runtime.test.ts` — untracked; 399 lines, 15.1 KiB
- `??` `services/discord-bot/src/standalone/voiceDiagnostics.test.ts` — untracked; 470 lines, 19.5 KiB
- `??` `services/discord-bot/src/test/discordVoiceHarness.ts` — untracked; 150 lines, 5.7 KiB
- `??` `services/discord-bot/src/test/pcmFixtures.ts` — untracked; 315 lines, 9.3 KiB
- `??` `services/discord-bot/src/utils/audio.test.ts` — untracked; 488 lines, 21.4 KiB

### 3. INTENDED DOCUMENTATION OR CONFIGURATION (54)

Plausible project documentation, manifests, CI, or tool configuration. Mixed root dependency/config files called out below remain human-review risks.

- ` M` `.github/workflows/ci.yml` — modified; +25/−0
- ` M` `apps/component-calling/package.json` — modified; +2/−2
- `??` `apps/discord-dashboard/electron-builder.config.ts` — untracked; 47 lines, 1.3 KiB
- `??` `apps/discord-dashboard/electron.vite.config.ts` — untracked; 19 lines, 769 B
- `??` `apps/discord-dashboard/package.json` — untracked; 26 lines, 1.4 KiB
- `??` `apps/discord-dashboard/README.md` — untracked; 41 lines, 1.8 KiB
- `??` `apps/discord-dashboard/tsconfig.json` — untracked; 18 lines, 280 B
- `??` `apps/discord-dashboard/vitest.config.ts` — untracked; 7 lines, 150 B
- ` M` `apps/server/docs/ai-context/admin-flux-grants.md` — modified; +3/−3
- ` M` `apps/server/docs/ai-context/verifications/streaming-tts.md` — modified; +1/−1
- ` M` `apps/stage-pocket/package.json` — modified; +5/−5
- ` M` `apps/stage-tamagotchi/electron.vite.config.ts` — modified; +63/−18
- ` M` `apps/stage-tamagotchi/package.json` — modified; +5/−4
- ` M` `apps/stage-web/package.json` — modified; +5/−5
- ` M` `apps/ui-server-auth/package.json` — modified; +3/−3
- ` M` `docs/ai/context/verification-automation.md` — modified; +1/−1
- ` M` `docs/content/en/docs/contributing/services/discord.md` — modified; +17/−1
- ` M` `docs/content/ja/docs/contributing/services/discord.md` — modified; +17/−1
- ` M` `docs/content/zh-Hans/docs/contributing/services/discord.md` — modified; +17/−1
- ` M` `docs/package.json` — modified; +3/−3
- ` M` `packages/audio/package.json` — modified; +1/−1
- ` M` `packages/cap-vite/package.json` — modified; +2/−2
- ` M` `packages/ccc/package.json` — modified; +1/−0
- `??` `packages/ccc/vitest.config.ts` — untracked; 8 lines, 157 B
- ` M` `packages/core-agent/package.json` — modified; +1/−1
- ` M` `packages/electron-eventa/package.json` — modified; +1/−1
- ` M` `packages/electron-screen-capture/package.json` — modified; +3/−3
- ` M` `packages/electron-vueuse/package.json` — modified; +2/−2
- ` M` `packages/i18n/src/locales/en/settings.yaml` — modified; +72/−0
- ` M` `packages/i18n/src/locales/ja/settings.yaml` — modified; +2/−1
- ` M` `packages/i18n/src/locales/zh-Hans/settings.yaml` — modified; +72/−0
- ` M` `packages/plugin-sdk/package.json` — modified; +1/−1
- ` M` `packages/scenarios-stage-tamagotchi-browser/package.json` — modified; +1/−1
- ` M` `packages/stage-layouts/package.json` — modified; +3/−3
- ` M` `packages/stage-pages/package.json` — modified; +3/−3
- ` M` `packages/stage-shared/package.json` — modified; +1/−0
- ` M` `packages/stage-ui-live2d/package.json` — modified; +1/−1
- ` M` `packages/stage-ui-spine/package.json` — modified; +1/−1
- ` M` `packages/stage-ui-three/package.json` — modified; +1/−1
- ` M` `packages/stage-ui/package.json` — modified; +4/−4
- ` M` `packages/ui-loading-screens/package.json` — modified; +1/−1
- ` M` `packages/ui-transitions/package.json` — modified; +1/−1
- ` M` `packages/ui/package.json` — modified; +3/−3
- ` M` `packages/unocss-preset-fonts/package.json` — modified; +1/−1
- ` M` `packages/vishot-runtime/package.json` — modified; +1/−1
- ` M` `plugins/airi-plugin-game-chess/package.json` — modified; +4/−9
- ` M` `plugins/airi-plugin-web-extension/package.json` — modified; +1/−1
- `??` `scripts/verify-ci-command-contract.mjs` — untracked; 135 lines, 4.9 KiB
- `??` `scripts/vitest.ci-command-contract.config.mts` — untracked; 9 lines, 202 B
- ` M` `services/discord-bot/package.json` — modified; +14/−1
- `??` `services/discord-bot/vitest.config.ts` — untracked; 8 lines, 154 B
- ` M` `services/satori-bot/package.json` — modified; +3/−3
- ` M` `services/telegram-bot/package.json` — modified; +3/−3
- ` M` `vitest.config.ts` — modified; +2/−0

### 4. PREVIOUS SECURITY-TASK OUTPUT (72)

High-confidence prior security-task material based on explicit security names, the untracked security report, or direct correspondence with findings documented in that report. This does not attribute the whole Discord feature cluster to that task.

- ` M` `.github/workflows/release-tamagotchi.yml` — modified; +94/−55
- ` M` `.gitignore` — modified; +4/−0
- `??` `apps/discord-dashboard/src/main/application-menu.test.ts` — untracked; 34 lines, 1.0 KiB
- `??` `apps/discord-dashboard/src/main/application-menu.ts` — untracked; 45 lines, 1.1 KiB
- `??` `apps/discord-dashboard/src/main/index.logging-security.test.mjs` — untracked; 144 lines, 7.1 KiB
- `??` `apps/discord-dashboard/src/main/index.ts` — untracked; 241 lines, 6.8 KiB
- ` M` `apps/stage-tamagotchi/build/entitlements.mac.plist` — modified; +0/−2
- ` M` `apps/stage-tamagotchi/electron-builder.config.ts` — modified; +50/−9
- `??` `apps/stage-tamagotchi/scripts/packaging-security.test.ts` — untracked; 98 lines, 3.8 KiB
- `??` `apps/stage-tamagotchi/src/main/app/console-write-guard.test.ts` — untracked; 82 lines, 2.1 KiB
- `??` `apps/stage-tamagotchi/src/main/app/console-write-guard.ts` — untracked; 57 lines, 2.2 KiB
- ` M` `apps/stage-tamagotchi/src/main/app/file-logger.ts` — modified; +2/−1
- ` M` `apps/stage-tamagotchi/src/main/services/airi/http-server/static-assets/route.test.ts` — modified; +45/−0
- ` M` `apps/stage-tamagotchi/src/main/services/airi/http-server/static-assets/route.ts` — modified; +16/−0
- `??` `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/index.ts` — untracked; 249 lines, 8.3 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/policy.test.ts` — untracked; 182 lines, 6.0 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/policy.ts` — untracked; 178 lines, 6.2 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/window-policy.test.ts` — untracked; 53 lines, 2.2 KiB
- `??` `apps/stage-tamagotchi/src/main/services/airi/plugins/sandbox/window-policy.ts` — untracked; 52 lines, 1.8 KiB
- `??` `apps/stage-tamagotchi/src/main/services/electron/protected-storage.test.ts` — untracked; 172 lines, 6.4 KiB
- `??` `apps/stage-tamagotchi/src/main/services/electron/protected-storage.ts` — untracked; 319 lines, 10.6 KiB
- `??` `apps/stage-tamagotchi/src/main/services/electron/secure-storage.test.ts` — untracked; 108 lines, 4.0 KiB
- `??` `apps/stage-tamagotchi/src/main/services/electron/secure-storage.ts` — untracked; 152 lines, 5.2 KiB
- `??` `apps/stage-tamagotchi/src/main/windows/shared/security.test.ts` — untracked; 101 lines, 3.7 KiB
- `??` `apps/stage-tamagotchi/src/main/windows/shared/security.ts` — untracked; 152 lines, 4.4 KiB
- `??` `apps/stage-tamagotchi/src/preload/pluginSandbox.cjs` — untracked; 66 lines, 2.3 KiB
- `??` `apps/stage-tamagotchi/src/renderer/plugin-sandbox.html` — untracked; 14 lines, 533 B
- `??` `apps/stage-tamagotchi/src/renderer/plugin-sandbox.main.ts` — untracked; 77 lines, 2.6 KiB
- `??` `apps/stage-tamagotchi/src/shared/eventa/plugin/sandbox.ts` — untracked; 11 lines, 655 B
- `??` `apps/stage-tamagotchi/src/shared/plugin/sandbox-bridge.ts` — untracked; 30 lines, 1.3 KiB
- `??` `packages/server-runtime/src/gateway-security.test.ts` — untracked; 669 lines, 21.0 KiB
- `??` `packages/server-runtime/src/logging-security.test.ts` — untracked; 526 lines, 18.8 KiB
- `??` `packages/stage-shared/src/composables/use-sensitive-storage/index.test.ts` — untracked; 100 lines, 3.1 KiB
- `??` `packages/stage-shared/src/composables/use-sensitive-storage/index.ts` — untracked; 209 lines, 6.1 KiB
- `??` `packages/stage-ui/src/libs/chat-safety-policy.test.ts` — untracked; 78 lines, 2.9 KiB
- `??` `packages/stage-ui/src/libs/chat-safety-policy.ts` — untracked; 428 lines, 17.6 KiB
- `??` `security_best_practices_report.md` — untracked; 219 lines, 21.3 KiB
- ` M` `services/discord-bot/README.md` — modified; +113/−1
- `??` `services/discord-bot/src/adapters/airi-adapter.logging-security.test.ts` — untracked; 567 lines, 20.1 KiB
- `??` `services/discord-bot/src/adapters/discordMention.test.ts` — untracked; 18 lines, 608 B
- `??` `services/discord-bot/src/adapters/discordMention.ts` — untracked; 18 lines, 409 B
- `??` `services/discord-bot/src/adapters/discordSend.test.ts` — untracked; 354 lines, 15.2 KiB
- `??` `services/discord-bot/src/adapters/discordSend.ts` — untracked; 490 lines, 16.6 KiB
- `??` `services/discord-bot/src/adapters/standalone-adapter.authorization.test.ts` — untracked; 114 lines, 3.8 KiB
- `??` `services/discord-bot/src/adapters/standalone-adapter.test.ts` — untracked; 2,988 lines, 109.1 KiB
- `??` `services/discord-bot/src/adapters/standalone-adapter.ts` — untracked; 1,867 lines, 69.8 KiB
- `??` `services/discord-bot/src/bots/discord/commands/authorization.test.ts` — untracked; 72 lines, 2.2 KiB
- `??` `services/discord-bot/src/bots/discord/commands/authorization.ts` — untracked; 99 lines, 3.2 KiB
- `??` `services/discord-bot/src/bots/discord/commands/registration.ts` — untracked; 171 lines, 6.0 KiB
- ` M` `services/discord-bot/src/pipelines/tts.ts` — modified; +27/−20
- `??` `services/discord-bot/src/standalone/dashboard-server.test.ts` — untracked; 513 lines, 22.7 KiB
- `??` `services/discord-bot/src/standalone/dashboard-state-store.test.ts` — untracked; 116 lines, 3.8 KiB
- `??` `services/discord-bot/src/standalone/dashboard-state-store.ts` — untracked; 124 lines, 3.9 KiB
- `??` `services/discord-bot/src/standalone/dashboard-state.test.ts` — untracked; 553 lines, 19.3 KiB
- `??` `services/discord-bot/src/standalone/dashboard-state.ts` — untracked; 447 lines, 16.9 KiB
- `??` `services/discord-bot/src/standalone/dashboard-ui.lifecycle.test.ts` — untracked; 1,862 lines, 77.0 KiB
- `??` `services/discord-bot/src/standalone/dashboard-ui.test.ts` — untracked; 388 lines, 15.0 KiB
- `??` `services/discord-bot/src/standalone/dashboard-ui.ts` — untracked; 4,331 lines, 180.8 KiB
- `??` `services/discord-bot/src/standalone/dashboard.ts` — untracked; 587 lines, 21.3 KiB
- `??` `services/discord-bot/src/standalone/env-file.test.ts` — untracked; 140 lines, 4.6 KiB
- `??` `services/discord-bot/src/standalone/env-file.ts` — untracked; 251 lines, 6.2 KiB
- `??` `services/discord-bot/src/standalone/filter.test.ts` — untracked; 462 lines, 14.7 KiB
- `??` `services/discord-bot/src/standalone/filter.ts` — untracked; 464 lines, 17.5 KiB
- `??` `services/discord-bot/src/standalone/memory-extractor.test.ts` — untracked; 365 lines, 12.8 KiB
- `??` `services/discord-bot/src/standalone/memory-extractor.ts` — untracked; 402 lines, 13.4 KiB
- `??` `services/discord-bot/src/standalone/memory-store.test.ts` — untracked; 2,146 lines, 80.3 KiB
- `??` `services/discord-bot/src/standalone/memory-store.ts` — untracked; 1,257 lines, 45.9 KiB
- `??` `services/discord-bot/src/standalone/rotating-file-log.test.ts` — untracked; 214 lines, 9.6 KiB
- `??` `services/discord-bot/src/standalone/rotating-file-log.ts` — untracked; 183 lines, 6.0 KiB
- `??` `services/discord-bot/src/standalone/safety-policy.ts` — untracked; 600 lines, 27.0 KiB
- `??` `services/discord-bot/src/utils/audio-monitor.test.ts` — untracked; 57 lines, 1.8 KiB
- ` M` `services/discord-bot/src/utils/audio-monitor.ts` — modified; +41/−19

### 5. GENERATED BUILD OUTPUT (1)

Generated or packaged output that should not be committed.

- `??` `scripts/airi-discord-dashboard-window/AIRI Discord v0.1.7.app` — untracked symbolic link to ignored packaged output

### 6. DEPENDENCY OR VENDOR CONTENT (0)

Vendored dependency trees or copied third-party source. None appear in the changed/untracked set.

- None.

### 7. CACHE, LOG, TEMPORARY, OR RUNTIME DATA (1)

Local runtime state that should stay on disk only if still needed.

- `??` `services/discord-bot/.airi-discord-dashboard-state.json` — untracked; 9 lines, 147 B

### 8. LOCAL DEVELOPMENT CONFIGURATION (11)

Repository-local agent/launcher tooling whose team-sharing intent is unclear.

- `??` `.agents/skills/airi-chat-experience/agents/openai.yaml` — untracked; 4 lines, 233 B
- `??` `.agents/skills/airi-chat-experience/references/airi-chat-architecture.md` — untracked; 65 lines, 4.1 KiB
- `??` `.agents/skills/airi-chat-experience/references/chat-feature-invariants.md` — untracked; 64 lines, 3.6 KiB
- `??` `.agents/skills/airi-chat-experience/references/clean-room-research.md` — untracked; 47 lines, 2.0 KiB
- `??` `.agents/skills/airi-chat-experience/SKILL.md` — untracked; 67 lines, 5.5 KiB
- `??` `scripts/airi-discord-dashboard-window/main.cjs` — untracked; 526 lines, 12.2 KiB
- `??` `scripts/airi-discord-dashboard-window/readiness.cjs` — untracked; 169 lines, 4.9 KiB
- `??` `scripts/airi-discord-dashboard-window/readiness.d.cts` — untracked; 83 lines, 2.9 KiB
- `??` `scripts/airi-discord-dashboard-window/README.md` — untracked; 15 lines, 786 B
- `??` `scripts/airi-discord-launcher-app/README.md` — untracked; 47 lines, 2.1 KiB
- `??` `scripts/dev-airi-discord.command` — untracked; 27 lines, 859 B

### 9. POSSIBLE SECRET OR CREDENTIAL FILE (1)

Credential-capable file. No value is reproduced here.

- ` M` `services/discord-bot/.env` — modified; +37/−0

### 10. UNKNOWN — REQUIRES HUMAN REVIEW (63)

Mixed-scope, deletion, or apparently unrelated paths for which intent cannot be established safely.

- ` M` `AGENTS.md` — modified; +1/−1
- ` D` `apps/stage-tamagotchi/src/preload/beat-sync.ts` — deleted; +0/−3
- ` D` `apps/stage-tamagotchi/src/preload/index.ts` — deleted; +0/−3
- ` D` `apps/stage-tamagotchi/src/preload/shared.ts` — deleted; +0/−49
- `??` `design-qa.md` — untracked; 49 lines, 3.5 KiB
- ` M` `package.json` — modified; +4/−2
- ` D` `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/macos-26/texts/index.ts` — deleted; +0/−0
- ` D` `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/windows-11/index.ts` — deleted; +0/−0
- ` M` `pnpm-lock.yaml` — modified; +158/−382
- ` M` `pnpm-workspace.yaml` — modified; +2/−39
- ` M` `services/computer-use-mcp/chrome-extension/msg_bridge.js` — modified; +2/−0
- ` M` `services/computer-use-mcp/src/bin/demo-hello-world.ts` — modified; +6/−5
- ` M` `services/computer-use-mcp/src/bin/e2e-airi-chat-observable.ts` — modified; +2/−1
- ` M` `services/computer-use-mcp/src/bin/e2e-airi-chat-terminal-self-acquire.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/bin/e2e-airi-discord-agentic.ts` — modified; +2/−1
- ` M` `services/computer-use-mcp/src/bin/e2e-airi-discord-observable.ts` — modified; +2/−1
- ` M` `services/computer-use-mcp/src/bin/runner.ts` — modified; +5/−3
- ` M` `services/computer-use-mcp/src/browser-dom/cdp-bridge.ts` — modified; +3/−2
- ` M` `services/computer-use-mcp/src/desktop-grounding-capture.test.ts` — modified; +62/−0
- ` M` `services/computer-use-mcp/src/desktop-grounding-types.ts` — modified; +1/−1
- ` M` `services/computer-use-mcp/src/desktop-grounding.test.ts` — modified; +15/−6
- ` M` `services/computer-use-mcp/src/desktop-grounding.ts` — modified; +9/−23
- ` M` `services/computer-use-mcp/src/executors/linux-x11.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/executors/macos-local.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/runner/client.ts` — modified; +4/−2
- ` M` `services/computer-use-mcp/src/runner/service.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/runtime-probes.ts` — modified; +6/−4
- ` M` `services/computer-use-mcp/src/server/action-executor.ts` — modified; +4/−2
- ` M` `services/computer-use-mcp/src/server/cdp-manager.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/server/register-accessibility.ts` — modified; +5/−4
- ` M` `services/computer-use-mcp/src/server/register-cdp.ts` — modified; +13/−12
- ` M` `services/computer-use-mcp/src/server/register-chrome-session.test.ts` — modified; +2/−0
- ` M` `services/computer-use-mcp/src/server/register-chrome-session.ts` — modified; +1/−1
- ` M` `services/computer-use-mcp/src/server/register-desktop-grounding.test.ts` — modified; +3/−2
- ` M` `services/computer-use-mcp/src/server/register-desktop-grounding.ts` — modified; +2/−1
- ` M` `services/computer-use-mcp/src/server/register-display.ts` — modified; +5/−4
- ` M` `services/computer-use-mcp/src/server/register-pty.ts` — modified; +8/−7
- ` M` `services/computer-use-mcp/src/server/register-tools-pty-approval.test.ts` — modified; +1/−0
- ` M` `services/computer-use-mcp/src/server/tool-descriptors/desktop.ts` — modified; +1/−1
- ` M` `services/computer-use-mcp/src/server/workflow-prep-tools.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/snap-resolver.ts` — modified; +2/−0
- ` M` `services/computer-use-mcp/src/terminal/pty-runner.ts` — modified; +1/−1
- ` M` `services/computer-use-mcp/src/terminal/runner.test.ts` — modified; +9/−1
- ` M` `services/computer-use-mcp/src/types.ts` — modified; +2/−0
- ` M` `services/computer-use-mcp/src/utils/screenshot.ts` — modified; +3/−1
- ` M` `services/computer-use-mcp/src/workflows/engine.ts` — modified; +7/−5
- ` M` `services/minecraft/package.json` — modified; +2/−2
- ` M` `services/minecraft/src/cognitive/conscious/brain.test.ts` — modified; +8/−0
- ` M` `services/minecraft/src/cognitive/conscious/brain.ts` — modified; +0/−2
- ` M` `services/minecraft/src/cognitive/conscious/map-renderer.test.ts` — modified; +1/−0
- ` M` `services/minecraft/src/cognitive/conscious/map-renderer.ts` — modified; +12/−3
- ` M` `services/minecraft/src/cognitive/perception/rules/rules.test.ts` — modified; +8/−25
- ` M` `services/minecraft/src/debug/server.ts` — modified; +2/−1
- ` M` `services/minecraft/src/debug/tool-executor.ts` — modified; +3/−1
- `??` `services/minecraft/src/utils/mcdata.test.ts` — untracked; 25 lines, 835 B
- ` M` `services/minecraft/src/utils/mcdata.ts` — modified; +11/−1
- ` M` `services/twitter-services/package.json` — modified; +4/−0
- ` M` `services/twitter-services/src/adapters/airi-adapter.ts` — modified; +2/−1
- ` M` `services/twitter-services/src/core/services/tweet.ts` — modified; +10/−8
- ` M` `services/twitter-services/src/parsers/command-parser.test.ts` — modified; +7/−1
- ` M` `services/twitter-services/src/parsers/profile-parser.ts` — modified; +1/−51
- ` M` `services/twitter-services/src/parsers/tweet-parser.ts` — modified; +2/−3
- `??` `services/twitter-services/vitest.config.ts` — untracked; 8 lines, 154 B

### Report output (excluded from snapshot counts)

- `??` `PRE_SECURITY_BASELINE.md` — category 3, untracked documentation generated by this inventory.
