const AIRI_STREAMING_CONTROL_TAG_PATTERN = /<\|\s*(?:ACT|DELAY|CALL)\b[\s\S]*?\|>/gi
const PRIVATE_OUTPUT_PATTERNS = [
  /\bActive AIRI character card:/i,
  /\bDiscord hard safety rules for this turn:/i,
  /\bRelevant standalone memory card notes:/i,
  /\b(?:DEEPSEEK_API_KEY|DISCORD_TOKEN|OPENAI_API_KEY)\s*[:=]/i,
  /\b(?:access|refresh|discord|bot)[_ -]?token\s*[:=]\s*\S{6,}/i,
  /\bsk-[\w-]{12,}\b/i,
]

/**
 * Checks whether normalized model output is safe to send into Discord.
 *
 * Use when:
 * - A provider response may have echoed internal prompt section markers.
 * - Credential-shaped output must fail closed before Discord delivery.
 *
 * Expects:
 * - AIRI control tags may already have been removed, but this check does not depend on that.
 *
 * Returns:
 * - `false` when fixed internal markers or credential-shaped text are present.
 */
export function isStandaloneDiscordReplySafe(input: string): boolean {
  const normalized = input.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  return !PRIVATE_OUTPUT_PATTERNS.some(pattern => pattern.test(normalized))
}

/**
 * Normalizes standalone Discord assistant replies into user-visible text.
 *
 * Before:
 * - `<|ACT:"emotion":"happy"|><|DELAY:1|>你好呀`
 * - `A <|ACT {"emotion":{"name":"curious","intensity":1}}|> B`
 *
 * After:
 * - `你好呀`
 * - `A  B`
 */
export function normalizeStandaloneDiscordReplyText(input: string): string {
  // Control tags are protocol metadata, but every other code point is provider
  // output owned by the shared Discord delivery contract. Do not trim or fold
  // whitespace here: chunk concatenation must reproduce that visible output.
  return input.replace(AIRI_STREAMING_CONTROL_TAG_PATTERN, '')
}
