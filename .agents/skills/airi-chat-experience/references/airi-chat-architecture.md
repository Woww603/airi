# AIRI chat architecture map

Revalidate this map with `rg` before editing because the monorepo evolves quickly.

## Portable character data

- `packages/ccc/src/define/card.ts`: AIRI card-facing character fields.
- `packages/ccc/src/export/types/character_card_v3.ts`: Character Card V3 contract.
- `packages/ccc/src/export/types/character_book.ts`: portable character-book/lorebook fields.
- `packages/ccc/src/lorebook.ts`: deterministic literal-key lorebook evaluation, recursive activation, budgeting, and diagnostics. Imported regex entries remain observable but are not executed.
- `packages/stage-ui/src/stores/modules/airi-card.ts`: card import, activation, and system-prompt projection.

Keep portable schemas separate from stage runtime policy. A schema field existing does not prove that AIRI executes its semantics.

## Conversation runtime and prompt projection

- `packages/core-agent/src/runtime/chat-orchestrator-runtime.ts`: provider-agnostic send lifecycle.
- `packages/core-agent/src/messages/prompt-contributions.ts`: itemized dynamic prompt composition and included/excluded diagnostics.
- `packages/core-agent/src/messages/`: structured messages, context prompts, and compaction.
- `packages/stage-ui/src/stores/chat.ts`: stage adapters, runtime hooks, memory supplements, tool prompts, and analytics.
- `packages/stage-ui/src/stores/chat/context-store.ts`: context ingestion and snapshots.
- `packages/stage-pages/src/pages/devtools/context-flow/`: prompt/context observability UI.

Put stable orchestration policy in `core-agent`; keep provider, stage, and presentation adapters outside it.

## Sessions, messages, and branches

- `packages/stage-ui/src/stores/chat/session-store.ts`: session persistence, sync, and forks.
- `packages/stage-ui/src/database/repos/chat-sessions.repo.ts`: local persistence boundary.
- `packages/stage-ui/src/components/scenarios/chat/`: reusable chat UI.
- `packages/stage-ui/src/components/scenarios/chat/components/action-menu/`: current message actions.
- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts`: multi-window authority commands for retry, edit, prompt exclusion, and response-alternative selection.

Assistant response alternatives are stored on the local assistant history item and selected by projecting one complete candidate onto the visible message. `excludedFromPrompt` keeps a message visible while the core provider boundary omits it. Session `promptProfile` owns the user persona, author's note, and editable rolling-summary provenance.

## Memory and retrieval

- `packages/stage-ui/src/database/repos/chat-memory.repo.ts`: scoped fragments, keyword extraction, ranking, retention, and prompt formatting.
- `packages/stage-ui/src/stores/chat-memory.ts` and `packages/stage-ui/src/stores/chat/memory-store.ts`: memory-facing stores.
- `packages/stage-pages/src/pages/settings/modules/memory-long-term.vue`: user controls.
- `packages/memory-pgvector/`: inspect before relying on it; a package name does not prove a complete vector-memory implementation.

Preserve user, character, and session scope. Treat summaries, factual memory, lore, and retrieved documents as distinct sources with different trust and expiry rules.

## Server and external capabilities

- `apps/server/src/schemas/chats.ts`: server chat/member/message persistence, including group-shaped records.
- `packages/plugin-sdk/`: permissioned extension host and runtime boundaries.
- `apps/stage-tamagotchi/src/shared` and main Electron services: Eventa contracts and desktop integration.

Server group-shaped storage does not prove that Stage implements multi-character AI turn selection or prompt composition.

## Required repository searches

Before introducing a new concept, search its product and domain synonyms:

```bash
rg -n "lorebook|world info|character_book|characterBook" apps packages
rg -n "persona|author.?s note|depth_prompt" apps packages
rg -n "fork|branch|retry|swipe|alternate" apps packages
rg -n "memory|summary|retrieval|vector|RAG" apps packages
rg -n "prompt|context.*provider|projection|token.*budget" packages/core-agent packages/stage-ui packages/stage-pages
```

Inspect the complete import and side-effect chain before moving an owning contract.
