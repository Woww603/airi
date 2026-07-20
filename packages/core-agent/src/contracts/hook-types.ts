import type { ToolMessage } from '@xsai/shared-chat'

import type { ChatStreamEventContext, ChatTurnCancellationReason, StreamingAssistantMessage } from '../types/chat'

type ChatHookActivityGuard = () => boolean

/**
 * Ordered chat lifecycle subscriptions owned by one orchestrator runtime.
 *
 * Emitters accept an optional exact-turn activity guard. When supplied, the
 * registry checks it immediately before starting every registered subscriber.
 */
export interface ChatHookRegistry {
  onBeforeMessageComposed: (cb: (message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>) => Promise<void>) => () => void
  onAfterMessageComposed: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onBeforeSend: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onAfterSend: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onTokenLiteral: (cb: (literal: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onTokenSpecial: (cb: (special: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onStreamEnd: (cb: (context: ChatStreamEventContext) => Promise<void>) => () => void
  onAssistantResponseEnd: (cb: (message: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onAssistantMessage: (cb: (message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext) => Promise<void>) => () => void
  onChatTurnComplete: (cb: (chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext) => Promise<void>) => () => void
  /**
   * Subscribes to exact-turn cancellation after an active turn is invalidated.
   * Critical teardown should begin before the callback's first await because
   * cancellation subscribers are isolated and do not retain the scheduler slot.
   */
  onTurnCancelled: (cb: (context: ChatStreamEventContext, reason: ChatTurnCancellationReason) => Promise<void>) => () => void
  emitBeforeMessageComposedHooks: (message: string, context: Omit<ChatStreamEventContext, 'composedMessage'>, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitAfterMessageComposedHooks: (message: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitBeforeSendHooks: (message: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitAfterSendHooks: (message: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitTokenLiteralHooks: (literal: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitTokenSpecialHooks: (special: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitStreamEndHooks: (context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitAssistantResponseEndHooks: (message: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitAssistantMessageHooks: (message: StreamingAssistantMessage, messageText: string, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  emitChatTurnCompleteHooks: (chat: { output: StreamingAssistantMessage, outputText: string, toolCalls: ToolMessage[] }, context: ChatStreamEventContext, isTurnActive?: ChatHookActivityGuard) => Promise<void>
  /** Dispatches cancellation to every subscriber without awaiting detached cleanup work. */
  emitTurnCancelledHooks: (context: ChatStreamEventContext, reason: ChatTurnCancellationReason) => Promise<void>
  clearHooks: () => void
}
export interface HookUnsubscribe {
  (): void
}

export interface AgentHookRegistry<TContext, TAssistantMessage, TToolCall> {
  onBeforeMessageComposed: (cb: (message: string, context: Omit<TContext, 'composedMessage'>) => Promise<void>) => HookUnsubscribe
  onAfterMessageComposed: (cb: (message: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onBeforeSend: (cb: (message: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onAfterSend: (cb: (message: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onTokenLiteral: (cb: (literal: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onTokenSpecial: (cb: (special: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onStreamEnd: (cb: (context: TContext) => Promise<void>) => HookUnsubscribe
  onAssistantResponseEnd: (cb: (message: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onAssistantMessage: (cb: (message: TAssistantMessage, messageText: string, context: TContext) => Promise<void>) => HookUnsubscribe
  onChatTurnComplete: (cb: (chat: { output: TAssistantMessage, outputText: string, toolCalls: TToolCall[] }, context: TContext) => Promise<void>) => HookUnsubscribe
  /** Subscribes to exact-turn cancellation after an active turn is invalidated. */
  onTurnCancelled: (cb: (context: TContext, reason: ChatTurnCancellationReason) => Promise<void>) => HookUnsubscribe

  emitBeforeMessageComposedHooks: (message: string, context: Omit<TContext, 'composedMessage'>) => Promise<void>
  emitAfterMessageComposedHooks: (message: string, context: TContext) => Promise<void>
  emitBeforeSendHooks: (message: string, context: TContext) => Promise<void>
  emitAfterSendHooks: (message: string, context: TContext) => Promise<void>
  emitTokenLiteralHooks: (literal: string, context: TContext) => Promise<void>
  emitTokenSpecialHooks: (special: string, context: TContext) => Promise<void>
  emitStreamEndHooks: (context: TContext) => Promise<void>
  emitAssistantResponseEndHooks: (message: string, context: TContext) => Promise<void>
  emitAssistantMessageHooks: (message: TAssistantMessage, messageText: string, context: TContext) => Promise<void>
  emitChatTurnCompleteHooks: (chat: { output: TAssistantMessage, outputText: string, toolCalls: TToolCall[] }, context: TContext) => Promise<void>
  /** Notifies cancellation subscribers once for the owning active turn. */
  emitTurnCancelledHooks: (context: TContext, reason: ChatTurnCancellationReason) => Promise<void>
  clearHooks: () => void
}
