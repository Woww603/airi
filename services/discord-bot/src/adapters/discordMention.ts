/**
 * Normalizes Discord message text by removing only the current bot mention.
 *
 * Before:
 * - "<@123> ask <@456> about this"
 *
 * After:
 * - "ask <@456> about this"
 */
export function removeDiscordBotMention(text: string, botUserId: string): string {
  if (!botUserId)
    return text.trim()

  return text
    .replaceAll(`<@${botUserId}>`, '')
    .replaceAll(`<@!${botUserId}>`, '')
    .trim()
}
