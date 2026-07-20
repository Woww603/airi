# Chat feature invariants

Read only the section relevant to the requested feature.

## Lorebook and dynamic context

- Match deterministically for a fixed conversation snapshot.
- Define case handling, primary and secondary keys, constant entries, disabled entries, scan depth, and recursion bounds.
- Enforce a token budget before provider projection.
- Resolve priority and insertion order explicitly, including deterministic tie-breaking.
- Report activated, rejected, truncated, and budget-evicted entries to Context Flow with reasons.
- Keep lore scoped to global, character, persona, or chat ownership without accidental cross-character leakage.

## Prompt composition and temporary notes

- Represent contributions structurally until the final provider adapter.
- Preserve source, role, relative position or chat depth, trigger, and enabled state.
- Show the final provider-visible order and estimated token cost.
- Reject invalid role/depth combinations at the contract boundary.
- Keep safe defaults usable without exposing every expert control.

## Response alternatives, editing, and branches

- Preserve every accepted alternative until the user deletes it.
- Keep the selected alternative explicit and persist it across reload and sync.
- Define whether editing an ancestor creates a branch, invalidates descendants, or requires confirmation.
- Keep parent/child relationships navigable; do not hide forks as unrelated sessions.
- Cancel stale streams and prevent late events from mutating the newly selected branch.
- Make provider-visible inclusion distinct from visual hiding.

## User personas and multi-character chat

- Keep human persona identity separate from assistant character identity.
- Bind persona selection by explicit global, character, or session scope.
- Attribute historical messages to the persona active when they were authored unless the user explicitly migrates them.
- For multi-character chat, define turn selection, mentions, talkativeness, shared versus private context, and tool ownership.
- Prevent one character's private memory or system policy from leaking to another character.

## Summaries and long-term memory

- Treat generated summaries as fallible derived state, not authoritative history.
- Store source ranges and model/version provenance for summaries.
- Allow inspection and correction without rewriting original messages.
- Separate factual user memory, relationship state, episodic events, and conversation summaries.
- Apply expiry, deletion, consent, and scope independently for each memory class.
- Evaluate recall precision and harmful false recall, not only whether any memory was returned.

## Document RAG and attachments

- Preserve document source, scope, parser, chunk offsets, embedding model, and index version.
- Re-index when the embedding model or chunking policy changes.
- Sanitize parsed content and treat retrieved text as untrusted context.
- Expose citations or source references to the user when the answer depends on retrieved material.
- Bound file size, parser work, retrieval count, and prompt budget.
- Keep global, character, and chat attachments isolated.

## User automation, scripts, and transforms

- Prefer permissioned Plugin SDK operations over a new general-purpose language.
- Require capability declarations for network, filesystem, model calls, UI mutation, and persistent data.
- Provide preview or dry-run for destructive or text-rewriting operations.
- Bound execution time, recursion, output size, and event frequency.
- Make transform targets explicit: stored text, display text, provider input, model output, or TTS input.
- Never execute imported automation by default.
