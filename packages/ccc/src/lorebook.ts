import type { CharacterBook, CharacterBookEntry } from './export/types'

const MAX_SCAN_MESSAGES = 64
const MAX_SCAN_TEXT_LENGTH = 32_768

/** Result state for one character-lorebook entry. */
export type CharacterBookEntryStatus
  = | 'included'
    | 'disabled'
    | 'empty'
    | 'unmatched'
    | 'regex-unsupported'
    | 'budget-evicted'

/** Observable evaluation result for one character-lorebook entry. */
export interface CharacterBookEntryEvaluation {
  /** Entry identifier, falling back to its stable array index. */
  id: number | string
  /** Original zero-based position inside the portable lorebook. */
  index: number
  /** Human-readable entry name when the card provides one. */
  name?: string
  /** Position requested by the portable character-book contract. */
  position: 'after_char' | 'before_char'
  /** Whether the entry contributes content to this prompt. */
  status: CharacterBookEntryStatus
  /** Literal keys that caused the entry to activate. */
  matchedBy: string[]
  /** Provider-independent approximate token cost used for the lorebook budget. */
  estimatedTokens: number
  /** Prompt content after portable decorator lines are removed. */
  content: string
}

/** Inputs used to evaluate a portable Character Card V3 lorebook. */
export interface EvaluateCharacterBookOptions {
  /** Chronological plain-text conversation messages, including the current user turn. */
  messages: string[]
  /**
   * Optional provider-specific token estimator.
   *
   * @default estimateCharacterBookTokens
   */
  estimateTokens?: (content: string) => number
}

/** Complete prompt projection and diagnostics for one lorebook evaluation. */
export interface CharacterBookEvaluation {
  /** Included content requested before the active character definition. */
  beforeCharacter: string[]
  /** Included content requested after the active character definition. */
  afterCharacter: string[]
  /** Entry diagnostics kept in the lorebook's original order. */
  entries: CharacterBookEntryEvaluation[]
  /** Effective non-negative token budget, when the card declares one. */
  tokenBudget?: number
  /** Total estimated tokens retained after budget eviction. */
  usedTokens: number
}

interface MutableEntryEvaluation extends CharacterBookEntryEvaluation {
  entry: CharacterBookEntry
}

/**
 * Estimates provider-independent token usage for lorebook budgeting.
 *
 * Use when:
 * - No model tokenizer is available at the portable character-card boundary
 * - A deterministic, conservative budget is preferable to ignoring `token_budget`
 *
 * Expects:
 * - UTF-8 text that will be inserted into a provider prompt
 *
 * Returns:
 * - At least one estimated token for non-empty content
 * - Roughly one token per four UTF-8 bytes
 */
export function estimateCharacterBookTokens(content: string) {
  if (!content)
    return 0

  return Math.max(1, Math.ceil(new TextEncoder().encode(content).length / 4))
}

/**
 * Normalizes lorebook content for prompt insertion.
 *
 * Before:
 * - "@@depth 4\n\nThe archive is sealed."
 *
 * After:
 * - "The archive is sealed."
 */
function lorebookPromptContent(content: string) {
  const lines = content.split('\n')
  let firstContentLine = 0

  while (firstContentLine < lines.length) {
    const line = lines[firstContentLine].trim()
    if (!line || /^@@@?[a-z_]+(?:\s.*)?$/i.test(line)) {
      firstContentLine += 1
      continue
    }
    break
  }

  return lines.slice(firstContentLine).join('\n').trim()
}

function literalMatches(text: string, keys: string[], caseSensitive: boolean) {
  const comparableText = caseSensitive ? text : text.toLowerCase()

  return keys.filter((key) => {
    const trimmedKey = key.trim()
    if (!trimmedKey)
      return false
    const comparableKey = caseSensitive ? trimmedKey : trimmedKey.toLowerCase()
    return comparableText.includes(comparableKey)
  })
}

function matchedKeys(entry: CharacterBookEntry, text: string) {
  if (entry.constant)
    return ['$constant']

  const primaryMatches = literalMatches(text, entry.keys, entry.case_sensitive ?? false)
  if (primaryMatches.length === 0)
    return []

  if (!entry.selective || !entry.secondary_keys?.length)
    return primaryMatches

  const secondaryMatches = literalMatches(text, entry.secondary_keys, entry.case_sensitive ?? false)
  if (secondaryMatches.length === 0)
    return []

  return [...primaryMatches, ...secondaryMatches]
}

function scanText(book: CharacterBook, messages: string[]) {
  const requestedDepth = book.scan_depth === undefined
    ? MAX_SCAN_MESSAGES
    : Math.max(0, Math.floor(book.scan_depth))
  const boundedDepth = Math.min(requestedDepth, MAX_SCAN_MESSAGES)
  if (boundedDepth === 0)
    return ''

  return messages
    .slice(-boundedDepth)
    .join('\n')
    .slice(-MAX_SCAN_TEXT_LENGTH)
}

function retentionRank(entry: CharacterBookEntry) {
  return entry.priority ?? entry.insertion_order
}

function applyTokenBudget(entries: MutableEntryEvaluation[], tokenBudget: number | undefined) {
  const included = entries.filter(entry => entry.status === 'included')
  let usedTokens = included.reduce((total, entry) => total + entry.estimatedTokens, 0)

  if (tokenBudget === undefined || usedTokens <= tokenBudget)
    return usedTokens

  const evictionOrder = [...included].sort((left, right) => {
    return retentionRank(left.entry) - retentionRank(right.entry)
      || left.entry.insertion_order - right.entry.insertion_order
      || right.index - left.index
  })

  for (const entry of evictionOrder) {
    if (usedTokens <= tokenBudget)
      break
    entry.status = 'budget-evicted'
    usedTokens -= entry.estimatedTokens
  }

  return usedTokens
}

/**
 * Evaluates a Character Card V3 character lorebook for one chat turn.
 *
 * Use when:
 * - Projecting a character-specific lorebook into an AIRI provider prompt
 * - Explaining why imported lore was included, unmatched, or budget-evicted
 *
 * Expects:
 * - Messages ordered from oldest to newest
 * - Imported regular-expression entries to remain disabled until evaluated in a bounded runtime
 * - `token_budget` to be interpreted with the supplied estimator or the portable byte estimate
 *
 * Returns:
 * - Deterministically ordered before/after character prompt content
 * - One observable result for every source entry
 */
export function evaluateCharacterBook(
  book: CharacterBook,
  options: EvaluateCharacterBookOptions,
): CharacterBookEvaluation {
  const estimateTokens = options.estimateTokens ?? estimateCharacterBookTokens
  const entries: MutableEntryEvaluation[] = book.entries.map((entry, index) => {
    const content = lorebookPromptContent(entry.content)
    let status: CharacterBookEntryStatus = 'unmatched'

    if (!entry.enabled)
      status = 'disabled'
    else if (entry.use_regex)
      status = 'regex-unsupported'
    else if (!content)
      status = 'empty'

    return {
      content,
      entry,
      estimatedTokens: content ? Math.max(0, Math.ceil(estimateTokens(content))) : 0,
      id: entry.id ?? index,
      index,
      matchedBy: [],
      name: entry.name,
      position: entry.position ?? 'after_char',
      status,
    }
  })

  let searchableText = scanText(book, options.messages)
  while (true) {
    const newlyIncluded: MutableEntryEvaluation[] = []

    for (const evaluation of entries) {
      if (evaluation.status !== 'unmatched')
        continue

      const matches = matchedKeys(evaluation.entry, searchableText)
      if (matches.length === 0)
        continue

      evaluation.matchedBy = matches
      evaluation.status = 'included'
      newlyIncluded.push(evaluation)
    }

    if (!book.recursive_scanning || newlyIncluded.length === 0)
      break

    searchableText = `${searchableText}\n${newlyIncluded.map(entry => entry.content).join('\n')}`
      .slice(-MAX_SCAN_TEXT_LENGTH)
  }

  const tokenBudget = book.token_budget === undefined
    ? undefined
    : Math.max(0, Math.floor(book.token_budget))
  const usedTokens = applyTokenBudget(entries, tokenBudget)
  const promptEntries = entries
    .filter(entry => entry.status === 'included')
    .sort((left, right) => left.entry.insertion_order - right.entry.insertion_order || left.index - right.index)

  return {
    beforeCharacter: promptEntries
      .filter(entry => entry.position === 'before_char')
      .map(entry => entry.content),
    afterCharacter: promptEntries
      .filter(entry => entry.position === 'after_char')
      .map(entry => entry.content),
    entries: entries.map(({ entry: _entry, ...evaluation }) => evaluation),
    tokenBudget,
    usedTokens,
  }
}
