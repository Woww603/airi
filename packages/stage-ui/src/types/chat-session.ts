import type { ChatHistoryItem } from './chat'

/** Editable session-level prompt controls applied independently from character cards. */
export interface ChatSessionPromptProfile {
  /** Temporary narrative direction appended after the character prompt. @default undefined */
  authorNote?: string
  /** Session-scoped user identity presented to the model. @default undefined */
  userPersona?: {
    /** Display name used inside the persona contribution. */
    name: string
    /** Free-form traits, background, and conversational preferences. */
    description: string
  }
  /** User-editable compact memory of earlier conversation. @default undefined */
  rollingSummary?: {
    /** Summary text injected into subsequent prompts. */
    content: string
    /** Message ids covered when this summary was last saved. */
    sourceMessageIds: string[]
    /** Wall-clock time when the summary was last saved. */
    updatedAt: number
  }
}

export interface ChatSessionMeta {
  sessionId: string
  userId: string
  characterId: string
  title?: string
  createdAt: number
  updatedAt: number
  /** Session-specific prompt controls and editable summary memory. @default undefined */
  promptProfile?: ChatSessionPromptProfile
  /**
   * Cloud chat id assigned by the server once this session is mirrored to the
   * `chats` table. Set during cloud reconcile, persisted across reloads. When
   * absent the session is local-only.
   */
  cloudChatId?: string
  /**
   * Highest server-assigned `seq` we have already merged into local messages
   * for this session. Used as `afterSeq` when calling `pullMessages`. Stays
   * undefined for local-only sessions.
   *
   * @default undefined
   */
  cloudMaxSeq?: number
}

export interface ChatSessionRecord {
  meta: ChatSessionMeta
  messages: ChatHistoryItem[]
}

export interface ChatCharacterSessionsIndex {
  activeSessionId: string
  sessions: Record<string, ChatSessionMeta>
}

export interface ChatSessionsIndex {
  userId: string
  characters: Record<string, ChatCharacterSessionsIndex>
}

export interface ChatSessionsExport {
  format: 'chat-sessions-index:v1'
  index: ChatSessionsIndex
  sessions: Record<string, ChatSessionRecord>
}
