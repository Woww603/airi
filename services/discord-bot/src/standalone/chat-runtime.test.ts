import type { Message } from '@xsai/shared-chat'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { describe, expect, it, vi } from 'vitest'

import {
  normalizeStandaloneHistoryLimit,
  resolveStandaloneChatRuntimeConfig,
  StandaloneChatRuntime,
  StandaloneChatRuntimeError,
} from './chat-runtime'
import { resolveStandaloneMemoryStoreConfig, StandaloneMemoryStore } from './memory-store'

/**
 * @example
 * describe('standalone Discord chat runtime config', () => {})
 */
describe('standalone Discord chat runtime config', () => {
  /**
   * @example
   * it('resolves OpenAI-compatible settings without AIRI desktop config', () => {})
   */
  it('resolves OpenAI-compatible settings without AIRI desktop config', () => {
    const config = resolveStandaloneChatRuntimeConfig({
      AIRI_DISCORD_HISTORY_LIMIT: '200',
      AIRI_DISCORD_MODEL_TIMEOUT_MS: '999999',
      AIRI_DISCORD_SYSTEM_PROMPT: ' Custom AIRI ',
      OPENAI_API_BASE_URL: ' https://example.test/v1 ',
      OPENAI_API_KEY: ' test-key ',
      OPENAI_MODEL: ' test-model ',
      OPENAI_TEMPERATURE: '3',
      AIRI_DISCORD_CHARACTER_CARD_JSON: JSON.stringify({
        name: 'mika',
        description: 'Custom card description.',
      }),
    })

    expect(config.apiKey).toBe('test-key')
    expect(config.baseURL).toBe('https://example.test/v1')
    expect(config.model).toBe('test-model')
    expect(config.systemPrompt).toBe('Custom AIRI')
    expect(config.maxHistoryMessages).toBe(80)
    expect(config.modelRequestTimeoutMs).toBe(300000)
    expect(config.temperature).toBe(2)
    expect(config.characterCard?.name).toBe('mika')
    expect(config.characterCard?.description).toBe('Custom card description.')
  })

  /**
   * @example
   * it('resolves DeepSeek-specific settings with the official OpenAI-compatible base URL', () => {})
   */
  it('resolves DeepSeek-specific settings with the official OpenAI-compatible base URL', () => {
    const config = resolveStandaloneChatRuntimeConfig({
      DEEPSEEK_API_KEY: ' deepseek-key ',
      DEEPSEEK_MODEL: ' deepseek-v4-flash ',
    })

    expect(config.apiKey).toBe('deepseek-key')
    expect(config.baseURL).toBe('https://api.deepseek.com')
    expect(config.model).toBe('deepseek-v4-flash')
    expect(config.modelRequestTimeoutMs).toBe(90000)
  })

  /**
   * @example
   * it('lets explicit OpenAI-compatible settings override DeepSeek aliases', () => {})
   */
  it('lets explicit OpenAI-compatible settings override DeepSeek aliases', () => {
    const config = resolveStandaloneChatRuntimeConfig({
      DEEPSEEK_API_BASE_URL: 'https://api.deepseek.com',
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_MODEL: 'deepseek-v4-flash',
      OPENAI_API_BASE_URL: 'https://proxy.example.test/v1',
      OPENAI_API_KEY: 'proxy-key',
      OPENAI_MODEL: 'proxy-model',
    })

    expect(config.apiKey).toBe('proxy-key')
    expect(config.baseURL).toBe('https://proxy.example.test/v1')
    expect(config.model).toBe('proxy-model')
  })

  /**
   * @example
   * it('requires model credentials in standalone mode', () => {})
   */
  it('requires model credentials in standalone mode', () => {
    expect(() => resolveStandaloneChatRuntimeConfig({
      OPENAI_MODEL: 'test-model',
    })).toThrow('OPENAI_API_KEY or DEEPSEEK_API_KEY is required')

    expect(() => resolveStandaloneChatRuntimeConfig({
      OPENAI_API_KEY: 'test-key',
    })).toThrow('OPENAI_MODEL or DEEPSEEK_MODEL is required')
  })

  /**
   * @example
   * it('keeps history limits bounded', () => {})
   */
  it('keeps history limits bounded', () => {
    expect(normalizeStandaloneHistoryLimit(undefined)).toBe(24)
    expect(normalizeStandaloneHistoryLimit('1')).toBe(2)
    expect(normalizeStandaloneHistoryLimit('200')).toBe(80)
  })
})

/**
 * @example
 * describe('standalone chat runtime', () => {})
 */
describe('standalone chat runtime', () => {
  /**
   * @example
   * it('expires idle session history and keeps the most recent bounded sessions', async () => {})
   */
  it('expires idle session history and keeps the most recent bounded sessions', async () => {
    let now = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'reply' }), undefined, {
      maxSessionHistories: 2,
      now: () => now,
      sessionIdleTtlMs: 100,
    })

    const reply = (sessionId: string) => runtime.reply({
      channelId: sessionId,
      directMessage: true,
      displayName: 'Owen',
      sessionId,
      text: 'hello',
    })

    await reply('session-1')
    now = 10
    await reply('session-2')
    now = 20
    await reply('session-3')

    // ROOT CAUSE:
    //
    // Each unique Discord scope previously remained in historyBySessionId forever,
    // so a long-running public bot grew with every user/channel combination.
    expect(runtime.getSessionMessages('session-1')).toEqual([])
    expect(runtime.getSessionMessages('session-2')).toHaveLength(2)
    expect(runtime.getSessionMessages('session-3')).toHaveLength(2)

    now = 111
    await reply('session-4')
    expect(runtime.getSessionMessages('session-2')).toEqual([])
    expect(runtime.getSessionMessages('session-3')).toHaveLength(2)
    expect(runtime.getSessionMessages('session-4')).toHaveLength(2)
  })

  /**
   * @example
   * The same exact session cannot retain history after its own idle TTL elapses.
   */
  it('expires the returning exact session before provider composition for Discord audit D-014', async () => {
    // ROOT CAUSE:
    //
    // reply() always passed the returning session as protected to pruning. That
    // prevented its own idle history and language state from ever expiring; only
    // traffic from a different session could remove it.
    //
    // An inactive returning session must expire before its next provider prompt,
    // while an already active FIFO chain remains protected until it settles.
    let now = 0
    const providerMessages: Message[][] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      providerMessages.push(input.messages)
      return { text: 'SENTINEL_ASSISTANT_REPLY' }
    }, undefined, {
      now: () => now,
      sessionIdleTtlMs: 100,
    })
    const turn = (text: string) => ({
      channelId: 'general',
      directMessage: false,
      displayName: 'Avery',
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: 'guild-1-general-user-a',
      text,
      userId: 'user-a',
    })

    await runtime.reply(turn('SENTINEL_A_OLD'))
    now = 101
    await runtime.reply(turn('SENTINEL_A_NEW'))

    // @example
    expect(providerMessages[1]?.some(message => String(message.content).includes('SENTINEL_A_OLD'))).toBe(false)
    // @example
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toHaveLength(2)
  })

  /**
   * @example
   * Concurrent completions cannot leave more inactive histories than the configured cap.
   */
  it('prunes concurrent completed exact sessions without another ingress for Discord audit D-014', async () => {
    // ROOT CAUSE:
    //
    // Each completion pruned while every replyQueue tail was still registered,
    // so all concurrent sessions were protected. Tail cleanup removed the queue
    // records but never ran retention again, leaving the hard cap exceeded forever.
    //
    // The final tail owner must prune after unregistering itself; other active
    // sessions remain protected and the last completion restores the hard bound.
    let releaseProviders!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProviders = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      await providerGate
      return { text: 'reply' }
    }, undefined, {
      maxConcurrentModelRequests: 3,
      maxSessionHistories: 2,
    })
    const reply = (sessionId: string) => runtime.reply({
      channelId: sessionId,
      directMessage: true,
      displayName: sessionId,
      sessionId,
      text: `hello-${sessionId}`,
    })

    const replies = [reply('session-a'), reply('session-b'), reply('session-c')]
    await Promise.resolve()
    releaseProviders()
    await Promise.all(replies)
    await Promise.resolve()

    const retainedCount = ['session-a', 'session-b', 'session-c']
      .filter(sessionId => runtime.getSessionMessages(sessionId).length > 0)
      .length
    // @example
    expect(retainedCount).toBe(2)
  })

  /**
   * @example
   * it('serializes model generation and history updates within one Discord session', async () => {})
   */
  it('serializes model generation and history updates within one Discord session', async () => {
    const capturedMessages: Message[][] = []
    let activeGenerations = 0
    let maximumActiveGenerations = 0
    let releaseFirstGeneration!: () => void
    const firstGenerationGate = new Promise<void>((resolve) => {
      releaseFirstGeneration = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      const callIndex = capturedMessages.length
      capturedMessages.push(input.messages)
      activeGenerations += 1
      maximumActiveGenerations = Math.max(maximumActiveGenerations, activeGenerations)
      if (callIndex === 0)
        await firstGenerationGate

      activeGenerations -= 1
      return { text: `reply-${callIndex + 1}` }
    })

    const firstReply = runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'first',
    })
    for (let index = 0; index < 10 && capturedMessages.length < 1; index += 1)
      await Promise.resolve()
    const secondReply = runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'second',
    })
    await Promise.resolve()

    // ROOT CAUSE:
    //
    // Both turns previously read the same history and entered the provider concurrently.
    // Whichever request finished last then overwrote the other turn's history update.
    expect(capturedMessages).toHaveLength(1)
    expect(maximumActiveGenerations).toBe(1)

    releaseFirstGeneration()

    expect(await firstReply).toBe('reply-1')
    expect(await secondReply).toBe('reply-2')
    expect(capturedMessages[1]).toContainEqual({ content: 'reply-1', role: 'assistant' })
    expect(runtime.getSessionMessages('discord-dm-user-1')).toHaveLength(4)
  })

  /**
   * @example
   * it('keeps independent Discord sessions concurrent', async () => {})
   */
  it('keeps independent Discord sessions concurrent', async () => {
    let activeGenerations = 0
    let maximumActiveGenerations = 0
    let releaseGenerations!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGenerations = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      activeGenerations += 1
      maximumActiveGenerations = Math.max(maximumActiveGenerations, activeGenerations)
      await generationGate
      activeGenerations -= 1
      return { text: 'reply' }
    })

    const replies = [
      runtime.reply({
        channelId: 'dm-channel-1',
        directMessage: true,
        displayName: 'Owen',
        sessionId: 'discord-dm-user-1',
        text: 'hello',
      }),
      runtime.reply({
        channelId: 'dm-channel-2',
        directMessage: true,
        displayName: 'Avery',
        sessionId: 'discord-dm-user-2',
        text: 'hello',
      }),
    ]
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(maximumActiveGenerations).toBe(2)

    releaseGenerations()
    expect(await Promise.all(replies)).toEqual(['reply', 'reply'])
  })

  /**
   * @example
   * it('continues the prior clear language for an ambiguous short message', async () => {})
   */
  it('continues the prior clear language for an ambiguous short message', async () => {
    const capturedMessages: Message[][] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      capturedMessages.push(input.messages)
      return { text: 'reply' }
    })
    const turn = (text: string) => ({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text,
      userId: 'user-1',
    })

    await runtime.reply(turn('你好，今天怎么样？'))
    await runtime.reply(turn('ok'))

    const secondLanguageInstruction = capturedMessages[1].find(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes('Language instruction'))
    const secondLanguageInstructionText = secondLanguageInstruction?.content
    expect(typeof secondLanguageInstructionText).toBe('string')
    if (typeof secondLanguageInstructionText !== 'string')
      throw new Error('Expected the language instruction to be text.')
    expect(secondLanguageInstructionText).toContain('language-ambiguous')
    expect(secondLanguageInstructionText).toContain('most recent unambiguous message')
    expect(secondLanguageInstructionText).not.toContain('short English greetings')
  })

  /**
   * @example
   * it('isolates exact per-user guild history and queues for Discord audit D-014', async () => {})
   */
  it('isolates exact per-user guild history and queues for Discord audit D-014', async () => {
    // ROOT CAUSE:
    //
    // Guild turns were aliased to a guild/channel conversation id that dropped
    // the user. Same-channel users therefore shared provider history and one
    // FIFO chain. Canonical `turn.sessionId` now owns both history and queue.
    let releaseAFirst!: () => void
    let releaseBFirst!: () => void
    const aFirstGeneration = new Promise<void>((resolve) => {
      releaseAFirst = resolve
    })
    const bFirstGeneration = new Promise<void>((resolve) => {
      releaseBFirst = resolve
    })
    const providerMessagesByTurn = new Map<string, Message[]>()
    const providerStartOrder: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 20,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      const currentUserMessage = input.messages.at(-1)?.content
      if (typeof currentUserMessage !== 'string')
        throw new Error('Expected the current Discord user message to be text.')

      const turnText = ['SENTINEL_A_FIRST', 'SENTINEL_A_SECOND', 'SENTINEL_B_FIRST', 'SENTINEL_B_SECOND']
        .find(candidate => currentUserMessage.includes(candidate))
      if (!turnText)
        throw new Error('Expected a synthetic Discord audit turn sentinel.')

      providerStartOrder.push(turnText)
      providerMessagesByTurn.set(turnText, input.messages)
      if (turnText === 'SENTINEL_A_FIRST')
        await aFirstGeneration
      if (turnText === 'SENTINEL_B_FIRST')
        await bFirstGeneration

      return { text: `reply-${turnText}` }
    })
    const guildTurn = (userId: string, displayName: string, text: string) => ({
      channelId: 'general',
      directMessage: false,
      displayName,
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: `guild-1-general-${userId}`,
      text,
      userId,
    })

    const aFirstReply = runtime.reply(guildTurn('user-a', 'Avery', 'SENTINEL_A_FIRST'))
    for (let attempt = 0; attempt < 10 && providerStartOrder.length < 1; attempt += 1)
      await Promise.resolve()

    const bFirstReply = runtime.reply(guildTurn('user-b', 'Blake', 'SENTINEL_B_FIRST'))
    const aSecondReply = runtime.reply(guildTurn('user-a', 'Avery', 'SENTINEL_A_SECOND'))
    for (let attempt = 0; attempt < 10 && providerStartOrder.length < 2; attempt += 1)
      await Promise.resolve()

    const startsBeforeACompletes = [...providerStartOrder]
    releaseBFirst()
    releaseAFirst()
    await Promise.all([aFirstReply, bFirstReply, aSecondReply])
    await runtime.reply(guildTurn('user-b', 'Blake', 'SENTINEL_B_SECOND'))

    const aSecondMessages = providerMessagesByTurn.get('SENTINEL_A_SECOND') ?? []
    const bSecondMessages = providerMessagesByTurn.get('SENTINEL_B_SECOND') ?? []

    // ROOT CAUSE:
    //
    // Guild turns previously replaced the canonical user-scoped session id with one
    // guild/channel conversation id. That merged history and one FIFO queue for every
    // user in the channel, leaking prior prompts and creating cross-user head-of-line blocking.
    //
    // Before: guild-1/general/user-a -> discord-public-guild-guild-1-channel-general
    //         guild-1/general/user-b -> discord-public-guild-guild-1-channel-general
    //
    // We fixed this by using turn.sessionId as the short-term history and queue key.
    // After:  guild-1/general/user-a -> guild-1-general-user-a
    //         guild-1/general/user-b -> guild-1-general-user-b
    /**
     * @example
     * expect(startsBeforeACompletes).toEqual(['SENTINEL_A_FIRST', 'SENTINEL_B_FIRST'])
     */
    expect(startsBeforeACompletes).toEqual(['SENTINEL_A_FIRST', 'SENTINEL_B_FIRST'])
    /**
     * @example
     * expect(aSecondMessages).toContainEqual({ content: 'reply-SENTINEL_A_FIRST', role: 'assistant' })
     */
    expect(aSecondMessages).toContainEqual({ content: 'reply-SENTINEL_A_FIRST', role: 'assistant' })
    /**
     * @example
     * expect(aSecondMessages.some(message => String(message.content).includes('SENTINEL_B_FIRST'))).toBe(false)
     */
    expect(aSecondMessages.some(message => String(message.content).includes('SENTINEL_B_FIRST'))).toBe(false)
    /**
     * @example
     * expect(bSecondMessages).toContainEqual({ content: 'reply-SENTINEL_B_FIRST', role: 'assistant' })
     */
    expect(bSecondMessages).toContainEqual({ content: 'reply-SENTINEL_B_FIRST', role: 'assistant' })
    /**
     * @example
     * expect(bSecondMessages.some(message => String(message.content).includes('SENTINEL_A_FIRST'))).toBe(false)
     */
    expect(bSecondMessages.some(message => String(message.content).includes('SENTINEL_A_FIRST'))).toBe(false)
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toHaveLength(4)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toHaveLength(4)
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(4)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(4)

    runtime.clearSession('guild-1-general-user-a')
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(4)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(4)
  })

  /**
   * @example
   * it('clears, expires, and caps exact guild sessions independently for Discord audit D-014', async () => {})
   */
  it('clears, expires, and caps exact guild sessions independently for Discord audit D-014', async () => {
    // ROOT CAUSE:
    //
    // Clear/get used the canonical exact session while retention bookkeeping
    // used the shared guild/channel alias. TTL/LRU cleanup could therefore miss
    // or remove the wrong user's history. Every lifecycle map now uses sessionId.
    let now = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'reply' }), undefined, {
      maxSessionHistories: 2,
      now: () => now,
      sessionIdleTtlMs: 100,
    })
    const guildTurn = (userId: string) => ({
      channelId: 'general',
      directMessage: false,
      displayName: userId,
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: `guild-1-general-${userId}`,
      text: `hello from ${userId}`,
      userId,
    })

    await runtime.reply(guildTurn('user-a'))
    now = 10
    await runtime.reply(guildTurn('user-b'))
    runtime.clearSession('guild-1-general-user-a')

    // ROOT CAUSE:
    //
    // The guild/channel alias used by history and queue state did not match the canonical
    // session id accepted by clearSession and exposed by getSessionMessages. Exact-user
    // clear, idle expiry, and bounded-history behavior therefore operated on inconsistent keys.
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(2)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(2)

    now = 20
    await runtime.reply(guildTurn('user-a'))
    now = 30
    await runtime.reply(guildTurn('user-c'))

    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-b')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-b')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toHaveLength(2)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toHaveLength(2)
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-c')).toHaveLength(2)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-c')).toHaveLength(2)

    now = 131
    await runtime.reply(guildTurn('user-d'))

    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-c')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-c')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-d')).toHaveLength(2)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-d')).toHaveLength(2)
  })

  /**
   * @example
   * it('does not resurrect a cleared active exact session for Discord audit D-014', async () => {})
   */
  it('does not resurrect a cleared active exact session for Discord audit D-014', async () => {
    // ROOT CAUSE:
    //
    // An active turn retained its pre-clear history snapshot and had no exact-session
    // lifecycle identity. After clearSession deleted the maps, a late provider result
    // wrote that stale snapshot back and also allowed later memory side effects.
    //
    // Before: clearSession(A) -> delete A maps -> A provider resolves -> set A history
    //
    // We fixed this by aborting and invalidating only A's captured lifecycle identity.
    // After:  clearSession(A) -> invalidate A turn -> late A result has no side effects
    let markAStarted!: () => void
    let releaseA!: () => void
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve
    })
    const aProvider = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      const currentMessage = input.messages.at(-1)?.content
      if (typeof currentMessage === 'string' && currentMessage.includes('SENTINEL_A_ACTIVE')) {
        markAStarted()
        await aProvider
        return { text: 'reply-a' }
      }

      return { text: 'reply-b' }
    })
    const guildTurn = (userId: string, text: string) => ({
      channelId: 'general',
      directMessage: false,
      displayName: userId,
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: `guild-1-general-${userId}`,
      text,
      userId,
    })

    const aReply = runtime.reply(guildTurn('user-a', 'SENTINEL_A_ACTIVE'))
    await aStarted
    await runtime.reply(guildTurn('user-b', 'SENTINEL_B_COMPLETE'))

    runtime.clearSession('guild-1-general-user-a')
    releaseA()

    /**
     * @example
     * await expect(aReply).rejects.toThrow('Standalone chat session was cleared.')
     */
    await expect(aReply).rejects.toThrow('Standalone chat session was cleared.')
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
     */
    expect(runtime.getSessionMessages('guild-1-general-user-a')).toEqual([])
    /**
     * @example
     * expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(2)
     */
    expect(runtime.getSessionMessages('guild-1-general-user-b')).toHaveLength(2)
  })

  /**
   * @example
   * it('aborts model generation after the configured timeout', async () => {})
   */
  it('aborts model generation after the configured timeout', async () => {
    let providerSignalAborted = false
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      modelRequestTimeoutMs: 20,
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      return await new Promise((_, reject) => {
        input.abortSignal?.addEventListener('abort', () => {
          providerSignalAborted = true
          reject(input.abortSignal?.reason)
        }, { once: true })
      })
    })

    const result = await Promise.race([
      runtime.reply({
        channelId: 'dm-channel',
        directMessage: true,
        displayName: 'Owen',
        sessionId: 'discord-dm-user-1',
        text: 'hello',
      }).then(
        () => 'unexpected success',
        error => errorMessageFrom(error) ?? 'unknown error',
      ),
      new Promise<string>(resolve => setTimeout(resolve, 100, 'request remained pending')),
    ])

    // ROOT CAUSE:
    //
    // generateText previously received no AbortSignal, so a stalled provider request
    // occupied its Discord turn forever and prevented deterministic recovery.
    expect(result).toBe('Standalone chat provider timed out.')
    expect(providerSignalAborted).toBe(true)
    expect(runtime.getSessionMessages('discord-dm-user-1')).toEqual([])
  })

  /**
   * @example
   * it('continues a session queue after a timed-out model turn', async () => {})
   */
  it('continues a session queue after a timed-out model turn', async () => {
    let generationCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      modelRequestTimeoutMs: 20,
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      generationCalls += 1
      if (generationCalls > 1)
        return { text: 'recovered reply' }

      return await new Promise((_, reject) => {
        input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), { once: true })
      })
    })

    const firstReply = runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'first',
    })
    const secondReply = runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'second',
    })

    await expect(firstReply).rejects.toThrow('Standalone chat provider timed out.')
    await expect(secondReply).resolves.toBe('recovered reply')
    expect(generationCalls).toBe(2)
    expect(runtime.getSessionMessages('discord-dm-user-1')).toHaveLength(2)
  })

  /**
   * @example
   * it('rejects model output published after the voice admission deadline for Discord audit D-018', async () => {})
   */
  it('rejects model output published after the voice admission deadline for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let providerSignal: AbortSignal | undefined
    let resolveProvider = (_result: { text: string }) => {}
    const rememberTurn = vi.fn(async () => {})
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      modelRequestTimeoutMs: 30_000,
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      providerSignal = input.abortSignal
      return new Promise<{ text: string }>((resolve) => {
        resolveProvider = resolve
      })
    }, {
      buildPrompt: async () => '',
      rememberTurn,
    })

    const reply = runtime.reply({
      channelId: 'voice-channel',
      directMessage: false,
      displayName: 'Synthetic speaker',
      guildId: 'synthetic-guild',
      sessionId: 'discord-guild-synthetic-guild-channel-voice-channel-user-synthetic-user',
      text: 'synthetic voice transcript',
      userId: 'synthetic-user',
    }, { deadlineAt: 1_001 })
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(1_002)
    resolveProvider({ text: 'must not enter history after deadline' })
    const outcome = await reply.then(
      value => value,
      (error: unknown) => error,
    )
    const history = runtime.getSessionMessages('discord-guild-synthetic-guild-channel-voice-channel-user-synthetic-user')
    const timerCount = vi.getTimerCount()
    await runtime.stop()
    vi.useRealTimers()

    // ROOT CAUSE:
    //
    // Classic voice carried an absolute admission deadline through STT, but
    // standalone chat replaced it with a fresh phase timer. A model continuation
    // could therefore win the timer race after the turn deadline and persist
    // assistant history/memory before the outer voice gate discarded playback.
    // @example
    expect(outcome).toMatchObject({ kind: 'timeout' })
    // @example
    expect(history).toEqual([])
    // @example
    expect(rememberTurn).not.toHaveBeenCalled()
    // @example
    expect(providerSignal?.aborted).toBe(true)
    // @example
    expect(timerCount).toBe(0)
  })

  /**
   * @example
   * it('bounds ignored text-provider aborts across restart without blocking another participant for Discord audit D-018', async () => {})
   */
  it('bounds ignored text-provider aborts across restart without blocking another participant for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const releaseProviderTasks: Array<() => void> = []
    let recoverUserA = false
    const generator = vi.fn(async (input: { messages: Message[] }) => {
      const content = JSON.stringify(input.messages)
      if (content.includes('SENTINEL_USER_B') || recoverUserA)
        return { text: 'completed reply' }
      return new Promise<{ text: string }>((resolve) => {
        releaseProviderTasks.push(() => resolve({ text: 'discarded late reply' }))
      })
    })
    const createRuntime = () => new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      modelRequestTimeoutMs: 10,
      systemPrompt: 'You are AIRI.',
    }, generator)
    const turn = (userId: string, text: string) => ({
      channelId: 'voice-channel',
      directMessage: false,
      displayName: userId,
      guildId: 'synthetic-guild',
      sessionId: `synthetic-guild-voice-channel-${userId}`,
      text,
      userId,
    })
    const firstRuntime = createRuntime()
    const retainedOutcomes: string[] = []
    for (let index = 0; index < 8; index += 1) {
      const reply = firstRuntime.reply(turn('user-a', `SENTINEL_USER_A_${index}`), {
        deadlineAt: Date.now() + 10,
      }).then(
        () => 'resolved',
        (error: unknown) => error instanceof StandaloneChatRuntimeError ? error.kind : 'rejected',
      )
      await vi.advanceTimersByTimeAsync(10)
      retainedOutcomes.push(await reply)
    }
    await firstRuntime.stop()

    const replacementRuntime = createRuntime()
    const deniedReplacement = replacementRuntime.reply(turn('user-a', 'SENTINEL_USER_A_REPLACEMENT')).then(
      () => 'resolved',
      (error: unknown) => error instanceof StandaloneChatRuntimeError ? error.kind : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    const userB = replacementRuntime.reply(turn('user-b', 'SENTINEL_USER_B'))
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // The request timeout previously stopped accounting when the wrapper race
    // settled. A provider ignoring AbortSignal could therefore leave unbounded
    // raw tasks across runtime restarts and exhaust unrelated users. The provider
    // boundary now retains raw tasks through true settlement, caps each stable
    // participant, and reserves process capacity for a new participant.
    // @example
    expect(retainedOutcomes).toEqual(Array.from({ length: 8 }).fill('timeout'))
    // @example
    await expect(deniedReplacement).resolves.toBe('queue-full')
    // @example
    await expect(userB).resolves.toBe('completed reply')
    // @example
    expect(generator).toHaveBeenCalledTimes(9)

    for (const release of releaseProviderTasks)
      release()
    await vi.advanceTimersByTimeAsync(0)
    recoverUserA = true
    // @example
    await expect(replacementRuntime.reply(turn('user-a', 'SENTINEL_USER_A_RECOVERED'))).resolves.toBe('completed reply')
    await replacementRuntime.stop()
    // @example
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('releases a voice queue when memory ignores cancellation for Discord audit D-018', async () => {})
   */
  it('releases a voice queue when memory ignores cancellation for Discord audit D-018', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    let releaseLateMemory = () => {}
    let memoryCalls = 0
    let generatorCalls = 0
    const lateMemory = new Promise<string>((resolve) => {
      releaseLateMemory = () => resolve('discarded late memory prompt')
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generatorCalls += 1
      return { text: 'user B completed' }
    }, {
      buildPrompt: async (turn) => {
        memoryCalls += 1
        return turn.userId === 'user-a' ? lateMemory : ''
      },
    })
    const turn = (userId: string) => ({
      channelId: 'voice-channel',
      directMessage: false,
      displayName: userId,
      guildId: 'synthetic-guild',
      sessionId: `synthetic-guild-voice-channel-${userId}`,
      text: `synthetic ${userId} turn`,
      userId,
    })

    const userA = runtime.reply(turn('user-a'), { deadlineAt: 2_010 }).then(
      () => 'resolved',
      (error: unknown) => error instanceof StandaloneChatRuntimeError ? error.kind : 'rejected',
    )
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    const userAOutcome = await userA
    const userB = await runtime.reply(turn('user-b'))
    let stopSettled = false
    await runtime.stop().then(() => {
      stopSettled = true
    })

    // ROOT CAUSE:
    //
    // Chat awaited memory providers directly. A buildPrompt implementation that
    // ignored AbortSignal retained the exact-session FIFO forever and made stop
    // wait for unrelated external work. The runtime now owns a cancellation race,
    // observes the raw task, and retains it only in a bounded fairness registry.
    // @example
    expect(userAOutcome).toBe('timeout')
    // @example
    expect(userB).toBe('user B completed')
    // @example
    expect(memoryCalls).toBe(2)
    // @example
    expect(generatorCalls).toBe(1)
    // @example
    expect(stopSettled).toBe(true)

    releaseLateMemory()
    await vi.advanceTimersByTimeAsync(0)
    // @example
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  /**
   * @example
   * it('retries one transient provider failure and preserves one visible turn', async () => {})
   */
  it('retries one transient provider failure and preserves one visible turn', async () => {
    let generationCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generationCalls += 1
      if (generationCalls === 1) {
        const error = new Error('provider temporarily unavailable')
        Reflect.set(error, 'statusCode', 503)
        throw error
      }

      return { text: 'recovered reply' }
    }, undefined, {
      modelRetryDelayMs: 0,
    })

    await expect(runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })).resolves.toBe('recovered reply')
    expect(generationCalls).toBe(2)
    expect(runtime.getSessionMessages('discord-dm-user-1')).toHaveLength(2)
  })

  /**
   * @example
   * it('does not retry authentication failures', async () => {})
   */
  it('does not retry authentication failures', async () => {
    let generationCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generationCalls += 1
      const error = new Error('invalid API key')
      Reflect.set(error, 'statusCode', 401)
      throw error
    }, undefined, {
      modelRetryDelayMs: 0,
    })

    await expect(runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })).rejects.toThrow('Standalone chat provider rejected its configuration.')
    expect(generationCalls).toBe(1)
  })

  /**
   * @example
   * it('stops after one retry when a transient provider failure persists', async () => {})
   */
  it('stops after one retry when a transient provider failure persists', async () => {
    let generationCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generationCalls += 1
      const error = new Error('provider temporarily unavailable')
      Reflect.set(error, 'statusCode', 502)
      throw error
    }, undefined, {
      modelRetryDelayMs: 0,
    })

    await expect(runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })).rejects.toThrow('Standalone chat provider is temporarily unavailable.')
    expect(generationCalls).toBe(2)
  })

  /**
   * @example
   * it('sends Discord speaker context and keeps bounded session history', () => {})
   */
  it('sends Discord speaker context and keeps bounded session history', async () => {
    const capturedMessages: Message[][] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      capturedMessages.push(input.messages)
      return { text: `reply-${capturedMessages.length}` }
    })

    const firstReply = await runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })
    const secondReply = await runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'again',
    })
    await runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'third',
    })

    expect(firstReply).toBe('reply-1')
    expect(secondReply).toBe('reply-2')
    expect(capturedMessages[0][0].role).toBe('system')
    expect(capturedMessages[0][0].content).toContain('You are AIRI.')
    expect(capturedMessages[0][0].content).toContain('Active AIRI character card:')
    expect(capturedMessages[0][0].content).toContain('Discord hard safety rules for this turn:')
    expect(capturedMessages[0][0].content).toContain('Match the language of the current user message by default.')
    expect(capturedMessages[0][0].content).toContain('Short-term conversation history is limited to this exact Discord session (guild/channel/user for server messages, user for DMs); never use another speaker\'s turns as context.')
    expect(capturedMessages[0][1]).toEqual({
      content: [
        'Language instruction for this exact Discord turn:',
        'The current user message is primarily English or another Latin-script language. Reply in the same language as the current user message. For short English greetings like "hi" or "hello", reply in English.',
        'This instruction overrides any character-card or history instruction that says to default to Chinese.',
        'If the user explicitly asks for a different reply language, follow that explicit request.',
      ].join('\n'),
      role: 'system',
    })
    expect(capturedMessages[0][2]).toEqual({ role: 'user', content: '(From Discord user Owen in direct message channel dm-channel): hello' })
    expect(capturedMessages[1]).toHaveLength(5)
    expect(runtime.getSessionMessages('discord-dm-user-1')).toHaveLength(4)
  })

  /**
   * @example
   * it('stores user-visible Discord replies without AIRI control tags', async () => {})
   */
  it('stores user-visible Discord replies without AIRI control tags', async () => {
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      return { text: '<|ACT:"emotion":"happy"|>你好呀<|DELAY:1|>' }
    })

    const reply = await runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })

    expect(reply).toBe('你好呀')
    expect(runtime.getSessionMessages('discord-dm-user-1').at(-1)).toEqual({
      content: '你好呀',
      role: 'assistant',
    })
  })

  /**
   * @example
   * it('blocks model output containing internal prompt markers', async () => {})
   */
  it('blocks model output containing internal prompt markers', async () => {
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'Active AIRI character card:\nsecret instructions' }))

    await expect(runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'hello',
    })).rejects.toThrow('output privacy guard')
    expect(runtime.getSessionMessages('discord-dm-user-1')).toEqual([])
  })

  /**
   * @example
   * it('bounds global model concurrency and rejects an overflowing queue', async () => {})
   */
  it('bounds global model concurrency and rejects an overflowing queue', async () => {
    let releaseFirst: (() => void) | undefined
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let generatorCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generatorCalls += 1
      if (generatorCalls === 1)
        await firstRequest
      return { text: `reply-${generatorCalls}` }
    }, undefined, {
      maxConcurrentModelRequests: 1,
      maxQueuedModelRequests: 1,
    })
    const turn = (sessionId: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: 'Owen',
      sessionId,
      text: 'hello',
      userId: sessionId,
    })

    const firstReply = runtime.reply(turn('session-1'))
    await Promise.resolve()
    const secondReply = runtime.reply(turn('session-2'))
    const thirdReply = runtime.reply(turn('session-3'))
    await expect(thirdReply).rejects.toThrow('queue is full')
    expect(generatorCalls).toBe(1)

    releaseFirst?.()
    await expect(firstReply).resolves.toBe('reply-1')
    await expect(secondReply).resolves.toBe('reply-2')
  })

  /**
   * @example
   * it('returns visible replies before deferred memory extraction for Discord audit D-024', async () => {})
   */
  it('returns visible replies before deferred memory extraction for Discord audit D-024', async () => {
    let releaseMemory: (() => void) | undefined
    let markMemoryStarted: (() => void) | undefined
    const memoryStarted = new Promise<void>((resolve) => {
      markMemoryStarted = resolve
    })
    const memoryBlocked = new Promise<void>((resolve) => {
      releaseMemory = resolve
    })
    let generatorCalls = 0
    let memoryCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      generatorCalls += 1
      return { text: `reply-${generatorCalls}` }
    }, {
      buildPrompt: async () => '',
      rememberTurn: async () => {
        memoryCalls += 1
        if (memoryCalls === 1) {
          markMemoryStarted?.()
          await memoryBlocked
        }
      },
    }, {
      maxConcurrentModelRequests: 1,
      maxQueuedModelRequests: 1,
    })
    const turn = (sessionId: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: 'Owen',
      sessionId,
      text: 'hello',
      userId: sessionId,
    })

    let firstReplySettled = false
    const firstReply = runtime.reply(turn('session-1')).finally(() => {
      firstReplySettled = true
    })
    await memoryStarted
    const secondReply = runtime.reply(turn('session-2'))
    for (let index = 0; index < 20; index += 1)
      await Promise.resolve()

    const generatorCallsBeforeMemoryRelease = generatorCalls
    const firstReplySettledBeforeMemoryRelease = firstReplySettled
    releaseMemory?.()
    await expect(firstReply).resolves.toBe('reply-1')
    await expect(secondReply).resolves.toBe('reply-2')

    // ROOT CAUSE:
    //
    // generateReply awaited rememberTurn inside the visible provider semaphore
    // before committing history or resolving the Discord reply. A deferred memory
    // extractor therefore delayed an already-safe reply and blocked an unrelated
    // session's visible generation behind the same global model slot.
    //
    // Before: visible model -> await memory in visible slot -> history/reply.
    // After:  visible model -> commit history/reply -> bounded memory queue.
    // @example
    expect(firstReplySettledBeforeMemoryRelease).toBe(true)
    // @example
    expect(generatorCallsBeforeMemoryRelease).toBe(2)
    // @example
    expect(memoryCalls).toBe(2)
    await runtime.stop()
  })

  /**
   * @example
   * it('reserves memory running capacity across principals for Discord audit D-024', async () => {})
   */
  it('reserves memory running capacity across principals for Discord audit D-024', async () => {
    let releaseUserA = () => {}
    const blockedUserA = new Promise<void>((resolve) => {
      releaseUserA = resolve
    })
    const memoryStarts: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        memoryStarts.push(turn.sessionId)
        if (turn.userId === 'user-a')
          await blockedUserA
      },
    }, {
      maxConcurrentMemoryJobs: 2,
      maxMemoryJobsPerPrincipal: 4,
      maxMemoryJobsPerSession: 2,
      maxPendingMemoryJobs: 8,
    })
    const turn = (sessionId: string, userId: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: userId,
      sessionId,
      text: 'synthetic fact',
      userId,
    })

    await runtime.reply(turn('session-a-1', 'user-a'))
    await runtime.reply(turn('session-a-2', 'user-a'))
    await runtime.reply(turn('session-b', 'user-b'))
    for (let index = 0; index < 20; index += 1)
      await Promise.resolve()
    const userBStartedBeforeUserARelease = memoryStarts.includes('session-b')
    releaseUserA()
    await vi.waitFor(() => {
      expect(memoryStarts).toContain('session-a-2')
    })
    await runtime.stop()

    // ROOT CAUSE:
    //
    // A global-only background semaphore allowed one principal to occupy every
    // memory worker through several exact sessions. Per-principal pending limits
    // bounded storage but did not preserve running capacity for another user.
    // The memory scheduler now caps active work per stable principal and grants
    // an eligible waiter without waiting behind an ineligible same-user job.
    // @example
    expect(userBStartedBeforeUserARelease).toBe(true)
  })

  /**
   * @example
   * it('skips a cancelled memory waiter when granting another principal for Discord audit D-024', async () => {})
   */
  it('skips a cancelled memory waiter when granting another principal for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const releaseRawProviders: Array<() => void> = []
    const starts: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        starts.push(turn.sessionId)
        if (turn.userId === 'user-b')
          return
        await new Promise<void>((resolve) => {
          releaseRawProviders.push(resolve)
        })
      },
    }, {
      maxConcurrentMemoryJobs: 2,
      maxConcurrentMemoryJobsPerPrincipal: 1,
      maxMemoryJobsPerPrincipal: 4,
      maxMemoryJobsPerSession: 2,
      maxPendingMemoryJobs: 8,
    })
    const turn = (sessionId: string, userId: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: userId,
      sessionId,
      text: 'synthetic fact',
      userId,
    })
    const cancelledWaiter = new AbortController()

    await runtime.reply(turn('a-active', 'user-a'))
    await runtime.reply(turn('c-active', 'user-c'))
    await vi.waitFor(() => {
      expect(starts).toEqual(expect.arrayContaining(['a-active', 'c-active']))
    })
    await runtime.reply(turn('a-cancelled-waiter', 'user-a'), { abortSignal: cancelledWaiter.signal })
    await runtime.reply(turn('b-eligible-waiter', 'user-b'))
    cancelledWaiter.abort(new Error('synthetic cancellation'))
    runtime.clearMemorySession('a-active')
    await vi.waitFor(() => {
      expect(starts).toContain('b-eligible-waiter')
    })

    // ROOT CAUSE:
    //
    // A FIFO-only slot waiter list can retain an aborted or principal-ineligible
    // head and starve an eligible user. Cancellation now removes the exact waiter,
    // while slot release scans for the first still-eligible stable principal.
    // @example
    expect(starts).not.toContain('a-cancelled-waiter')
    await runtime.stop()
    for (const release of releaseRawProviders)
      release()
    warn.mockRestore()
  })

  /**
   * @example
   * it('commits history before reply while preserving memory FIFO for Discord audit D-024', async () => {})
   */
  it('commits history before reply while preserving memory FIFO for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseFirstMemory = () => {}
    let markFirstMemoryStarted = () => {}
    const firstMemoryStarted = new Promise<void>((resolve) => {
      markFirstMemoryStarted = resolve
    })
    const firstMemoryBlocked = new Promise<void>((resolve) => {
      releaseFirstMemory = resolve
    })
    const providerMessages: Message[][] = []
    const persistedTurns: string[] = []
    let generationCalls = 0
    let memoryCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      generationCalls += 1
      providerMessages.push(input.messages)
      return { text: `reply-${generationCalls}` }
    }, {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        memoryCalls += 1
        if (memoryCalls === 1) {
          markFirstMemoryStarted()
          await firstMemoryBlocked
        }
        persistedTurns.push(turn.text)
      },
    }, {
      maxConcurrentMemoryJobs: 2,
      maxMemoryJobsPerPrincipal: 4,
      maxMemoryJobsPerSession: 2,
      maxPendingMemoryJobs: 6,
    })
    const turn = (text: string) => ({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'User A',
      sessionId: 'dm-user-a',
      text,
      userId: 'user-a',
    })

    await expect(runtime.reply(turn('first fact'))).resolves.toBe('reply-1')
    await firstMemoryStarted
    const secondTurn = turn('second fact')
    await expect(runtime.reply(secondTurn)).resolves.toBe('reply-2')
    secondTurn.text = 'mutated after visible reply'
    await expect(runtime.reply(turn('third visible turn'))).resolves.toBe('reply-3')

    // ROOT CAUSE:
    //
    // The old exact-session reply tail included memory extraction, so the next
    // visible turn could neither start nor observe the prior assistant message.
    // History now commits before enqueue, while the independent memory tail keeps
    // accepted snapshots ordered and drops only the over-capacity memory job.
    // @example
    expect(memoryCalls).toBe(1)
    // @example
    expect(providerMessages[1]).toContainEqual({ content: 'reply-1', role: 'assistant' })
    // @example
    expect(runtime.getSessionMessages('dm-user-a')).toHaveLength(6)
    // @example
    expect(warn).toHaveBeenCalledWith(
      '[discord-bot:standalone] automatic memory job did not persist:',
      'queue-capacity',
    )

    releaseFirstMemory()
    await vi.waitFor(() => {
      expect(persistedTurns).toEqual(['first fact', 'second fact'])
    })
    await runtime.stop()
    warn.mockRestore()
  })

  /**
   * @example
   * it('bounds global and principal memory queues and recovers for Discord audit D-024', async () => {})
   */
  it('bounds global and principal memory queues and recovers for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseFirstMemory = () => {}
    let markFirstMemoryStarted = () => {}
    const firstMemoryStarted = new Promise<void>((resolve) => {
      markFirstMemoryStarted = resolve
    })
    const firstMemoryBlocked = new Promise<void>((resolve) => {
      releaseFirstMemory = resolve
    })
    let memoryCalls = 0
    const completed: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        memoryCalls += 1
        if (memoryCalls === 1) {
          markFirstMemoryStarted()
          await firstMemoryBlocked
        }
        completed.push(turn.sessionId)
      },
    }, {
      maxConcurrentMemoryJobs: 1,
      maxMemoryJobsPerPrincipal: 2,
      maxMemoryJobsPerSession: 1,
      maxPendingMemoryJobs: 3,
    })
    const turn = (sessionId: string, userId: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: userId,
      sessionId,
      text: 'synthetic fact',
      userId,
    })

    await runtime.reply(turn('a-1', 'user-a'))
    await firstMemoryStarted
    await runtime.reply(turn('a-2', 'user-a'))
    await runtime.reply(turn('a-3-over-principal', 'user-a'))
    await runtime.reply(turn('b-1', 'user-b'))
    await runtime.reply(turn('c-1-over-global', 'user-c'))
    const queueWarningsBeforeRecovery = warn.mock.calls.filter(call => call[1] === 'queue-capacity').length

    releaseFirstMemory()
    await vi.waitFor(() => {
      expect(completed).toHaveLength(3)
    })
    for (let index = 0; index < 10; index += 1)
      await Promise.resolve()
    await runtime.reply(turn('a-4-recovered', 'user-a'))
    await vi.waitFor(() => {
      expect(completed).toContain('a-4-recovered')
    })

    // ROOT CAUSE:
    //
    // Awaiting rememberTurn provided no accepted-job accounting. Deferred memory
    // work could consume visible capacity, while moving it to an unbounded fire-
    // and-forget task would merely move the DoS. The queue now enforces exact
    // session, stable-principal, and global totals and releases them on settlement.
    // @example
    expect(queueWarningsBeforeRecovery).toBe(2)
    // @example
    expect(memoryCalls).toBe(4)
    // @example
    expect(completed).not.toContain('a-3-over-principal')
    // @example
    expect(completed).not.toContain('c-1-over-global')
    await runtime.stop()
    warn.mockRestore()
  })

  /**
   * @example
   * it('cancels one memory session without clearing a replacement for Discord audit D-024', async () => {})
   */
  it('cancels one memory session without clearing a replacement for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseOldProvider = () => {}
    let markOldStarted = () => {}
    let markOtherChannelCompleted = () => {}
    let markReplacementStarted = () => {}
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve
    })
    const oldProvider = new Promise<void>((resolve) => {
      releaseOldProvider = resolve
    })
    const otherChannelCompleted = new Promise<void>((resolve) => {
      markOtherChannelCompleted = resolve
    })
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve
    })
    const memoryStarts: string[] = []
    let otherChannelSignal: AbortSignal | undefined
    let replacementSignal: AbortSignal | undefined
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn, _assistantText, context) => {
        memoryStarts.push(turn.text)
        if (turn.text === 'old active') {
          markOldStarted()
          await oldProvider
          return
        }
        if (turn.text === 'other channel') {
          otherChannelSignal = context.abortSignal
          markOtherChannelCompleted()
          return
        }
        if (turn.text === 'replacement') {
          replacementSignal = context.abortSignal
          markReplacementStarted()
          await new Promise<void>((_resolve, reject) => {
            context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true })
          })
        }
      },
    }, {
      maxConcurrentMemoryJobs: 3,
      maxConcurrentMemoryJobsPerPrincipal: 2,
      maxMemoryJobsPerPrincipal: 4,
      maxMemoryJobsPerSession: 3,
      maxPendingMemoryJobs: 8,
    })
    const turn = (sessionId: string, text: string) => ({
      channelId: sessionId,
      directMessage: true,
      displayName: 'User A',
      sessionId,
      text,
      userId: 'user-a',
    })

    await runtime.reply(turn('session-a', 'old active'))
    await oldStarted
    await runtime.reply(turn('session-a', 'old queued'))
    await runtime.reply(turn('session-b', 'other channel'))
    await otherChannelCompleted
    runtime.clearSession('session-a')
    await runtime.reply(turn('session-a', 'replacement'))
    await replacementStarted
    releaseOldProvider()
    for (let index = 0; index < 10; index += 1)
      await Promise.resolve()
    runtime.clearMemorySession('session-a')
    await vi.waitFor(() => {
      expect(replacementSignal?.aborted).toBe(true)
    })

    // ROOT CAUSE:
    //
    // Reply-session controllers were deleted as soon as the visible reply settled,
    // so a later opt-out could not address background work. A dedicated exact-
    // session memory generation now owns queued/active jobs; identity-checked
    // cleanup cannot delete the replacement generation after old raw settlement.
    // @example
    expect(memoryStarts).not.toContain('old queued')
    // @example
    expect(memoryStarts).toContain('other channel')
    // @example
    expect(otherChannelSignal?.aborted).toBe(false)
    await runtime.stop()
    warn.mockRestore()
  })

  /**
   * @example
   * it('expires memory wrappers without orphaning raw settlement for Discord audit D-024', async () => {})
   */
  it('expires memory wrappers without orphaning raw settlement for Discord audit D-024', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectLateProvider = (_error: Error) => {}
    let markMemoryStarted = () => {}
    const memoryStarted = new Promise<void>((resolve) => {
      markMemoryStarted = resolve
    })
    let memorySignal: AbortSignal | undefined
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (_turn, _assistantText, context) => {
        memorySignal = context.abortSignal
        markMemoryStarted()
        return new Promise<void>((_resolve, reject) => {
          rejectLateProvider = reject
        })
      },
    }, {
      memoryJobTimeoutMs: 10,
    })

    await expect(runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'User A',
      sessionId: 'session-a',
      text: 'synthetic fact',
      userId: 'user-a',
    })).resolves.toBe('visible reply')
    await memoryStarted
    await vi.advanceTimersByTimeAsync(10)
    await runtime.stop()
    rejectLateProvider(new Error('SENTINEL_PROVIDER_BODY_MUST_NOT_LOG'))
    await vi.advanceTimersByTimeAsync(0)

    // ROOT CAUSE:
    //
    // A fire-and-forget timeout could release local accounting while losing the
    // raw provider promise. The wrapper now aborts at its admission-time absolute
    // deadline, while the process registry observes the raw promise until its real
    // rejection and prevents any late wrapper/file side effect.
    // @example
    expect(memorySignal?.aborted).toBe(true)
    // @example
    expect(warn).toHaveBeenCalledWith(
      '[discord-bot:standalone] automatic memory job did not persist:',
      'deadline',
    )
    // @example
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL_PROVIDER_BODY_MUST_NOT_LOG')
    // @example
    expect(runtime.getSessionMessages('session-a')).toHaveLength(2)
    // @example
    expect(vi.getTimerCount()).toBe(0)
    warn.mockRestore()
    vi.useRealTimers()
  })

  /**
   * @example
   * it('does not renew a queued memory deadline for Discord audit D-024', async () => {})
   */
  it('does not renew a queued memory deadline for Discord audit D-024', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseFirstMemory = () => {}
    let markFirstMemoryStarted = () => {}
    const firstMemoryStarted = new Promise<void>((resolve) => {
      markFirstMemoryStarted = resolve
    })
    const firstMemoryBlocked = new Promise<void>((resolve) => {
      releaseFirstMemory = resolve
    })
    const memoryTurns: string[] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        memoryTurns.push(turn.text)
        if (turn.text === 'first') {
          markFirstMemoryStarted()
          await firstMemoryBlocked
        }
      },
    }, {
      maxConcurrentMemoryJobs: 1,
      memoryJobTimeoutMs: 1_000,
    })
    const turn = (text: string) => ({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'User A',
      sessionId: 'session-a',
      text,
      userId: 'user-a',
    })

    await runtime.reply(turn('first'))
    await firstMemoryStarted
    await runtime.reply(turn('expired while queued'), { deadlineAt: 5_010 })
    await vi.advanceTimersByTimeAsync(10)
    releaseFirstMemory()
    await vi.advanceTimersByTimeAsync(0)
    await runtime.stop()

    // ROOT CAUSE:
    //
    // Starting a fresh phase timeout when a queued job finally received a slot
    // would silently extend a voice/turn admission deadline. The queue snapshots
    // the absolute deadline at reply admission and checks that same value before
    // invoking the memory provider.
    // @example
    expect(memoryTurns).toEqual(['first'])
    // @example
    expect(warn).toHaveBeenCalledWith(
      '[discord-bot:standalone] automatic memory job did not persist:',
      'deadline',
    )
    // @example
    expect(vi.getTimerCount()).toBe(0)
    warn.mockRestore()
    vi.useRealTimers()
  })

  /**
   * @example
   * it('drains stop cancellation while retaining raw memory tasks for Discord audit D-024', async () => {})
   */
  it('drains stop cancellation while retaining raw memory tasks for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseRawProvider = () => {}
    let markMemoryStarted = () => {}
    const memoryStarted = new Promise<void>((resolve) => {
      markMemoryStarted = resolve
    })
    const rawProvider = new Promise<void>((resolve) => {
      releaseRawProvider = resolve
    })
    let memoryCalls = 0
    let memorySignal: AbortSignal | undefined
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (_turn, _assistantText, context) => {
        memoryCalls += 1
        memorySignal = context.abortSignal
        markMemoryStarted()
        await rawProvider
      },
    }, {
      maxConcurrentMemoryJobs: 1,
      maxMemoryJobsPerSession: 2,
    })
    const turn = (text: string) => ({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'User A',
      sessionId: 'session-a',
      text,
      userId: 'user-a',
    })

    await runtime.reply(turn('active memory'))
    await memoryStarted
    await runtime.reply(turn('queued memory'))
    let stopSettled = false
    await runtime.stop().then(() => {
      stopSettled = true
    })

    // ROOT CAUSE:
    //
    // Runtime stop previously drained only visible reply tails. The memory queue
    // now aborts and drains every accepted wrapper; queued work never starts, but
    // a non-cooperative raw task remains observed until true settlement.
    // @example
    expect(stopSettled).toBe(true)
    // @example
    expect(memorySignal?.aborted).toBe(true)
    // @example
    expect(memoryCalls).toBe(1)
    releaseRawProvider()
    for (let index = 0; index < 5; index += 1)
      await Promise.resolve()
    warn.mockRestore()
  })

  /**
   * @example
   * it('sanitizes memory rejection and continues the session queue for Discord audit D-024', async () => {})
   */
  it('sanitizes memory rejection and continues the session queue for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persisted: string[] = []
    let memoryCalls = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 8,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async (turn) => {
        memoryCalls += 1
        if (memoryCalls === 1)
          throw new Error('SENTINEL_PRIVATE_MEMORY_AND_PROVIDER_BODY')
        persisted.push(turn.text)
      },
    })
    const turn = (text: string) => ({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'User A',
      sessionId: 'session-a',
      text,
      userId: 'user-a',
    })

    await expect(runtime.reply(turn('first'))).resolves.toBe('visible reply')
    await expect(runtime.reply(turn('second'))).resolves.toBe('visible reply')
    await vi.waitFor(() => {
      expect(memoryCalls).toBe(2)
    })

    // ROOT CAUSE:
    //
    // Background failures cannot reject an already-delivered reply, but silently
    // swallowing them would erase observability. The queue observes every wrapper,
    // emits only a stable category, and continues later FIFO work.
    // @example
    expect(persisted).toEqual(['second'])
    // @example
    expect(warn).toHaveBeenCalledWith(
      '[discord-bot:standalone] automatic memory job did not persist:',
      'provider-failure',
    )
    // @example
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SENTINEL_PRIVATE_MEMORY_AND_PROVIDER_BODY')
    await runtime.stop()
    warn.mockRestore()
  })

  /**
   * @example
   * it('clamps non-finite and oversized memory limits for Discord audit D-024', async () => {})
   */
  it('clamps non-finite and oversized memory limits for Discord audit D-024', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const releaseProviders: Array<() => void> = []
    let memoryStarts = 0
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn: async () => {
        memoryStarts += 1
        await new Promise<void>((resolve) => {
          releaseProviders.push(resolve)
        })
      },
    }, {
      maxConcurrentMemoryJobs: Number.MAX_SAFE_INTEGER,
      maxConcurrentMemoryJobsPerPrincipal: Number.MAX_SAFE_INTEGER,
      maxMemoryJobsPerPrincipal: Number.MAX_SAFE_INTEGER,
      maxMemoryJobsPerSession: Number.MAX_SAFE_INTEGER,
      maxPendingMemoryJobs: Number.MAX_SAFE_INTEGER,
      memoryJobTimeoutMs: Number.POSITIVE_INFINITY,
    })

    for (let index = 0; index < 65; index += 1) {
      await runtime.reply({
        channelId: `dm-${index}`,
        directMessage: true,
        displayName: `User ${index}`,
        sessionId: `session-${index}`,
        text: 'synthetic fact',
        userId: `user-${index}`,
      })
    }
    for (let index = 0; index < 30; index += 1)
      await Promise.resolve()

    // ROOT CAUSE:
    //
    // Runtime-only numeric options were trusted after Math.trunc, so Infinity or
    // a huge dashboard/test value could remove every intended hard bound. Each
    // option now has a finite owning-boundary maximum independent of caller input.
    // @example
    expect(memoryStarts).toBe(8)
    // @example
    expect(warn.mock.calls.filter(call => call[1] === 'queue-capacity')).toHaveLength(1)

    await runtime.stop()
    for (const release of releaseProviders)
      release()
    for (let index = 0; index < 5; index += 1)
      await Promise.resolve()
    warn.mockRestore()
  })

  /**
   * @example
   * it('bounds non-cooperative memory work across runtime generations for Discord audit D-024', async () => {})
   */
  it('bounds non-cooperative memory work across runtime generations for Discord audit D-024', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const releaseOrphans: Array<() => void> = []
    let userAStarts = 0

    const createRuntime = (
      rememberTurn: NonNullable<ConstructorParameters<typeof StandaloneChatRuntime>[2]>['rememberTurn'],
    ) => new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => ({ text: 'visible reply' }), {
      buildPrompt: async () => '',
      rememberTurn,
    }, {
      memoryJobTimeoutMs: 10,
    })

    try {
      for (let generation = 0; generation < 12; generation += 1) {
        const runtime = createRuntime(async () => {
          userAStarts += 1
          await new Promise<void>((resolve) => {
            releaseOrphans.push(resolve)
          })
        })
        await runtime.reply({
          channelId: `channel-a-${generation}`,
          directMessage: false,
          displayName: 'User A',
          guildId: 'guild-a',
          sessionId: `guild-a-channel-a-${generation}-user-a`,
          text: `synthetic fact ${generation}`,
          userId: 'user-a',
        })
        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(10)
        await runtime.stop()
      }

      let userBStarts = 0
      const userBRuntime = createRuntime(async () => {
        userBStarts += 1
      })
      await userBRuntime.reply({
        channelId: 'channel-b',
        directMessage: false,
        displayName: 'User B',
        guildId: 'guild-b',
        sessionId: 'guild-b-channel-b-user-b',
        text: 'synthetic fact for B',
        userId: 'user-b',
      })
      await vi.advanceTimersByTimeAsync(0)

      // ROOT CAUSE:
      //
      // Exact-generation ownership alone let one participant repeatedly restart
      // and allocate a fresh quota for every non-cooperative extractor promise.
      // A process registry now additionally caps the stable Discord principal,
      // while reserved global capacity lets an unrelated principal still run.
      // @example
      expect(userAStarts).toBe(8)
      // @example
      expect(releaseOrphans).toHaveLength(8)
      // @example
      expect(userBStarts).toBe(1)
      // @example
      expect(warn.mock.calls.filter(call => call[1] === 'provider-capacity')).toHaveLength(4)
      await userBRuntime.stop()

      releaseOrphans[0]?.()
      await vi.advanceTimersByTimeAsync(0)

      let replacementSignal: AbortSignal | undefined
      let releaseReplacement = () => {}
      let markReplacementStarted = () => {}
      const replacementStarted = new Promise<void>((resolve) => {
        markReplacementStarted = resolve
      })
      const replacementRuntime = createRuntime(async (_turn, _assistantText, context) => {
        replacementSignal = context.abortSignal
        markReplacementStarted()
        await new Promise<void>((resolve) => {
          releaseReplacement = resolve
        })
      })
      await replacementRuntime.reply({
        channelId: 'replacement-channel-a',
        directMessage: false,
        displayName: 'User A',
        guildId: 'guild-a',
        sessionId: 'guild-a-replacement-channel-a-user-a',
        text: 'replacement synthetic fact',
        userId: 'user-a',
      })
      await replacementStarted

      for (const release of releaseOrphans.slice(1))
        release()
      await vi.advanceTimersByTimeAsync(0)

      // An old generation settling removes only its own process record and cannot
      // abort or delete the replacement generation's exact owner.
      // @example
      expect(replacementSignal?.aborted).toBe(false)
      releaseReplacement()
      await vi.advanceTimersByTimeAsync(0)
      await replacementRuntime.stop()
    }
    finally {
      for (const release of releaseOrphans)
        release()
      await vi.advanceTimersByTimeAsync(0)
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  /**
   * @example
   * it('aborts and drains active model requests when the runtime stops', async () => {})
   */
  it('aborts and drains active model requests when the runtime stops', async () => {
    let signal: AbortSignal | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      signal = input.abortSignal
      markStarted?.()
      return new Promise((resolve, reject) => {
        input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), { once: true })
      })
    })
    const turn = {
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'session-1',
      text: 'hello',
      userId: 'user-1',
    }

    const reply = runtime.reply(turn)
    await started
    const stopping = runtime.stop()

    await expect(reply).rejects.toThrow('stopped')
    await expect(stopping).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(runtime.reply(turn)).rejects.toThrow('stopped')
  })

  /**
   * @example
   * it('does not persist failed model turns into session history', () => {})
   */
  it('does not persist failed model turns into session history', async () => {
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async () => {
      throw new Error('provider down')
    })

    await expect(runtime.reply({
      channelId: 'channel-a',
      directMessage: false,
      displayName: 'Owen',
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: 'discord-guild-user-1',
      text: 'hello',
    })).rejects.toThrow('Standalone chat provider failed.')
    expect(runtime.getSessionMessages('discord-guild-user-1')).toEqual([])
  })

  /**
   * @example
   * it('injects standalone memory card notes before Discord history', async () => {})
   */
  it('injects standalone memory card notes before Discord history', async () => {
    const capturedMessages: Message[][] = []
    const rememberedTurns: Array<{ assistantText: string, text: string }> = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {},
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      capturedMessages.push(input.messages)
      return { text: 'memory-aware reply' }
    }, {
      buildPrompt: async () => 'Relevant standalone memory card notes:\n1. Owen prefers concise replies.',
      rememberTurn: async (turn, assistantText) => {
        rememberedTurns.push({ assistantText, text: turn.text })
      },
    })

    const reply = await runtime.reply({
      channelId: 'dm-channel',
      directMessage: true,
      displayName: 'Owen',
      sessionId: 'discord-dm-user-1',
      text: 'remember that I like short answers',
      userId: 'user-1',
    })

    /**
     * @example
     * expect(reply).toBe('memory-aware reply')
     */
    expect(reply).toBe('memory-aware reply')
    /**
     * @example
     * expect(capturedMessages[0][1]).toEqual({ role: 'system', content: '...' })
     */
    expect(capturedMessages[0][1]).toEqual({
      role: 'system',
      content: 'Relevant standalone memory card notes:\n1. Owen prefers concise replies.',
    })
    expect(capturedMessages[0][2].content).toContain('For short English greetings like "hi" or "hello", reply in English.')
    /**
     * @example
     * expect(capturedMessages[0][3].role).toBe('user')
     */
    expect(capturedMessages[0][3].role).toBe('user')
    /**
     * @example
     * expect(rememberedTurns).toEqual([{ assistantText: 'memory-aware reply', text: '...' }])
     */
    expect(rememberedTurns).toEqual([{
      assistantText: 'memory-aware reply',
      text: 'remember that I like short answers',
    }])
  })

  /**
   * @example
   * it('persists an explicit user fact after a reply and injects it only for that user after restart', async () => {})
   */
  it('persists an explicit user fact after a reply and injects it only for that user after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-memory-runtime-'))

    try {
      const memoryConfig = resolveStandaloneMemoryStoreConfig({
        AIRI_DISCORD_MEMORY_CONSENT_REQUIRED: 'true',
        AIRI_DISCORD_MEMORY_FILE: join(dir, 'memory.json'),
      }, dir)
      const turn = {
        channelId: 'channel-1',
        directMessage: false,
        displayName: 'User A',
        guildId: 'guild-1',
        guildName: 'Home',
        sessionId: 'guild-1-channel-1-user-a',
        text: '我喜欢绿色',
        userId: 'user-a',
      }
      const firstStore = new StandaloneMemoryStore(memoryConfig)
      await firstStore.handleCommand({ ...turn, text: '!airi memory on' })
      const firstRuntime = new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: 'acknowledged' }), firstStore)

      await firstRuntime.reply(turn)
      expect(await firstStore.listMemories()).toEqual([])
      await firstRuntime.reply({ ...turn, text: '请记住我喜欢蓝色' })
      await vi.waitFor(async () => {
        expect(await firstStore.listMemories()).toHaveLength(1)
      })

      const recalledMessages: Message[][] = []
      const restartedStore = new StandaloneMemoryStore(memoryConfig)
      const restartedRuntime = new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async (input) => {
        recalledMessages.push(input.messages)
        return { text: '蓝色' }
      }, restartedStore)
      await restartedRuntime.reply({ ...turn, text: '我喜欢什么颜色？' })

      expect(recalledMessages[0][0].role).toBe('system')
      expect(recalledMessages[0][0].content).not.toContain('蓝色')
      expect(recalledMessages[0][1].role).toBe('system')
      expect(recalledMessages[0][1].content).toContain('Current verified Discord user')
      expect(recalledMessages[0][1].content).toContain('蓝色')
      expect(recalledMessages[0][1].content).toContain('Prefer the current user message whenever it conflicts')

      const otherUserMessages: Message[][] = []
      const otherUserRuntime = new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async (input) => {
        otherUserMessages.push(input.messages)
        return { text: 'unknown' }
      }, restartedStore)
      await otherUserRuntime.reply({
        ...turn,
        displayName: 'User B',
        sessionId: 'guild-1-channel-1-user-b',
        text: '我喜欢什么颜色？',
        userId: 'user-b',
      })

      expect(otherUserMessages[0].some(message => typeof message.content === 'string' && message.content.includes('蓝色'))).toBe(false)
      await Promise.all([
        firstRuntime.stop(),
        restartedRuntime.stop(),
        otherUserRuntime.stop(),
      ])
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('automatically extracts a grounded person fact from a DM by default and injects it on the next turn', async () => {})
   */
  it('automatically extracts a grounded person fact from a DM by default and injects it on the next turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-discord-memory-runtime-'))

    try {
      const memoryConfig = resolveStandaloneMemoryStoreConfig({
        AIRI_DISCORD_MEMORY_CONSENT_REQUIRED: 'true',
        AIRI_DISCORD_MEMORY_FILE: join(dir, 'memory.json'),
      }, dir)
      const turn = {
        channelId: 'dm-channel',
        directMessage: true,
        displayName: 'User A',
        messageId: 'message-tea',
        sessionId: 'dm-user-a',
        text: '我最喜欢的饮料是茉莉茶',
        userId: 'user-a',
      }
      const firstStore = new StandaloneMemoryStore(memoryConfig, {
        extractor: async () => ({
          facts: [{
            confidence: 0.98,
            evidence: '我最喜欢的饮料是茉莉茶',
            factKey: 'preference.favorite_drink',
            memoryClass: 'preference',
          }],
          model: 'test-memory-model',
        }),
      })
      const firstRuntime = new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async () => ({ text: '好的。' }), firstStore)

      await firstRuntime.reply(turn)

      let memories = await firstStore.listMemories()
      await vi.waitFor(async () => {
        memories = await firstStore.listMemories()
        expect(memories).toHaveLength(1)
      })
      const recalledMessages: Message[][] = []
      const restartedRuntime = new StandaloneChatRuntime({
        apiKey: 'test-key',
        discordRulesByGuild: {},
        maxHistoryMessages: 4,
        model: 'test-model',
        systemPrompt: 'You are AIRI.',
      }, async (input) => {
        recalledMessages.push(input.messages)
        return { text: '茉莉茶' }
      }, new StandaloneMemoryStore(memoryConfig))
      await restartedRuntime.reply({
        ...turn,
        messageId: 'message-question',
        text: '我最喜欢什么饮料？',
      })

      /**
       * @example
       * expect(memories).toHaveLength(1)
       */
      expect(memories).toHaveLength(1)
      expect(memories[0].source).toBe('auto-chat')
      expect(memories[0].sourceMessageId).toBe('message-tea')
      expect(recalledMessages[0][0].content).not.toContain('茉莉茶')
      expect(recalledMessages[0][1].role).toBe('system')
      expect(recalledMessages[0][1].content).toContain('我最喜欢的饮料是茉莉茶')
      expect(recalledMessages[0][1].content).toContain('fallible derived context')
      await Promise.all([
        firstRuntime.stop(),
        restartedRuntime.stop(),
      ])
    }
    finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  /**
   * @example
   * it('injects only matching standalone Discord scoped rules', async () => {})
   */
  it('injects only matching standalone Discord scoped rules', async () => {
    const capturedMessages: Message[][] = []
    const runtime = new StandaloneChatRuntime({
      apiKey: 'test-key',
      discordRulesByGuild: {
        'guild-1': {
          channels: {
            'channel-a': {
              channelId: 'channel-a',
              rules: 'Channel A only rule.',
              updatedAt: 1000,
            },
          },
          guildId: 'guild-1',
          guildName: 'Home',
          rules: 'Guild 1 only rule.',
          updatedAt: 1000,
        },
        'guild-2': {
          channels: {},
          guildId: 'guild-2',
          rules: 'Guild 2 must not leak.',
          updatedAt: 1000,
        },
      },
      maxHistoryMessages: 4,
      model: 'test-model',
      systemPrompt: 'You are AIRI.',
    }, async (input) => {
      capturedMessages.push(input.messages)
      return { text: 'scoped reply' }
    })

    await runtime.reply({
      channelId: 'channel-a',
      directMessage: false,
      displayName: 'Owen',
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: 'discord-guild-1-channel-a-user-1',
      text: 'hello',
      userId: 'user-1',
    })
    await runtime.reply({
      channelId: 'channel-b',
      directMessage: false,
      displayName: 'Owen',
      guildId: 'guild-1',
      guildName: 'Home',
      sessionId: 'discord-guild-1-channel-b-user-1',
      text: 'hello again',
      userId: 'user-1',
    })

    /**
     * @example
     * expect(capturedMessages[0][0].content).toContain('Guild 1 only rule.')
     */
    expect(capturedMessages[0][0].content).toContain('Guild 1 only rule.')
    /**
     * @example
     * expect(capturedMessages[0][0].content).toContain('Channel A only rule.')
     */
    expect(capturedMessages[0][0].content).toContain('Channel A only rule.')
    /**
     * @example
     * expect(capturedMessages[0][0].content).not.toContain('Guild 2 must not leak.')
     */
    expect(capturedMessages[0][0].content).not.toContain('Guild 2 must not leak.')
    /**
     * @example
     * expect(capturedMessages[1][0].content).toContain('Guild 1 only rule.')
     */
    expect(capturedMessages[1][0].content).toContain('Guild 1 only rule.')
    /**
     * @example
     * expect(capturedMessages[1][0].content).not.toContain('Channel A only rule.')
     */
    expect(capturedMessages[1][0].content).not.toContain('Channel A only rule.')
  })
})
