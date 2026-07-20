import type { ContextUpdate, MetadataEventSource, WebSocketEventInputs } from '@proj-airi/server-shared/types'
import type { AssistantMessage, CommonContentPart, CompletionToolCall, Message, SystemMessage, ToolMessage, UserMessage } from '@xsai/shared-chat'

import type { PromptContribution } from '../messages/prompt-contributions'

export interface ChatSlicesText {
  type: 'text'
  text: string
}

export interface ChatSlicesToolCall {
  type: 'tool-call'
  toolCall: CompletionToolCall
}

export interface ChatSlicesToolCallResult {
  type: 'tool-call-result'
  id: string
  isError?: boolean
  result?: string | CommonContentPart[]
}

export type ChatSlices = ChatSlicesText | ChatSlicesToolCall | ChatSlicesToolCallResult

export interface ChatAssistantMessage extends AssistantMessage {
  slices: ChatSlices[]
  tool_results: {
    id: string
    isError?: boolean
    result?: string | CommonContentPart[]
  }[]
  categorization?: {
    speech: string
    reasoning: string
  }
}

/** One preserved assistant response candidate available for swipe selection. */
export interface ChatResponseAlternative {
  /** Stable identifier retained across candidate selection. */
  id: string
  /** Provider-visible assistant content for this candidate. */
  content: AssistantMessage['content']
  /** Render slices captured with this candidate. */
  slices: ChatSlices[]
  /** Tool results captured with this candidate. */
  tool_results: ChatAssistantMessage['tool_results']
  /** Optional speech/reasoning categorization captured with this candidate. */
  categorization?: ChatAssistantMessage['categorization']
}

export type ChatMessage = ChatAssistantMessage | SystemMessage | ToolMessage | UserMessage

export interface ErrorMessage {
  role: 'error'
  content: string
}

export interface ContextMessage extends ContextUpdate<Record<string, unknown>, unknown> {
  metadata?: {
    source: MetadataEventSource
  }
  createdAt: number
}

export type ChatHistoryItem = (ChatMessage | ErrorMessage) & {
  context?: ContextMessage
  createdAt?: number
  id?: string
  /** Keeps the message visible locally while omitting it from later provider prompts. */
  excludedFromPrompt?: boolean
  /** Preserved assistant candidates for user-controlled response selection. */
  responseAlternatives?: ChatResponseAlternative[]
  /** Zero-based selected candidate index. */
  activeResponseAlternative?: number
}

/** Why an active chat turn stopped before successful completion. */
export type ChatTurnCancellationReason = 'cancelled' | 'deadline' | 'reset'

export interface ChatStreamEventContext {
  /** Stable correlation identifier owned by this exact turn. */
  turnId: string
  /** Session generation captured before the turn entered the scheduler. */
  generation: number
  /** Absolute wall-clock deadline after which this turn may not emit side effects. */
  deadlineAt?: number
  /** Chat session that owns this turn and all hook/broadcast side effects. */
  sessionId: string
  /** Dynamic prompt contributions owned and released with this exact turn. */
  promptContributions: PromptContribution[]
  message: ChatHistoryItem
  contexts: Record<string, ContextMessage[]>
  composedMessage: Array<Message>
  input?: WebSocketEventInputs
}

export type ChatStreamEvent
  = | { type: 'before-compose', message: string, sessionId: string, context: Omit<ChatStreamEventContext, 'composedMessage'> }
    | { type: 'after-compose', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'before-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'after-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-literal', literal: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-special', special: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'stream-end', sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-end', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-message', message: ChatAssistantMessage, sessionId: string, messageText: string, context: ChatStreamEventContext }

export type StreamingAssistantMessage = ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number, id?: string }
