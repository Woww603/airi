import type { ChatHistoryItem } from '../../../../types/chat'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, shallowRef } from 'vue'
import { createI18n } from 'vue-i18n'

import ChatHistory from './history.vue'

vi.mock('../composables/use-chat-history-scroll', () => ({
  useChatHistoryScroll: () => undefined,
}))

vi.mock('../../../markdown', () => ({
  MarkdownRenderer: defineComponent({
    name: 'MarkdownRendererStub',
    props: {
      content: {
        type: String,
        default: '',
      },
    },
    template: '<div>{{ content }}</div>',
  }),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        stage: {
          chat: {
            actions: {
              retry: 'Retry',
            },
            message: {
              'character-name': {
                'airi': 'AIRI',
                'core-system': 'System',
                'you': 'You',
              },
            },
          },
        },
      },
    },
  })
}

function createHarness(messages: ChatHistoryItem[]) {
  return defineComponent({
    name: 'ChatHistoryRetryHarness',
    components: {
      ChatHistory,
    },
    setup() {
      const lastRetryIndex = shallowRef('none')
      const selectedAlternativeIndex = shallowRef('none')

      function handleRetryMessage(payload: { index: number }) {
        lastRetryIndex.value = String(payload.index)
      }

      function handleSelectResponseAlternative(payload: { alternativeIndex: number }) {
        selectedAlternativeIndex.value = String(payload.alternativeIndex)
      }

      return {
        handleRetryMessage,
        handleSelectResponseAlternative,
        lastRetryIndex,
        messages,
        selectedAlternativeIndex,
      }
    },
    template: `
      <div>
        <ChatHistory
          :messages="messages"
          @retry-message="handleRetryMessage"
          @select-response-alternative="handleSelectResponseAlternative"
        />
        <output aria-label="retry-index">{{ lastRetryIndex }}</output>
        <output aria-label="alternative-index">{{ selectedAlternativeIndex }}</output>
      </div>
    `,
  })
}

/**
 * @example
 * describe('ChatHistory retry actions', () => {
 *   it('emits retry-message when the retry button is clicked for an error after a user message', async () => {})
 * })
 */
describe('chatHistory retry actions', () => {
  /**
   * @example
   * it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   await screen.getByRole('button', { name: 'Retry' }).click()
   *   await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
   * })
   */
  it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'hello' },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
  })

  /**
   * @example
   * it('does not render the retry button when the error is not preceded by a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   expect(document.body.textContent).not.toContain('Retry')
   * })
   */
  it('does not render the retry button when the error is not preceded by a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'assistant', content: 'hello', slices: [], tool_results: [] },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    expect(document.body.textContent).not.toContain('Retry')
  })
})

/**
 * @example
 * describe('ChatHistory response alternatives', () => {})
 */
describe('chatHistory response alternatives', () => {
  /**
   * @example
   * Clicking the previous response control emits the selected candidate index.
   */
  it('emits candidate selection from assistant swipe controls', async () => {
    const messages: ChatHistoryItem[] = [
      {
        activeResponseAlternative: 1,
        content: 'second answer',
        responseAlternatives: [
          {
            content: 'first answer',
            id: 'candidate-1',
            slices: [{ type: 'text', text: 'first answer' }],
            tool_results: [],
          },
          {
            content: 'second answer',
            id: 'candidate-2',
            slices: [{ type: 'text', text: 'second answer' }],
            tool_results: [],
          },
        ],
        role: 'assistant',
        slices: [{ type: 'text', text: 'second answer' }],
        tool_results: [],
      },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Previous response' }).click()

    await expect.element(screen.getByLabelText('alternative-index')).toHaveTextContent('0')
  })
})
