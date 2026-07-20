# Safe Baseline Review

Review date: 2026-07-20 (Europe/Berlin)

Scope: classification and baseline hygiene only. No security scan, remediation, staging, commit, push, reset, restore, or application/test source edit was performed.

## 1. Sensitive paths

No secret value is reproduced in this report. Git status is the status observed before permitted cleanup.

| Path | Git status | Secret category | Classification | Recommended action | User action required |
| --- | --- | --- | --- | --- | --- |
| `services/discord-bot/.env` | Tracked, modified (` M`); not ignored | Credential-capable environment template | PLACEHOLDER | Keep only placeholder defaults. Continue putting real local credentials in the already-ignored `.env.local`; consider a later, explicit `.env.example` migration if the project wants a conventional template name. Committed revisions checked also contained placeholders only. | No for the current content; yes only for a future template migration policy |
| `services/discord-bot/.airi-discord-dashboard-state.json` | Untracked (`??`); not ignored at inspection | Local runtime operational state | FALSE POSITIVE | Ignore narrowly and remove the reproducible local counter/version state. | No |
| `security_best_practices_report.md` | Untracked (`??`); not ignored | Security-review metadata | FALSE POSITIVE | Preserve as prior security-work documentation; decide its commit group separately from production code. | No sensitive-data action; commit placement remains a review choice |
| `apps/server/scripts/e2e-llm-router.ts` | Tracked, modified (` M`); not ignored | OpenAI-key-shaped example in a comment | PLACEHOLDER | Keep as source documentation/example; the short static example predates the working-tree change and is not a live credential. | No |
| `apps/server/src/utils/envelope-crypto.test.ts` | Tracked, modified (` M`); not ignored | OpenAI-key-shaped plaintext fixtures | PLACEHOLDER | Keep as deterministic crypto-test fixtures. | No |
| `packages/stage-ui/src/database/repos/chat-memory.repo.test.ts` | Untracked (`??`); not ignored | OpenAI-key-shaped chat-content fixture | PLACEHOLDER | Keep with the chat-memory tests. | No |
| `packages/stage-ui/src/libs/chat-safety-policy.test.ts` | Untracked (`??`); not ignored | OpenAI-key-shaped safety-policy fixture | PLACEHOLDER | Keep with the chat-safety-policy tests. | No |

The credential signature review found zero REAL and zero UNCERTAIN items. No rotation or Git-history cleanup is indicated by the inspected `.env` revisions.

## 2. Previously unknown paths

All 63 paths are resolved below. “Keep” means preserve the existing working-tree change for a scoped review; it does not authorize staging the whole repository.

| Path | Classification | Reason | Recommended action |
| --- | --- | --- | --- |
| `AGENTS.md` | KEEP_DOCUMENTATION | Tracked AIRI contributor policy; the change corrects the repository command name. | Keep in a governance/documentation commit. |
| `apps/stage-tamagotchi/src/preload/beat-sync.ts` | KEEP_SOURCE | Tracked Electron preload source superseded by the shared sandbox-compatible CJS preload path. | Preserve the deletion only with `renderer.cjs`, `windows/shared/preload.ts`, window wiring, and focused validation. |
| `apps/stage-tamagotchi/src/preload/index.ts` | KEEP_SOURCE | Tracked Electron preload source superseded by the shared sandbox-compatible CJS preload path. | Preserve the deletion only with the complete preload refactor and focused validation. |
| `apps/stage-tamagotchi/src/preload/shared.ts` | KEEP_SOURCE | Tracked preload implementation whose behavior is replaced by `renderer.cjs`; the replacement explicitly cites it as source context. | Preserve the deletion only with the complete preload refactor and focused validation. |
| `design-qa.md` | KEEP_DOCUMENTATION | AIRI Discord provider UI QA evidence; project-specific but not part of the security review. | Preserve; before committing, replace or contextualize machine-local `/private/tmp` evidence paths. |
| `package.json` | KEEP_CONFIG | Root scripts add Discord workflows and change lint orchestration. | Keep, but split Discord-script and lint-command hunks by intent. |
| `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/macos-26/texts/index.ts` | DELETE_CANDIDATE | Tracked, empty, deleted index with no repository reference found. | Accept the deletion in a platform cleanup commit after scoped build/typecheck confirmation. |
| `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/windows-11/index.ts` | DELETE_CANDIDATE | Tracked, empty, deleted index with no repository reference found. | Accept the deletion in a platform cleanup commit after scoped build/typecheck confirmation. |
| `pnpm-lock.yaml` | KEEP_CONFIG | Tracked reproducible dependency lockfile; contains broad dependency resolution changes. | Recreate/review from approved manifest and workspace changes, then commit with those inputs. |
| `pnpm-workspace.yaml` | KEEP_CONFIG | Tracked workspace catalog/override configuration with an `undici` override plus catalog restructuring. | Split or explicitly approve the security override and unrelated catalog changes before committing. |
| `services/computer-use-mcp/chrome-extension/msg_bridge.js` | KEEP_SOURCE | Tracked extension source; adds the browser-global declaration used by linting. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/demo-hello-world.ts` | KEEP_SOURCE | Tracked CLI/demo entrypoint; adopts the repository error extraction boundary. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/e2e-airi-chat-observable.ts` | KEEP_SOURCE | Tracked AIRI E2E runner source; uses the shared error extraction boundary. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/e2e-airi-chat-terminal-self-acquire.ts` | KEEP_SOURCE | Tracked AIRI E2E runner source; uses the shared error extraction boundary. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/e2e-airi-discord-agentic.ts` | KEEP_SOURCE | Tracked Discord E2E runner source; uses the shared error extraction boundary. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/e2e-airi-discord-observable.ts` | KEEP_SOURCE | Tracked Discord E2E runner source; uses the shared error extraction boundary. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/bin/runner.ts` | KEEP_SOURCE | Tracked process runner source; normalizes error extraction. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/browser-dom/cdp-bridge.ts` | KEEP_SOURCE | Tracked CDP bridge source; normalizes connection error extraction. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/desktop-grounding-capture.test.ts` | KEEP_TEST | Tracked regression tests for Chrome window matching. | Keep with `desktop-grounding.ts`. |
| `services/computer-use-mcp/src/desktop-grounding-types.ts` | KEEP_SOURCE | Tracked grounding contract used by computer-use capture code. | Keep with the grounding implementation. |
| `services/computer-use-mcp/src/desktop-grounding.test.ts` | KEEP_TEST | Tracked grounding regression tests covering capture/deduplication behavior. | Keep with `desktop-grounding.ts`. |
| `services/computer-use-mcp/src/desktop-grounding.ts` | KEEP_SOURCE | Tracked grounding implementation; removes obsolete foreground-only Chrome lookup and fixes matching. | Keep with its regression tests. |
| `services/computer-use-mcp/src/executors/linux-x11.ts` | KEEP_SOURCE | Tracked Linux executor source; shared error extraction maintenance. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/executors/macos-local.ts` | KEEP_SOURCE | Tracked macOS executor source; shared error extraction maintenance. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/runner/client.ts` | KEEP_SOURCE | Tracked runner client source. | Keep with runner service and protocol changes. |
| `services/computer-use-mcp/src/runner/service.ts` | KEEP_SOURCE | Tracked runner service source. | Keep with runner client and protocol changes. |
| `services/computer-use-mcp/src/runtime-probes.ts` | KEEP_SOURCE | Tracked runtime capability probe source. | Keep with the computer-use maintenance group. |
| `services/computer-use-mcp/src/server/action-executor.ts` | KEEP_SOURCE | Tracked MCP action execution source. | Keep with server registration changes. |
| `services/computer-use-mcp/src/server/cdp-manager.ts` | KEEP_SOURCE | Tracked CDP lifecycle source. | Keep with server registration changes. |
| `services/computer-use-mcp/src/server/register-accessibility.ts` | KEEP_SOURCE | Tracked MCP tool registration source. | Keep with the computer-use server group. |
| `services/computer-use-mcp/src/server/register-cdp.ts` | KEEP_SOURCE | Tracked MCP tool registration source. | Keep with the computer-use server group. |
| `services/computer-use-mcp/src/server/register-chrome-session.test.ts` | KEEP_TEST | Tracked registration regression test. | Keep with `register-chrome-session.ts`. |
| `services/computer-use-mcp/src/server/register-chrome-session.ts` | KEEP_SOURCE | Tracked Chrome-session registration source. | Keep with its test. |
| `services/computer-use-mcp/src/server/register-desktop-grounding.test.ts` | KEEP_TEST | Tracked grounding registration tests. | Keep with `register-desktop-grounding.ts`. |
| `services/computer-use-mcp/src/server/register-desktop-grounding.ts` | KEEP_SOURCE | Tracked grounding tool registration source. | Keep with its test and grounding implementation. |
| `services/computer-use-mcp/src/server/register-display.ts` | KEEP_SOURCE | Tracked display tool registration source. | Keep with the computer-use server group. |
| `services/computer-use-mcp/src/server/register-pty.ts` | KEEP_SOURCE | Tracked PTY tool registration source. | Keep with PTY runner changes. |
| `services/computer-use-mcp/src/server/register-tools-pty-approval.test.ts` | KEEP_TEST | Tracked PTY approval regression test. | Keep with PTY registration changes. |
| `services/computer-use-mcp/src/server/tool-descriptors/desktop.ts` | KEEP_SOURCE | Tracked MCP desktop tool descriptor. | Keep with desktop registration changes. |
| `services/computer-use-mcp/src/server/workflow-prep-tools.ts` | KEEP_SOURCE | Tracked workflow tool registration source. | Keep with workflow engine changes. |
| `services/computer-use-mcp/src/snap-resolver.ts` | KEEP_SOURCE | Tracked grounding/snap resolution source. | Keep with grounding changes. |
| `services/computer-use-mcp/src/terminal/pty-runner.ts` | KEEP_SOURCE | Tracked PTY execution source. | Keep with PTY registration and tests. |
| `services/computer-use-mcp/src/terminal/runner.test.ts` | KEEP_TEST | Tracked terminal runner regression tests. | Keep with PTY runner changes. |
| `services/computer-use-mcp/src/types.ts` | KEEP_SOURCE | Tracked shared computer-use contracts. | Keep with the source changes that consume the contract. |
| `services/computer-use-mcp/src/utils/screenshot.ts` | KEEP_SOURCE | Tracked screenshot utility source. | Keep with grounding/capture changes. |
| `services/computer-use-mcp/src/workflows/engine.ts` | KEEP_SOURCE | Tracked workflow engine source. | Keep with workflow tool changes. |
| `services/minecraft/package.json` | KEEP_CONFIG | Tracked service manifest; dependency catalog references are being normalized. | Keep with the approved workspace/dependency change, not the gameplay fixes. |
| `services/minecraft/src/cognitive/conscious/brain.test.ts` | KEEP_TEST | Tracked regression test for provider timeout ownership. | Keep with `brain.ts`. |
| `services/minecraft/src/cognitive/conscious/brain.ts` | KEEP_SOURCE | Tracked cognitive runtime source; removes the fixed delegated LLM timeout. | Keep with its regression test. |
| `services/minecraft/src/cognitive/conscious/map-renderer.test.ts` | KEEP_TEST | Tracked regression test for independent map rows/entity rendering. | Keep with `map-renderer.ts`. |
| `services/minecraft/src/cognitive/conscious/map-renderer.ts` | KEEP_SOURCE | Tracked map renderer source; fixes aliased row storage. | Keep with its regression test. |
| `services/minecraft/src/cognitive/perception/rules/rules.test.ts` | KEEP_TEST | Tracked tests aligned with the current no-noise detector observability boundary. | Keep with the related rules behavior change. |
| `services/minecraft/src/debug/server.ts` | KEEP_SOURCE | Tracked debug server source; shared error extraction maintenance. | Keep in a Minecraft maintenance group. |
| `services/minecraft/src/debug/tool-executor.ts` | KEEP_SOURCE | Tracked debug tool executor source; shared error extraction maintenance. | Keep in a Minecraft maintenance group. |
| `services/minecraft/src/utils/mcdata.test.ts` | KEEP_TEST | Untracked focused regression test for Minecraft data/name matching. | Keep with `mcdata.ts`. |
| `services/minecraft/src/utils/mcdata.ts` | KEEP_SOURCE | Tracked utility source; fixes aliased dynamic-programming rows. | Keep with its regression test. |
| `services/twitter-services/package.json` | KEEP_CONFIG | Tracked service manifest; adds the Vitest test command/dependency. | Keep with the Twitter test configuration. |
| `services/twitter-services/src/adapters/airi-adapter.ts` | KEEP_SOURCE | Tracked AIRI adapter source; shared error extraction maintenance. | Keep in the Twitter service group. |
| `services/twitter-services/src/core/services/tweet.ts` | KEEP_SOURCE | Tracked tweet-service source; updates parser API usage and error extraction. | Keep with the parser changes. |
| `services/twitter-services/src/parsers/command-parser.test.ts` | KEEP_TEST | Tracked Twitter command parser regression tests. | Keep with parser source changes. |
| `services/twitter-services/src/parsers/profile-parser.ts` | KEEP_SOURCE | Tracked Twitter parser source; removes obsolete parser input handling. | Keep with parser tests and call-site updates. |
| `services/twitter-services/src/parsers/tweet-parser.ts` | KEEP_SOURCE | Tracked Twitter parser source; owns the revised extraction contract. | Keep with tweet-service call-site updates. |
| `services/twitter-services/vitest.config.ts` | KEEP_CONFIG | Untracked service-local Vitest configuration referenced by the new test command. | Keep with the Twitter manifest and tests. |

## 3. Local-tooling paths

The five skill files have no Git history because they are new, but they form one complete repository-local AIRI skill. The launcher files are also new; repository docs, tests, and source references establish that they belong to AIRI development. None is generated.

| Path | Purpose | Keep or ignore recommendation |
| --- | --- | --- |
| `.agents/skills/airi-chat-experience/agents/openai.yaml` | Codex/OpenAI UI metadata for the AIRI chat-experience skill. | KEEP_AGENT_TOOLING — keep with the skill. |
| `.agents/skills/airi-chat-experience/references/airi-chat-architecture.md` | AIRI chat architecture guidance consumed by the skill. | KEEP_AGENT_TOOLING — keep with the skill. |
| `.agents/skills/airi-chat-experience/references/chat-feature-invariants.md` | Chat feature invariants consumed by the skill. | KEEP_AGENT_TOOLING — keep with the skill. |
| `.agents/skills/airi-chat-experience/references/clean-room-research.md` | Clean-room research rules consumed by the skill. | KEEP_AGENT_TOOLING — keep with the skill. |
| `.agents/skills/airi-chat-experience/SKILL.md` | Entry instructions for project-specific chat research/design/implementation work. | KEEP_AGENT_TOOLING — keep as a complete skill package. |
| `scripts/airi-discord-dashboard-window/main.cjs` | Source for the local macOS Electron dashboard wrapper; referenced by repository docs and a readiness test. | KEEP_AGENT_TOOLING — keep source; ignore generated `.app` output. |
| `scripts/airi-discord-dashboard-window/readiness.cjs` | Reusable readiness policy for the wrapper; imported by the Discord bot test. | KEEP_AGENT_TOOLING — keep with the wrapper and test. |
| `scripts/airi-discord-dashboard-window/readiness.d.cts` | Type contract for the CommonJS readiness module. | KEEP_AGENT_TOOLING — keep with `readiness.cjs`. |
| `scripts/airi-discord-dashboard-window/README.md` | Usage and ownership documentation for the local wrapper. | KEEP_DOCUMENTATION — keep with the wrapper source. |
| `scripts/airi-discord-launcher-app/README.md` | Documentation for the legacy/local AIRI desktop + Discord launcher workflow. | KEEP_DOCUMENTATION — keep; generated bundles remain ignored. |
| `scripts/dev-airi-discord.command` | Source macOS launcher for the AIRI desktop-owned Discord bridge; covered by a contract test. | KEEP_AGENT_TOOLING — keep with its README and contract test. |

## 4. Automatic actions performed

The two removals below were recorded here before execution, as required. They were limited to untracked, reproducible runtime/build artifacts.

| Path | Exact action | Reason |
| --- | --- | --- |
| `.gitignore` | Replaced the two narrowly scoped `scripts/.../*.app/` rules with `scripts/.../*.app`, and added `services/discord-bot/.airi-discord-dashboard-state.json`. | A trailing slash does not match the observed `.app` symlink; the runtime state is reproducible local counters/version data. |
| `scripts/airi-discord-dashboard-window/AIRI Discord v0.1.7.app` | Unlinked the untracked symbolic link only. | Confirmed symbolic link to ignored generated output at `apps/discord-dashboard/dist/mac-arm64/AIRI Discord.app`; it was not source or the only copy of useful work. |
| `services/discord-bot/.airi-discord-dashboard-state.json` | Removed the untracked regular JSON file. | Generated runtime counter/version state; source code recreates it and it contained no credential or user content. |

## 5. Remaining human decisions

These are commit-scope or product-policy choices, not unresolved file identities and not sensitive-file blockers.

| Path | Available choices | Recommended choice | Risk of each choice |
| --- | --- | --- | --- |
| `services/discord-bot/.env` | Keep the tracked placeholder template; or later migrate it to `.env.example` and update consumers/docs. | Keep it placeholder-only for this baseline; perform any rename as a separate explicit migration. | Keeping it risks a future contributor putting a real secret in a tracked file; migrating incompletely can break startup/docs. |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Commit all current root changes together; or split Discord scripts, lint changes, security override, catalog cleanup, and regenerated lockfile. | Split by intent and regenerate/review the lockfile from approved inputs. | A bulk commit hides unrelated dependency/lint changes; partial splitting without lockfile regeneration can leave inconsistent metadata. |
| `apps/stage-tamagotchi/src/preload/{beat-sync.ts,index.ts,shared.ts}` | Accept deletions with the replacement preload; or retain old preloads. | Accept only as part of the complete replacement refactor after scoped Electron tests/typecheck/build. | Accepting an incomplete refactor can break windows; retaining both paths can preserve obsolete unsafe behavior and duplicate ownership. |
| `design-qa.md` | Commit as QA documentation; revise machine-local evidence references; or keep it out of the baseline. | Preserve it, revise evidence references, then commit with the Discord dashboard UI group. | Committing unchanged leaves non-portable evidence paths; omitting it loses useful QA rationale. |
| `security_best_practices_report.md` | Commit as a security review artifact; keep local; or replace with issue/PR findings. | Keep separate from production changes and commit only if repository policy accepts review reports. | Committing can expose operational review detail/noise; omitting can lose audit context. |
| `.agents/skills/airi-chat-experience/**` | Commit as team-owned repository tooling; or keep outside the product baseline. | Commit as one project-agent-tooling group because the package is complete and AIRI-specific. | Committing establishes a maintenance obligation; omitting loses repeatable project guidance. |
| `scripts/airi-discord-dashboard-window/**`, `scripts/airi-discord-launcher-app/README.md`, `scripts/dev-airi-discord.command` | Commit maintained launcher source/docs; or keep all launcher material machine-local. | Commit source/docs/tests and ignore only generated `.app` artifacts. | Keeping source local breaks documented/tested workflows; committing generated bundles would add machine-specific build output. |

## 6. Proposed safe commit groups

These groups are proposals only. Mixed files such as root manifests should be staged by reviewed hunk, not swept into more than one commit.

| Commit name | Exact paths or path groups | Purpose | Dependencies |
| --- | --- | --- | --- |
| `chore(repo): document safe pre-security baseline` | `PRE_SECURITY_BASELINE.md`, `SAFE_BASELINE_REVIEW.md`, reviewed `.gitignore` artifact-ignore hunks | Record the inventory/decision and narrow local-artifact exclusions. | None; commit before source partitioning if reports are repository-owned. |
| `chore(agents): add AIRI chat experience guidance` | `.agents/skills/airi-chat-experience/**` | Add the complete project-specific agent skill. | None. |
| `chore(discord): add local dashboard launchers` | `scripts/airi-discord-dashboard-window/{main.cjs,readiness.cjs,readiness.d.cts,README.md}`, `scripts/airi-discord-launcher-app/README.md`, `scripts/dev-airi-discord.command`, `apps/stage-tamagotchi/scripts/discord-launcher-contract.test.ts`, `services/discord-bot/src/standalone/dashboard-window-readiness.test.ts`, Discord contributor-doc references | Preserve maintained launcher source, documentation, and contract tests without generated app bundles. | Approved relevant `package.json` Discord script hunk. |
| `feat(discord): add standalone runtime and dashboard` | `apps/discord-dashboard/**` excluding `dist/**`; `services/discord-bot/src/{adapters,bots,pipelines,standalone,test,utils}/**`; `services/discord-bot/{README.md,package.json,vitest.config.ts,.env}`; relevant `package.json` script hunk | Commit the large standalone Discord feature in smaller domain subcommits (runtime, voice, memory, dashboard, bridge), each with adjacent tests. | Discord package manifests; dashboard package; lockfile only after manifests are approved. |
| `fix(discord): harden standalone boundaries` | Only reviewed prior-security paths listed in `PRE_SECURITY_BASELINE.md` section 13 category 4 under `apps/discord-dashboard/**` and `services/discord-bot/**`; optionally `security_best_practices_report.md` separately | Isolate authorization, send filtering, logging, dashboard HTTP/Electron, state permission, memory, and safety-policy hardening. | The corresponding standalone feature boundary must exist first; do not duplicate paths across commits—split by hunk where necessary. |
| `refactor(stage-tamagotchi): replace Electron preload boundary` | `apps/stage-tamagotchi/src/preload/**`, `apps/stage-tamagotchi/src/main/windows/**`, `apps/stage-tamagotchi/src/main/services/electron/{protected-storage*,secure-storage*}`, plugin sandbox paths, relevant Electron Vite/builder/entitlement config and tests | Land the sandbox-compatible preload/window/storage refactor with explicit deletion decisions. | Resolve protected-versus-secure storage ownership; run scoped Electron tests/typecheck/build. |
| `feat(chat): add prompt, memory, and context orchestration` | Relevant changes under `packages/{ccc,core-agent,stage-pages,stage-shared,stage-ui}/**`, associated tests, `packages/i18n/src/locales/**`, and affected package manifests | Partition chat prompt contributions, session/chat memory, context bridge/observability, and business UI by domain. | Commit owning contracts before consuming UI; package manifest and lockfile changes last. |
| `refactor(server): update lifecycle and protocol boundaries` | Relevant changes under `packages/{server-runtime,server-sdk,server-shared,plugin-protocol,plugin-sdk}/**` and their tests/manifests | Isolate lifecycle, connection observation, protocol, and plugin-host changes. | Contract packages before runtime consumers; lockfile after manifests. |
| `fix(computer-use-mcp): preserve grounding and runner fixes` | `services/computer-use-mcp/chrome-extension/msg_bridge.js`, `services/computer-use-mcp/src/**` | Keep the coherent grounding regressions plus runner/server/error-handling maintenance. | Confirm the package already owns `@moeru/std`; split pure error-normalization from grounding behavior if review demands it. |
| `fix(minecraft): preserve runtime regressions` | `services/minecraft/src/**`, excluding unrelated files; `services/minecraft/package.json` in the dependency group | Keep timeout ownership, independent render/DP rows, detector expectations, and adjacent tests. | Source/tests first; dependency metadata group after workspace decision. |
| `fix(twitter-services): update parser contracts` | `services/twitter-services/src/**`, `services/twitter-services/{package.json,vitest.config.ts}` | Keep parser API, error extraction, and test enablement together. | Vitest catalog/workspace resolution and regenerated lockfile. |
| `chore(deps): reconcile workspace catalogs and security override` | Reviewed hunks in `pnpm-workspace.yaml`, all affected `package.json` files, regenerated `pnpm-lock.yaml`, relevant CI/lint config | Make dependency metadata reproducible and keep the `undici` override auditable. | All source commit dependency requirements decided first; regenerate lockfile from the final manifests. |
| `docs(discord): preserve provider UI QA` | Revised `design-qa.md` | Preserve the project-specific QA result with portable evidence references. | Discord dashboard UI group and durable evidence location. |
| `chore(repo): correct contributor commands` | `AGENTS.md` | Correct the repository typecheck command reference. | None. |
| `chore(stage-scenarios): remove empty platform indexes` | `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/macos-26/texts/index.ts`, `packages/scenarios-stage-tamagotchi-browser/src/components/platforms/windows-11/index.ts` | Remove empty, unreferenced tracked placeholders. | Scoped scenario build/typecheck confirmation. |

## 7. Final readiness status

`READY_FOR_BASELINE_COMMIT`

All seven sensitive candidates are resolved without a real or uncertain secret, all 63 UNKNOWN paths have exact classifications, and all 11 local-tooling paths have ownership recommendations. “Ready” means ready to build the proposed reviewed commit groups; it does not mean the 472-path working tree is safe to commit wholesale.
