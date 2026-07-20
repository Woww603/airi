import type { WebSocketEvent } from '@proj-airi/server-sdk'

import { createRedactedObserverEvent } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/** One diagnostic-safe event retained by the WebSocket Inspector. */
export interface WebSocketHistoryItem {
  /** Local capture identifier used as the stable list key. */
  id: string
  /** Capture time in Unix milliseconds. */
  timestamp: number
  /** Transport direction observed by the SDK client. */
  direction: 'incoming' | 'outgoing'
  /** Deeply detached event with exact secret-key subtrees redacted. */
  event: WebSocketEvent
}

/** Hard ceiling preventing diagnostic capture from becoming unbounded. */
const MAX_INSPECTOR_HISTORY = 1000

export const useWebSocketInspectorStore = defineStore('devtools:websocket-inspector', () => {
  const history = ref<WebSocketHistoryItem[]>([])
  const isEnabled = ref(false)
  const maxHistory = ref(MAX_INSPECTOR_HISTORY)

  function add(direction: 'incoming' | 'outgoing', event: WebSocketEvent) {
    if (!isEnabled.value)
      return

    history.value.unshift({
      id: nanoid(),
      timestamp: Date.now(),
      direction,
      event: createRedactedObserverEvent(event),
    })

    const requestedLimit = Number.isFinite(maxHistory.value)
      ? Math.trunc(maxHistory.value)
      : MAX_INSPECTOR_HISTORY
    const retainedLimit = Math.min(Math.max(requestedLimit, 0), MAX_INSPECTOR_HISTORY)
    if (history.value.length > retainedLimit)
      history.value.splice(retainedLimit)
  }

  function clear() {
    history.value = []
  }

  return {
    history,
    isEnabled,
    maxHistory,
    add,
    clear,
  }
})
