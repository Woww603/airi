# AIRI Discord Bot Security Review

Date: 2026-07-13

Scope:

- `services/discord-bot`
- `apps/discord-dashboard`
- Discord bot production dependency paths in `pnpm-lock.yaml`

Validation completed:

- 27 Vitest files / 149 tests passed.
- Discord bot and Discord dashboard TypeScript checks passed.
- Targeted Discord bot/dashboard ESLint passed with zero warnings/errors.
- Electron dashboard production build passed.
- Root package/app/docs TypeScript checks passed across 53 workspaces.
- Production dependency audit was queried on 2026-07-12.
- Live Discord login succeeded as bot `1512143154210406491` in the supplied test guild.
- The supplied text and voice channels were visible with effective View/Send/Connect/Speak permissions.
- The bridge slash-command contract was temporarily registered and read back with Manage Server (`32`) defaults on restricted commands and DM disabled for `/summon`. Standalone mode was then corrected to register only the `/ping` command it can actually answer; the final global command readback contains only `/ping`.
- Five same-process dashboard restarts each returned to Discord `ClientReady`.
- One live `deepseek-v4-flash` health request returned the exact expected token.
- A self-muted, self-deafened Discord Voice handshake reached `ready` and disconnected without subscribing to audio.
- Live standalone input testing rejected prompt-injection payloads before generation, sent one privacy notice, accepted six messages in the configured window, rate-limited the seventh, and produced one reply for each accepted request.
- Browser-driven live tests passed for a true Discord Reply, `/ping`, exact-session memory opt-in/write/forget/status, and a direct message without a bot mention.
- A live DM memory was written, the packaged app was restarted, and the next DM retrieved the exact test value. The same user in the supplied guild channel did not receive the DM memory. The memory file's access counter advanced only for the matching DM scope.
- The memory file was verified as mode `0600`, scoped by stable Discord ids, reduced to zero cards by `forget`, and left with that exact DM session opted out.
- The real `deepseek-v4-flash` memory extractor returned source-grounded structured facts for harmless drink/color statements. Blue and red favorite-color statements produced the same semantic key; the real store marked blue as superseded and injected only red into the resulting system prompt.
- The installed dashboard configuration has memory and automatic extraction enabled. DMs now default to memory enabled with a separate privacy notice and persistent opt-out; guild/channel/user sessions still require explicit consent.

Repository-wide lint caveat:

- `pnpm lint` is currently blocked by three pre-existing/out-of-scope warnings: one unnecessary spread in the stage-tamagotchi plugin host and two unused imports in plugin-sdk. Targeted Discord bot/dashboard ESLint passes with zero warnings/errors.

Review correction:

- An early shell heuristic incorrectly treated the quoted empty value `DEEPSEEK_API_KEY=''` in tracked `.env` as non-empty. Parsing with the repository's dotenv implementation confirmed that the tracked value is empty. The real configured value remains only in ignored `.env.local`, whose mode is `0600`.

## Memory audit conclusion

- The long-term-memory path works for explicit requests and ordinary stable person facts in a memory-enabled exact session: capture occurs only after a successful assistant response, persists across process restart, and is injected into the next provider request as a separate `system` message immediately after the base system message. DMs default enabled; guild sessions still require explicit consent.
- Automatic memories are isolated to the exact DM user or exact guild/channel/user session. A nickname change cannot change ownership, and one user's memory is not returned to another user.
- Every successful memory-enabled turn is evaluated, but a turn correctly produces no durable card when it contains no reliable stable person fact. Arbitrary conversation text and assistant replies are not stored as person facts.
- The model may classify only an exact contiguous excerpt from the current user's message. Invented/paraphrased evidence, confidence below 0.85, unsafe content, and malformed output are rejected before storage.
- The schema records source Discord message id when available, exact source session, extraction model, semantic class, confidence, fact key, and supersession links. A newer fact with the same semantic key supersedes the older card in the same exact scope; superseded provenance remains inspectable but cannot enter prompts.
- Model classification remains fallible. Exact source evidence prevents hallucinated text from becoming a memory, but a model can still choose an imperfect semantic key or omit a valid fact. Current user text always takes priority over recalled derived state.

## Open findings

### 1. Voice mode transcribes every non-bot participant without per-participant opt-in

- Rule ID: PRIVACY-VOICE-CONSENT-001
- Severity: High
- Location: `services/discord-bot/src/bots/discord/commands/summon.ts:136`, `services/discord-bot/src/bots/discord/commands/summon.ts:254`, `services/discord-bot/src/bots/discord/commands/summon.ts:510`
- Evidence: Every non-bot speaking event starts a receiver subscription, converts the participant's audio, sends it to the configured speech-to-text provider, and forwards the transcription to AIRI. The join response now discloses this behavior, but no participant-specific consent state is enforced.
- Impact: A user with permission to summon the bot can cause other people in the voice channel to have speech sent to an external service without an explicit opt-in recorded by the bot.
- Fix: Choose and implement a consent model before treating voice as production-safe: per-user slash-command opt-in, an allowlisted voice channel with documented policy, or disabling transcription by default.
- Mitigation: Restrict `/summon` to trusted admins, use a dedicated test/consent voice channel, and keep the new public disclosure message.
- False positive notes: Server policy or prior human consent may exist outside the repository; verify operational practice. Repository code alone does not enforce it.

### 2. Bridge mode has weaker input-safety controls than standalone mode

- Rule ID: DISCORD-BRIDGE-SAFETY-001
- Severity: Medium
- Location: `services/discord-bot/src/adapters/airi-adapter.ts:481`, `services/discord-bot/src/adapters/airi-adapter.ts:908`
- Evidence: Bridge-mode ingress enforces DM/channel gates, session isolation, and rate limiting, but it does not apply standalone mode's blocked user/guild/term, credential/PII, or prompt-attack checks before forwarding text to AIRI.
- Impact: If bridge mode is enabled, Discord users can send secrets, personal data, or prompt-injection payloads to the downstream AIRI/model path that standalone mode would reject earlier.
- Fix: Decide whether bridge mode must share the standalone input-safety policy or delegate to a documented, tested core-agent policy. Avoid duplicating divergent regex policy in two adapters.
- Mitigation: Use channel allowlists and disable bridge DMs until the policy boundary is explicit.
- False positive notes: Downstream AIRI components may apply additional controls, but those controls were not proven at this adapter boundary. This does not affect a deployment that runs standalone mode only.

## Fixed during this review

### 3. Discord production dependency included vulnerable `undici@6.24.1`

- Rule ID: DEPS-UNDICI-001
- Severity: High
- Location: `pnpm-workspace.yaml:21`, `pnpm-lock.yaml`
- Evidence: The original `services__discord-bot>discord.js>undici` path resolved to `6.24.1`, affected by `GHSA-vxpw-j846-p89q` / `CVE-2026-12151`.
- Impact: A malicious or compromised WebSocket endpoint could cause unbounded memory growth and process termination through excessive fragments.
- Fix applied: The exact vulnerable resolution is overridden to patched `undici@6.27.0`. `pnpm why undici` confirms both `discord.js` and `@discordjs/rest` use `6.27.0`; a new production audit returns no Discord bot/dashboard advisories.
- Source: https://github.com/advisories/GHSA-vxpw-j846-p89q

### 4. Voice audio buffer could enter an infinite loop

- Rule ID: DOS-VOICE-BUFFER-001
- Severity: High
- Location: `services/discord-bot/src/utils/audio-monitor.ts:33`
- Evidence: The previous loop compared an immutable pre-loop size while shifting buffers, so audio over the cap never terminated.
- Impact: Continuous voice input could pin the process CPU and stop the bot.
- Fix applied: Track current bytes, trim exact overflow, validate a positive cap, retain only newest bytes, and add a regression test that previously timed out.

### 5. Voice listeners, monitors, and debounce state were not isolated or cleaned up correctly

- Rule ID: DOS-VOICE-LIFECYCLE-002
- Severity: Medium
- Location: `services/discord-bot/src/bots/discord/commands/summon.ts:136`, `services/discord-bot/src/bots/discord/commands/summon.ts:206`, `services/discord-bot/src/bots/discord/commands/summon.ts:340`, `services/discord-bot/src/bots/discord/commands/summon.ts:387`
- Evidence: Listener references were never stored, active monitors were never registered, one global debounce timer allowed speakers to cancel one another, and a departed cache member caused an exception.
- Impact: Duplicate processing, memory leaks, dropped transcriptions, and process instability during normal voice-channel churn.
- Fix applied: Store exact listener references, stop only owned listeners, register/clear monitors, isolate timers per user, bound queued audio per user, and handle departed members safely.

### 6. Model output could trigger Discord mentions

- Rule ID: DISCORD-MENTION-OUTPUT-001
- Severity: Medium
- Location: `services/discord-bot/src/adapters/discordSend.ts:14`
- Evidence: Generated content was previously passed as a plain string to Discord, allowing text such as `@everyone`, role mentions, or user mentions to be interpreted as notifications.
- Impact: Prompted or accidental model output could mass-notify a server or harass users.
- Fix applied: All standalone and bridge channel/user sends now use `allowedMentions: { parse: [] }`.

### 7. Runtime logs and local state files exposed more private data than necessary

- Rule ID: PRIVACY-LOGGING-001
- Severity: Medium
- Location: `services/discord-bot/src/pipelines/tts.ts:69`, `services/discord-bot/src/bots/discord/commands/summon.ts:539`, `services/discord-bot/src/standalone/rotating-file-log.ts:95`, `apps/discord-dashboard/src/main/index.ts:37`
- Evidence: Full speech transcriptions and bridge text were logged, while existing `.env.local`, runtime logs, imported local data, and dashboard counters could be mode `0644` under the normal umask.
- Impact: Other local users or copied diagnostic logs could expose conversations, tokens, or activity metadata.
- Fix applied: Log only lengths/status, enforce `0600` for secrets, memory/log/state files, repair existing `.env.local` permissions, and preserve private modes across log rotation/import.

### 8. Local dashboard request and browser defenses were incomplete

- Rule ID: DASHBOARD-HTTP-001
- Severity: Medium
- Location: `services/discord-bot/src/standalone/dashboard.ts:112`, `services/discord-bot/src/standalone/dashboard.ts:396`, `apps/discord-dashboard/src/main/index.ts:68`
- Evidence: Body size was counted as JavaScript characters instead of bytes, malformed client JSON returned HTTP 500 with raw exception text, CSP allowed inline scripts without a nonce, and Electron delegated arbitrary new-window URLs to the OS.
- Impact: Local hostile clients could exceed the intended body cap; internal paths/errors could leak; future HTML injection would have had a weaker CSP; unsafe navigation could reach external handlers.
- Fix applied: Enforce JSON media type and a 64 KiB byte cap, return bounded 400/413/415/500 errors, configure HTTP timeouts, use a fresh CSP nonce, deny new windows/cross-origin navigation, and keep exact Host/Origin/token checks.

### 9. Bot-addressing cleanup removed other users' mentions

- Rule ID: DISCORD-MENTION-INPUT-001
- Severity: Low
- Location: `services/discord-bot/src/adapters/discordMention.ts:1`
- Evidence: Bridge mode used a regex that removed every `<@...>` token when AIRI was mentioned.
- Impact: AIRI received altered message meaning and could answer about the wrong person.
- Fix applied: Shared normalization removes only the current bot's exact mention and preserves all other references.

### 10. Standalone command imports pulled the bridge voice stack into the dashboard type boundary

- Rule ID: MODULE-STANDALONE-COMMANDS-001
- Severity: Medium
- Location: `services/discord-bot/src/adapters/standalone-adapter.ts`, `services/discord-bot/src/bots/discord/commands/registration.ts`
- Evidence: Standalone imported its registrar through the command barrel, which also exports `/summon`. The Electron dashboard consequently compiled voice/STT implementation files under its DOM + Node type environment and failed with 15 unrelated nullability and binary-type errors.
- Impact: Dashboard builds and type checks depended on bridge-only voice internals; future bridge changes could break standalone distribution without any runtime relationship.
- Fix applied: Moved the pure slash-command builders/REST registration into a side-effect-free registration module. Standalone imports that module directly; bridge mode retains the aggregate command entrypoint. Bot and dashboard type checks now both pass.

### 11. A failed slash-command acknowledgement terminated the bot

- Rule ID: AVAILABILITY-INTERACTION-001
- Severity: High
- Location: `services/discord-bot/src/adapters/standalone-adapter.ts`
- Evidence: A live `/ping` returned Discord error `10062` (`Unknown interaction`). The async EventEmitter listener had no rejection boundary, so Node emitted an unhandled error and terminated the standalone process.
- Impact: One expired or otherwise rejected Discord interaction could take the entire bot offline.
- Fix applied: Route interactions through a contained async boundary, track in-flight interaction tasks during shutdown, record failures without exposing request data, and add a regression test that reproduces the rejected reply. A second live `/ping` returned `Pong!` and the bot remained online.

### 12. Discord.js dropped messages from uncached DM channels

- Rule ID: RELIABILITY-DM-001
- Severity: High
- Location: `services/discord-bot/src/adapters/standalone-adapter.ts`
- Evidence: Discord delivered raw DM `MESSAGE_CREATE`, and REST showed the new messages, but Discord.js 14.26.3 emitted no high-level `MessageCreate`. Its `MessageCreateAction` receives no channel `type` in this payload and cannot construct an uncached `DMChannel`.
- Impact: Standalone appeared to support DMs but silently ignored them after a fresh process start.
- Fix applied: For raw DM messages whose channel is not cached, fetch the exact channel/message through Discord REST and route the resulting official `Message` object through the existing access, privacy, memory, safety, and model pipeline. No raw content is trusted or logged. The live no-mention DM then received one privacy notice and the exact response `私聊正常`.

### 13. Chinese address detection rejected harmless “remember … code” text

- Rule ID: SAFETY-ADDRESS-FALSE-POSITIVE-001
- Severity: Low
- Location: `services/discord-bot/src/standalone/safety-policy.ts`
- Evidence: The address regex accepted a bare `住`, so `记住：我的测试代号是蓝鸟` was interpreted from `住` through `号` as an address.
- Impact: Safe memory requests containing unrelated words ending in `号` could be silently blocked.
- Fix applied: Require address semantics such as `住在`, `家住`, `我住`, or `居住`; regression tests confirm the harmless phrase passes while `请记住我住在测试路123号` remains blocked.

### 14. Mutable display names were embedded in explicit memory facts

- Rule ID: RELIABILITY-MEMORY-IDENTITY-001
- Severity: Medium
- Location: `services/discord-bot/src/standalone/memory-store.ts:449`, `services/discord-bot/src/standalone/memory-store.ts:803`
- Evidence: The previous stored content used `<display name>: <fact>`. A Discord nickname change left the old mutable name inside the future system prompt even though scope ownership used the correct stable user id.
- Impact: AIRI could associate a correct user's fact with a stale or misleading human-readable identity.
- Fix applied: Explicit-chat cards now store only the fact. Prompt attribution states that the current verified Discord user requested the memory, while ownership continues to derive exclusively from stable Discord ids. A regression test changes the nickname between capture and recall and confirms neither display name enters the prompt.

### 15. Persisted malformed or unsafe memory records could bypass write-time validation

- Rule ID: SECURITY-MEMORY-LOAD-001
- Severity: High
- Location: `services/discord-bot/src/standalone/memory-store.ts:281`, `services/discord-bot/src/standalone/memory-store.ts:529`
- Evidence: Safety and scope checks previously ran when new cards were written, but an existing or imported JSON record was accepted after structural parsing without re-running prompt-injection/secret checks or verifying all identifiers required by its scope.
- Impact: A locally edited/imported memory file could inject hostile system-prompt text or create an orphaned scope record eligible for unintended retrieval behavior.
- Fix applied: Every persisted/imported record is normalized and revalidated on read. Unsafe content and records missing required scope identifiers are discarded before prompt construction. Regression tests reproduced both cases before the fix.

### 16. Standalone Discord did not form source-grounded person memory from ordinary consented conversations

- Rule ID: RELIABILITY-MEMORY-SEMANTICS-001
- Severity: Medium
- Location: `services/discord-bot/src/standalone/memory-extractor.ts`, `services/discord-bot/src/standalone/memory-store.ts`
- Evidence: Previous capture required an explicit `记住...` phrase, stored no extraction provenance, and retained contradictory facts together.
- Impact: Stable preferences stated naturally were forgotten, while changed facts could leave stale and current cards simultaneously recallable.
- Fix applied: Every successful memory-enabled turn is evaluated by a bounded extractor. Only exact user-message evidence with confidence at least 0.85 can be stored. Records include semantic class/key, model, source message/session, and confidence. A newer matching key supersedes the prior card in the same exact Discord scope, and prompt construction excludes superseded state.
- Verification: Real `deepseek-v4-flash` extraction produced stable `preference.favorite_color` keys for blue and red; the integrated real store retained both provenance records but injected only red.

### 17. Installed memory configuration bypassed the intended consent gate

- Rule ID: PRIVACY-MEMORY-CONSENT-001
- Severity: High
- Location: packaged user data `.env.local` and standalone configuration defaults
- Evidence: The installed dashboard explicitly set consent-required false, and code defaults also treated missing consent configuration as false.
- Impact: Allowed Discord sessions could read or create long-term memory without a prior exact-session opt-in.
- Fix applied at audit time: Store, filter, dashboard-save, tracked env, and documentation defaults were aligned so no configuration path silently bypassed the selected policy. The subsequent product decision intentionally changed only DMs to default-on memory: a separate channel notice discloses it, `off` persists an exact-session opt-out, and `forget` deletes captured cards while preserving that opt-out. Guild/channel/user sessions still do not extract or recall before `记忆 开启` / `!airi memory on`.

## Remaining verification gaps

- Real Discord login, command registration, permission inspection, five reconnects, normal guild mention/reply flows, `/ping`, prompt-attack rejection, rate limiting, privacy notices, exact-session memory lifecycle, direct messages, and a non-recording voice transport handshake passed.
- The real DeepSeek provider path passed. STT authentication and speech compatibility remain unverified because bridge/STT credentials are not configured.
- The final browser-driven Discord ordinary-statement test passed in the real `itswoww` DM: exact-session consent enabled automatic capture of `我最喜欢的颜色是蓝色`, the next turn recalled `蓝色`, a later `我最喜欢的颜色是红色` superseded the old card under `preference.favorite_color`, and the following turn recalled only `红色`. The persisted audit record retained source message/session provenance, `deepseek-v4-flash`, confidence `0.95`, and bidirectional supersession links. `!airi memory forget` then deleted both test cards and restored the exact DM to opted-out state.
- The later DM-default-on policy is covered by regression tests for automatic extraction without `memory on`, guild consent preservation, persistent DM `off`, and separate privacy-notice delivery. The packaged app is running this build. The existing `itswoww` DM remains opted out because the preceding live cleanup used `forget`; the new default intentionally does not override a persisted user/session opt-out.
- The Electron dashboard built successfully, but automated click-through was blocked because the repository-required `agent-browser` executable is not installed in the environment.
- `OpusDecoder` remains at 0% automated coverage; it requires real/fixture Opus packets or a live voice test.
