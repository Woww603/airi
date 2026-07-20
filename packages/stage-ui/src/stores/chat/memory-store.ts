import type { ChatStreamEventContext } from '@proj-airi/core-agent'

import type { ChatMemoryFragment, ChatMemoryRole, ChatMemoryScope } from '../../database/repos/chat-memory.repo'
import type { DiscordMemoryContext } from '../../database/repos/discord-memory.repo'

import { useLocalStorage } from '@vueuse/core'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import { buildChatMemoryPrompt, chatMemoryRepo } from '../../database/repos/chat-memory.repo'
import {
  appendShortTermMessage,
  buildCoreMemoryRulesPrompt,
  buildDiscordMemoryPrompt,
  discordMemoryRepo,
  getRelevantMemories,
  getShortTermScopeKey,
  listShortTermMessages,
  normalizeShortTermLimit,
} from '../../database/repos/discord-memory.repo'
import { useAuthStore } from '../auth'
import { useAiriCardStore } from '../modules/airi-card'

type ChatInput = NonNullable<ChatStreamEventContext['input']>
type TrustedDiscordInput = ChatInput & {
  data: ChatInput['data'] & {
    discord: NonNullable<ChatInput['data']['discord']>
  }
}

export interface RememberChatMessageInput {
  /** Chat session boundary used for memory isolation. */
  sessionId: string
  /** Speaker role that produced the content. */
  role: ChatMemoryRole
  /** Text content considered for recallable memory storage. */
  content: string
}

/**
 * Input used when building a memory prompt for one chat turn.
 */
export interface BuildChatMemoryPromptInput {
  /** Chat session boundary used for memory recall isolation. */
  sessionId: string
  /** Current user message used as the recall query. */
  message: string
}

export interface RememberDiscordShortTermMessageInput {
  /** Current trusted Discord input envelope for this chat turn. */
  input?: ChatStreamEventContext['input']
  /** Speaker role that produced the content. */
  role: ChatMemoryRole
  /** Text content stored only in the current exact Discord user ring. */
  content: string
  /** Creation time override for tests. @default Date.now */
  createdAt?: number
}

export interface BuildDiscordMemoryPromptInput {
  /** Current trusted Discord input envelope for this chat turn. */
  input?: ChatStreamEventContext['input']
}

function isTrustedDiscordInput(input: ChatStreamEventContext['input'] | undefined): input is TrustedDiscordInput {
  return input?.metadata?.source?.kind === 'plugin'
    && input.metadata.source.plugin?.id === 'discord'
    && !!input.data.discord
}

export const useChatMemoryStore = defineStore('chat-memory', () => {
  const authStore = useAuthStore()
  const cardStore = useAiriCardStore()
  const { userId } = storeToRefs(authStore)
  const { activeCardId } = storeToRefs(cardStore)
  const enabled = useLocalStorage('settings/modules/chat-memory/enabled', true)
  const fragments = ref<ChatMemoryFragment[]>([])
  const loading = ref(false)
  const loadedSessionId = ref<string>()

  const configured = computed(() => enabled.value)
  const memoryCount = computed(() => fragments.value.length)

  function currentScope(sessionId: string): ChatMemoryScope {
    return {
      userId: userId.value || 'local',
      characterId: activeCardId.value || 'default',
      sessionId,
    }
  }

  function resolveDiscordMemoryContext(input: ChatStreamEventContext['input'] | undefined): DiscordMemoryContext | undefined {
    if (!isTrustedDiscordInput(input))
      return undefined

    const discord = input.data.discord
    const userId = discord.guildMember?.id?.trim()
    if (!userId)
      return undefined

    const guildId = discord.guildId?.trim() || undefined
    const channelId = discord.channelId?.trim() || undefined
    return {
      userId,
      username: discord.guildMember?.displayName || discord.guildMember?.nickname || userId,
      isDM: !guildId,
      guildId,
      channelId,
      ownerUserIdConfigured: discord.owner?.configured,
      isOwner: discord.owner?.currentUserIsOwner,
      shortTermLimit: discord.memory?.shortTermLimit,
    }
  }

  async function loadCurrentScope(sessionId: string) {
    loading.value = true
    loadedSessionId.value = sessionId
    try {
      fragments.value = await chatMemoryRepo.list(currentScope(sessionId))
    }
    finally {
      loading.value = false
    }
  }

  async function rememberMessage(input: RememberChatMessageInput) {
    if (!enabled.value)
      return

    try {
      const remembered = await chatMemoryRepo.add(currentScope(input.sessionId), input)
      if (remembered && loadedSessionId.value === input.sessionId)
        fragments.value = await chatMemoryRepo.list(currentScope(input.sessionId))
    }
    catch (error) {
      console.warn('[chat-memory] failed to remember message', error)
    }
  }

  async function buildPromptForMessage(input: BuildChatMemoryPromptInput) {
    if (!enabled.value)
      return ''

    try {
      const memories = await chatMemoryRepo.findRelevant(currentScope(input.sessionId), input.message)
      return buildChatMemoryPrompt(memories)
    }
    catch (error) {
      console.warn('[chat-memory] failed to recall memories', error)
      return ''
    }
  }

  async function buildDiscordPromptForInput(input: BuildDiscordMemoryPromptInput) {
    const context = resolveDiscordMemoryContext(input.input)
    if (!context)
      return buildCoreMemoryRulesPrompt()

    const shortTermScopeKey = getShortTermScopeKey(context)
    const shortTermMessages = shortTermScopeKey ? await listShortTermMessages(shortTermScopeKey) : []
    const longTermMemories = await getRelevantMemories(context, discordMemoryRepo)
    return buildDiscordMemoryPrompt({
      context,
      longTermMemories,
      shortTermMessages,
    })
  }

  async function rememberDiscordShortTermMessage(input: RememberDiscordShortTermMessageInput) {
    const context = resolveDiscordMemoryContext(input.input)
    if (!context)
      return

    const scopeKey = getShortTermScopeKey(context)
    if (!scopeKey)
      return

    await appendShortTermMessage(scopeKey, {
      role: input.role,
      userId: input.role === 'user' ? context.userId : undefined,
      username: input.role === 'user' ? context.username : undefined,
      content: input.content,
      createdAt: input.createdAt ?? Date.now(),
    }, normalizeShortTermLimit(context.shortTermLimit))
  }

  async function forgetMemory(sessionId: string, id: string) {
    await chatMemoryRepo.remove(currentScope(sessionId), id)
    await loadCurrentScope(sessionId)
  }

  async function clearCurrentScope(sessionId: string) {
    await chatMemoryRepo.clear(currentScope(sessionId))
    fragments.value = []
  }

  return {
    enabled,
    configured,
    fragments,
    loading,
    memoryCount,
    currentScope,
    loadCurrentScope,
    rememberMessage,
    buildPromptForMessage,
    buildDiscordPromptForInput,
    rememberDiscordShortTermMessage,
    resolveDiscordMemoryContext,
    forgetMemory,
    clearCurrentScope,
  }
})
