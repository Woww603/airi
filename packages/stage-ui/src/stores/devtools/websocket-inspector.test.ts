import type { WebSocketEvent } from '@proj-airi/server-sdk'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWebSocketInspectorStore } from './websocket-inspector'

const SYNTHETIC_INSPECTOR_TOKEN = 'synthetic-d028-inspector-token-sentinel'
const SYNTHETIC_INSPECTOR_URL_SECRET = 'synthetic-d028-inspector-url-query-secret-sentinel'

function createConfigureEvent() {
  return {
    type: 'ui:configure',
    data: {
      moduleName: 'synthetic-d028-module',
      config: {
        safeLabel: 'original',
        tokenCount: 4,
        maxTokens: 2048,
        secretary: 'ordinary-field',
        authorizationUrl: 'https://synthetic.invalid/authorize',
        token: {
          action: 'replace',
          value: SYNTHETIC_INSPECTOR_TOKEN,
        },
        nested: [{ bot_token: SYNTHETIC_INSPECTOR_TOKEN }],
        providerConfig: {
          'openaiApiKey': SYNTHETIC_INSPECTOR_TOKEN,
          'dashscope-api-key': SYNTHETIC_INSPECTOR_TOKEN,
          'tts_api_key': SYNTHETIC_INSPECTOR_TOKEN,
          'oauthAccessToken': SYNTHETIC_INSPECTOR_TOKEN,
          'apiSecret': SYNTHETIC_INSPECTOR_TOKEN,
          'awsSecretKey': SYNTHETIC_INSPECTOR_TOKEN,
          'provider_secret_key': SYNTHETIC_INSPECTOR_TOKEN,
          'access_key_secret': SYNTHETIC_INSPECTOR_TOKEN,
          'webhook:secret': SYNTHETIC_INSPECTOR_TOKEN,
          'websocketAuthToken': SYNTHETIC_INSPECTOR_TOKEN,
        },
      },
    },
    metadata: {
      source: { kind: 'plugin', plugin: { id: 'synthetic-source' }, id: 'source-d028' },
      event: { id: 'event-d028' },
    },
  } satisfies WebSocketEvent
}

function createUrlQueryConfigureEvent() {
  return {
    type: 'ui:configure',
    data: {
      moduleName: 'synthetic-d028-url-module',
      config: {
        callbackUrl: `https://callback.synthetic.invalid/return?token=${SYNTHETIC_INSPECTOR_URL_SECRET}&safe=visible`,
        endpoint: `https://service.synthetic.invalid/v1/events?access_token=${SYNTHETIC_INSPECTOR_URL_SECRET}&api_key=${SYNTHETIC_INSPECTOR_URL_SECRET}&safe=visible`,
        headers: {
          'Authorization': `Bearer ${SYNTHETIC_INSPECTOR_URL_SECRET}`,
          'X-Api-Key': SYNTHETIC_INSPECTOR_URL_SECRET,
          'X-Request-Id': 'visible',
        },
        query: {
          access_token: SYNTHETIC_INSPECTOR_URL_SECRET,
          api_key: SYNTHETIC_INSPECTOR_URL_SECRET,
          page: 3,
        },
      },
    },
    metadata: {
      source: { kind: 'plugin', plugin: { id: 'synthetic-url-source' }, id: 'source-d028-url' },
      event: { id: 'event-d028-url' },
    },
  } satisfies WebSocketEvent
}

describe('websocket Inspector store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * @example
   * it('Discord audit D-028 keeps capture disabled until explicitly enabled', () => {})
   */
  it('reproduces Discord audit D-028 by defaulting capture to disabled and recording only after explicit enable', () => {
    // ROOT CAUSE:
    //
    // The Inspector store defaulted isEnabled to true, so merely opening the
    // application accumulated websocket payload history without user consent.
    //
    // Before: const isEnabled = ref(true).
    //
    // We fixed this by defaulting capture off and making add a no-op until the
    // user explicitly enables the single store-owned capture state.
    const store = useWebSocketInspectorStore()
    const event = createConfigureEvent()

    expect(store.isEnabled).toBe(false)

    store.add('incoming', event)

    expect(store.history).toHaveLength(0)

    store.isEnabled = true
    store.add('incoming', event)

    expect(store.history).toHaveLength(1)

    store.isEnabled = false
    store.add('outgoing', event)

    expect(store.history).toHaveLength(1)
  })

  /**
   * @example
   * it('Discord audit D-028 stores only idempotently redacted detached events', () => {})
   */
  it('reproduces Discord audit D-028 by redacting and detaching at the Inspector add boundary idempotently', () => {
    // ROOT CAUSE:
    //
    // add stored the observer object by reference without a second redaction
    // boundary. Any raw future caller leaked secrets into persistent history,
    // and later caller mutation changed what the Inspector rendered.
    //
    // Before: history.unshift({ event }).
    //
    // We fixed this by reusing the SDK observer policy in add, which always
    // creates a detached redacted event and is stable when applied twice.
    const store = useWebSocketInspectorStore()
    const event = createConfigureEvent()
    store.isEnabled = true

    store.add('outgoing', event)

    const firstStoredEvent = store.history[0]?.event
    expect(firstStoredEvent).toBeDefined()
    expect(JSON.stringify(firstStoredEvent)).not.toContain(SYNTHETIC_INSPECTOR_TOKEN)
    expect(firstStoredEvent).toMatchObject({
      type: 'ui:configure',
      data: {
        config: {
          safeLabel: 'original',
          tokenCount: 4,
          maxTokens: 2048,
          secretary: 'ordinary-field',
          authorizationUrl: 'https://synthetic.invalid/authorize',
          token: '[REDACTED]',
          nested: [{ bot_token: '[REDACTED]' }],
          providerConfig: {
            'openaiApiKey': '[REDACTED]',
            'dashscope-api-key': '[REDACTED]',
            'tts_api_key': '[REDACTED]',
            'oauthAccessToken': '[REDACTED]',
            'apiSecret': '[REDACTED]',
            'awsSecretKey': '[REDACTED]',
            'provider_secret_key': '[REDACTED]',
            'access_key_secret': '[REDACTED]',
            'webhook:secret': '[REDACTED]',
            'websocketAuthToken': '[REDACTED]',
          },
        },
      },
    })

    event.data.config.safeLabel = 'caller-mutated'
    expect(firstStoredEvent).toMatchObject({
      data: { config: { safeLabel: 'original' } },
    })

    if (!firstStoredEvent)
      throw new Error('Expected first redacted Inspector event')

    store.add('outgoing', firstStoredEvent)

    expect(store.history[0]?.event).toEqual(firstStoredEvent)

    store.maxHistory = Number.POSITIVE_INFINITY
    for (let index = 0; index < 1000; index++)
      store.add('incoming', firstStoredEvent)

    expect(store.history).toHaveLength(1000)
  })

  /**
   * ROOT CAUSE:
   *
   * Inspector.add reused key-based SDK redaction, which left a parseable URL
   * string untouched when its ordinary field name was not sensitive. Enabling
   * capture could therefore retain query secrets in page-visible history.
   *
   * @example
   * it('redacts secret URL query values in enabled Inspector history without mutating callers', () => {})
   */
  it('redacts secret URL query values in enabled Inspector history without mutating callers', () => {
    const store = useWebSocketInspectorStore()
    const rawEvent = createUrlQueryConfigureEvent()
    store.isEnabled = true

    store.add('outgoing', rawEvent)

    expect(store.history).toHaveLength(1)
    const storedEvent = store.history[0]?.event
    expect(JSON.stringify(store.history)).not.toContain(SYNTHETIC_INSPECTOR_URL_SECRET)
    expect(JSON.stringify(storedEvent)).not.toContain(SYNTHETIC_INSPECTOR_URL_SECRET)
    if (!storedEvent || storedEvent.type !== 'ui:configure')
      throw new Error('Inspector did not retain the public ui:configure event.')

    const storedConfig = storedEvent.data.config
    if (!storedConfig)
      throw new Error('Inspector removed the stored configuration instead of redacting secret query values.')
    const storedEndpoint = storedConfig.endpoint
    const storedCallbackUrl = storedConfig.callbackUrl
    if (typeof storedEndpoint !== 'string' || typeof storedCallbackUrl !== 'string')
      throw new Error('Inspector removed URL structure instead of redacting secret query values.')
    const storedEndpointUrl = new URL(storedEndpoint)
    const storedCallback = new URL(storedCallbackUrl)
    expect(storedEndpointUrl.pathname).toBe('/v1/events')
    expect(storedEndpointUrl.searchParams.get('access_token')).toBe('[REDACTED]')
    expect(storedEndpointUrl.searchParams.get('api_key')).toBe('[REDACTED]')
    expect(storedEndpointUrl.searchParams.get('safe')).toBe('visible')
    expect(storedCallback.pathname).toBe('/return')
    expect(storedCallback.searchParams.get('token')).toBe('[REDACTED]')
    expect(storedCallback.searchParams.get('safe')).toBe('visible')
    expect(storedConfig.headers).toEqual({
      'Authorization': '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'X-Request-Id': 'visible',
    })
    expect(storedConfig.query).toEqual({
      access_token: '[REDACTED]',
      api_key: '[REDACTED]',
      page: 3,
    })

    expect(JSON.stringify(rawEvent)).toContain(SYNTHETIC_INSPECTOR_URL_SECRET)
    expect(rawEvent.data.config).toMatchObject({
      callbackUrl: expect.stringContaining(SYNTHETIC_INSPECTOR_URL_SECRET),
      endpoint: expect.stringContaining(SYNTHETIC_INSPECTOR_URL_SECRET),
      headers: { Authorization: `Bearer ${SYNTHETIC_INSPECTOR_URL_SECRET}` },
      query: {
        access_token: SYNTHETIC_INSPECTOR_URL_SECRET,
        api_key: SYNTHETIC_INSPECTOR_URL_SECRET,
      },
    })

    store.add('incoming', storedEvent)
    expect(store.history).toHaveLength(2)
    expect(store.history[0]?.event).toEqual(storedEvent)
  })
})
