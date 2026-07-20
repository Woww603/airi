---
name: airi-chat-experience
description: Research, design, implement, review, or test AIRI chat-experience features such as character cards, lorebooks, personas, prompt composition, message editing, response alternatives, conversation branches, summaries, memory retrieval, RAG, group chat, and user automation. Use when comparing AIRI with external chat products such as SillyTavern or Open WebUI, or when adapting an external chat interaction into the AIRI monorepo while preserving licensing, module ownership, safety, observability, and testability.
---

# AIRI Chat Experience

Improve AIRI's chat product without importing another product's architecture or license obligations. Start from observable behavior and AIRI's existing domain boundaries.

## Workflow

1. Classify the request as research, product design, implementation, review, or verification.
2. Read `references/clean-room-research.md` whenever an external product influences the work.
3. Read `references/airi-chat-architecture.md` before planning or editing AIRI code.
4. Read only the relevant section of `references/chat-feature-invariants.md` for the feature being changed.
5. Search the repository for existing contracts and implementations before proposing new modules or utilities.
6. Establish current behavior with a focused test or reproducible interaction before changing production code.
7. Implement at the owning boundary, expose prompt/context decisions to observability, and keep UI components free of prompt-building policy.
8. Run targeted tests, the affected workspace typecheck, then the repository-required typecheck and lint commands.
9. Report the observed baseline, implemented behavior, clean-room sources, tests, and intentionally excluded scope.

## Research Rules

- Compare products with the same model, provider settings, character data, and conversation fixture whenever possible.
- Separate model quality from frontend behavior, prompt construction, memory, and interaction design.
- Prefer official documentation, published specifications, release notes, and black-box behavior over commentary.
- Treat source-visible software as licensed software. Do not copy, translate, mechanically rewrite, or structurally mirror incompatible copyleft implementation code into AIRI.
- Record which behavior came from observation, which contract came from a shared specification, and which design is an AIRI-specific decision.
- Ask for legal direction before combining or linking code when the license boundary is unclear.

## AIRI Design Rules

- Keep character-card contracts and portable formats in `packages/ccc` or the package that owns the format.
- Keep provider-agnostic conversation and prompt orchestration in `packages/core-agent`.
- Keep reusable stage chat state and business UI in `packages/stage-ui`.
- Keep shared settings pages in `packages/stage-pages` and translations in `packages/i18n`.
- Keep external capabilities behind `packages/plugin-sdk`, Eventa contracts, or an existing service boundary.
- Reuse the current session, context, memory, and observability stores instead of creating a parallel chat runtime.
- Do not add a dependency until internal alternatives and focused libraries have been researched and the user has selected an option, as required by the repository guide.
- Use the existing `vue`, `vue-best-practices`, `vueuse-functions`, `unocss`, `pnpm`, `eventa`, and `xsai` skills when their trigger conditions apply.

## Chat Safety and Observability

- Represent prompt contributions with provenance, scope, role, ordering, and budget metadata before flattening them for a provider.
- Make dynamic lore, memory, RAG, tools, and temporary notes inspectable in Context Flow.
- Prevent recalled or imported content from silently overriding the active character identity or higher-priority system policy.
- Preserve user, character, session, and transport isolation for memory and attachments.
- Preserve previous replies when offering alternatives or branches; destructive replacement must be explicit.
- Require preview, permission, and bounded execution for user automation, regex transforms, scripts, and external tools.
- Distinguish stored text, displayed text, spoken text, and provider-visible text whenever transformations are supported.

## Verification

- For bugs, write a failing regression test first when reproduction is feasible and include the tracker identifier and report link required by the repository guide.
- Test public behavior rather than exporting private helpers solely for tests.
- Cover deterministic ordering, token/context budgets, persistence, isolation, cancellation, and failure recovery when applicable.
- Use Vitest for implemented TypeScript/Vue modules and browser mode for DOM behavior where possible.
- Run the narrowest relevant test first, followed by the affected workspace typecheck.
- Before handoff, run the repository-mandated `pnpm type-check` and `pnpm lint`; report any failure that predates or lies outside the change.

## Scope Control

- Do not recreate SillyTavern wholesale. Adapt only behavior that supports AIRI's digital-life direction.
- Prefer deep domain modules over pass-through services and tiny test-seam helpers.
- Avoid adding a general scripting language while the same capability can be expressed through permissioned Plugin SDK operations.
- Treat advanced prompt controls as progressive disclosure: safe defaults first, inspectable expert controls second.
- When the feature would substantially change AIRI's identity, storage model, or security posture, stop after evidence and alternatives and request a user decision.
