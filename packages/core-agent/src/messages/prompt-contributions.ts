import type { Message, SystemMessage, TextContentPart } from '@xsai/shared-chat'

/** Placement supported by the provider-agnostic system prompt composer. */
export type PromptContributionPlacement = 'system-after' | 'system-before'

/** Projection state for one dynamic prompt contribution. */
export type PromptContributionStatus = 'excluded' | 'included'

/**
 * One inspectable dynamic contribution to a provider prompt.
 *
 * @param TMetadata Application-owned diagnostic metadata kept out of prompt text.
 */
export interface PromptContribution<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable identifier within the current prompt projection. */
  id: string
  /** Human-readable label for prompt inspection UI. */
  label: string
  /** Domain source such as `character-lorebook`, `memory`, or `tools`. */
  source: string
  /** Provider-visible plain text when the contribution is included. */
  content: string
  /** Location relative to the active character system message. */
  placement: PromptContributionPlacement
  /** Whether the composer applies the contribution or keeps it as a diagnostic only. */
  status: PromptContributionStatus
  /** Provider-independent approximate token cost, when known. */
  estimatedTokens?: number
  /** Source-specific diagnostics that are never sent to the model. */
  metadata?: TMetadata
}

function contributionText(contributions: PromptContribution[], placement: PromptContributionPlacement) {
  return contributions
    .filter(contribution => contribution.status === 'included' && contribution.placement === placement)
    .map(contribution => contribution.content.trim())
    .filter(Boolean)
    .join('\n\n')
}

function composeSystemContent(
  content: SystemMessage['content'],
  before: string,
  after: string,
): SystemMessage['content'] {
  if (typeof content === 'string')
    return [before, content, after].filter(Boolean).join('\n\n')

  const parts: TextContentPart[] = []
  if (before)
    parts.push({ type: 'text', text: before })
  parts.push(...content)
  if (after)
    parts.push({ type: 'text', text: after })
  return parts
}

/**
 * Composes included prompt contributions around the provider system message.
 *
 * Use when:
 * - Dynamic character lore, memory, tools, or temporary notes must remain inspectable
 * - Excluded diagnostics should be projected without reaching the provider
 *
 * Expects:
 * - Contributions already ordered by their owning domain
 * - Excluded contributions to remain present for observability
 *
 * Returns:
 * - A new message array with included before/after contributions applied once
 * - The original message objects unchanged
 */
export function composePromptContributions(
  messages: Message[],
  contributions: PromptContribution[],
): Message[] {
  const before = contributionText(contributions, 'system-before')
  const after = contributionText(contributions, 'system-after')
  if (!before && !after)
    return messages

  const systemMessageIndex = messages.findIndex(message => message.role === 'system')
  if (systemMessageIndex < 0) {
    return [
      {
        role: 'system',
        content: [before, after].filter(Boolean).join('\n\n'),
      },
      ...messages,
    ]
  }

  const systemMessage = messages[systemMessageIndex] as SystemMessage
  const nextMessages = [...messages]
  nextMessages[systemMessageIndex] = {
    ...systemMessage,
    content: composeSystemContent(systemMessage.content, before, after),
  }
  return nextMessages
}
