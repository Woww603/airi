/// <reference lib="dom" />
// @vitest-environment jsdom

import { Script } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderAiriSettingsDashboardHtml } from './dashboard-ui'

interface Deferred<T> {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
}

interface DashboardConfigOverrides {
  adminRoleIdsText?: string
  allowedChannelIdsText?: string
  blockedGuildIdsText?: string
  blockedTermsText?: string
  blockedUserIdsText?: string
  channelRulesText?: string
  deepSeekModel?: string
  guildRulesText?: string
  privacyNoticeText?: string
  qwenRealtimeWorkspaceId?: string
  qwenRealtimeWorkspaceIdConfigured?: boolean
}

interface DashboardStatusOverrides {
  acceptedMessages?: number
  state?: Record<string, unknown>
  voiceDiagnostics?: unknown
}

type DashboardFetch = (path: string, init: RequestInit | undefined) => Promise<Response>

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

function dashboardConfig(overrides: DashboardConfigOverrides = {}) {
  return {
    adminRoleIdsText: 'remote-admin',
    allowDirectMessages: true,
    allowedChannelIdsText: 'remote-allowed',
    auditLogEnabled: true,
    blockedGuildIdsText: 'remote-blocked-guild',
    blockedTermsText: 'remote-term',
    blockedUserIdsText: 'remote-blocked-user',
    channelRulesText: 'remote-channel-rule',
    characterCard: {
      creator: 'Synthetic creator',
      description: 'Synthetic description',
      greetings: ['Synthetic greeting'],
      name: 'Synthetic AIRI',
      notes: 'Synthetic notes',
      personality: 'Synthetic personality',
      postHistoryInstructions: 'Synthetic post history instructions',
      scenario: 'Synthetic scenario',
      systemPrompt: 'Synthetic character system prompt',
      version: '1',
    },
    dashboardRgbOn: false,
    deepSeekApiBaseUrl: 'https://synthetic.invalid/v1',
    deepSeekApiKeyConfigured: false,
    deepSeekModel: 'remote-model',
    discordTokenConfigured: false,
    envFilePath: '/synthetic/config-path',
    guildRulesText: 'remote-guild-rule',
    historyLimit: 24,
    memoryAutoCaptureEnabled: false,
    memoryConsentRequired: true,
    memoryCount: 0,
    memoryEnabled: false,
    memoryFilePath: '/synthetic/memory-path',
    messagePacingMs: 600,
    modelRequestTimeoutMs: 90000,
    privacyNoticeEnabled: true,
    privacyNoticeText: 'remote-privacy',
    promptAttackProtectionEnabled: true,
    qwenRealtimeApiKeyConfigured: false,
    qwenRealtimeInterruptionSensitivity: 40,
    qwenRealtimeModel: 'synthetic-qwen',
    qwenRealtimeRegion: 'singapore',
    qwenRealtimeSilenceDurationMs: 600,
    qwenRealtimeVoice: 'Ethan',
    qwenRealtimeWorkspaceIdConfigured: false,
    rateLimitMaxMessages: 6,
    rateLimitWindowMs: 30000,
    runtimeLogFilePath: '/synthetic/log-path',
    selectedChannelId: 'remote-channel',
    selectedGuildId: 'remote-guild',
    sensitiveInputProtectionEnabled: true,
    sttApiBaseUrl: 'https://synthetic.invalid/v1',
    sttApiKeyConfigured: false,
    sttModel: 'synthetic-stt',
    systemPrompt: 'Synthetic provider system prompt',
    ttsApiBaseUrl: 'https://synthetic.invalid/v1',
    ttsApiKeyConfigured: false,
    ttsModel: 'synthetic-tts',
    ttsVoice: 'alloy',
    voiceCallMode: 'classic',
    ...overrides,
  }
}

function dashboardStatus(config = dashboardConfig(), overrides: DashboardStatusOverrides = {}) {
  return {
    config,
    state: {
      acceptedMessages: overrides.acceptedMessages ?? 1,
      botStatus: 'ready',
      botTag: 'synthetic-bot',
      events: [],
      failedReplies: 0,
      lastError: undefined,
      rejectedMessages: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      successfulReplies: 1,
      ...overrides.state,
      voiceDiagnostics: overrides.voiceDiagnostics ?? {
        active: [],
        completed: [],
        droppedSignals: 0,
        saturatedSessions: 0,
      },
    },
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })
}

function responseRejectedWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal)
      return
    const rejectAbort = () => reject(new DOMException('Synthetic Dashboard request aborted.', 'AbortError'))
    if (signal.aborted) {
      rejectAbort()
      return
    }
    signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

function dashboardElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element)
    throw new Error(`Missing generated dashboard element: ${id}`)
  return element as T
}

function editText(id: string, value: string): void {
  const element = dashboardElement<HTMLInputElement | HTMLTextAreaElement>(id)
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function toggleCheckbox(id: string, checked: boolean): void {
  const element = dashboardElement<HTMLInputElement>(id)
  element.checked = checked
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function submitForm(id: string): void {
  dashboardElement<HTMLFormElement>(id).dispatchEvent(new Event('submit', {
    bubbles: true,
    cancelable: true,
  }))
}

async function settleDashboardTasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1)
    await Promise.resolve()
}

async function executeGeneratedDashboard(fetchImplementation: DashboardFetch): Promise<void> {
  const html = renderAiriSettingsDashboardHtml('synthetic-script-nonce')
  const inlineScript = html.match(/<script nonce="synthetic-script-nonce">([\s\S]*?)<\/script>/)?.[1]
  if (!inlineScript)
    throw new Error('Generated dashboard did not contain its executable script.')

  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === 'string'
      ? input
      : input instanceof URL ? input.pathname : new URL(input.url).pathname
    return fetchImplementation(path, init)
  }))
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  })))
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }))
  vi.stubGlobal('confirm', vi.fn(() => true))

  document.open()
  document.write(html.replace(/<script nonce="synthetic-script-nonce">[\s\S]*?<\/script>/, ''))
  document.close()

  // NOTICE:
  // The production boundary is an inline script returned by the Dashboard HTML renderer.
  // Vitest's jsdom executes document.write scripts in a shared realm, which would leak the
  // script's top-level lexical bindings between tests; an IIFE preserves browser semantics.
  // Source/context: services/discord-bot/src/standalone/dashboard-ui.ts.
  // Removal condition: delete this wrapper when the Dashboard moves to an importable browser entrypoint.
  new Script(`(() => {${inlineScript}\n})()`).runInThisContext()
  await settleDashboardTasks()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.documentElement.innerHTML = ''
})

/**
 * @example
 * describe('Discord audit D-020 Dashboard form lifecycle', () => {})
 */
describe('discord audit D-020 Dashboard form lifecycle', () => {
  /**
   * @example
   * it('renders diagnostic evidence truthfully and aborts a coalesced stale start before cancellation', async () => {})
   */
  it('renders diagnostic evidence truthfully and aborts a coalesced stale start before cancellation', async () => {
    const initial = {
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' },
      boundaries: [{ evidence: 'waiting', expectedEvidence: 'user-confirmation', id: 'text-reply-correct', status: 'unproven' }],
      deadlineAt: '2026-07-19T00:15:00.000Z',
      firstNonPassBoundary: 'text-reply-correct',
      firstUnprovenBoundary: 'text-reply-correct',
      phase: 'idle',
    }
    const cancelled = { ...initial, phase: 'cancelled' }
    let snapshot = initial
    let startRequests = 0
    let cancelRequests = 0
    let abortedStart = false

    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(dashboardConfig(), { state: { capabilityDiagnostics: snapshot } }))
      if (path === '/api/diagnostics/start') {
        startRequests += 1
        const signal = init?.signal
        if (signal)
          signal.addEventListener('abort', () => { abortedStart = true }, { once: true })
        return await responseRejectedWhenAborted(signal)
      }
      if (path === '/api/diagnostics/cancel') {
        cancelRequests += 1
        snapshot = cancelled
        return jsonResponse({ ok: true })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    /** @example expect(dashboardElement<HTMLButtonElement>('startCapabilityDiagnosticsButton').disabled).toBe(false) */
    expect(dashboardElement<HTMLButtonElement>('startCapabilityDiagnosticsButton').disabled).toBe(false)
    /** @example expect(dashboardElement<HTMLButtonElement>('cancelCapabilityDiagnosticsButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('cancelCapabilityDiagnosticsButton').disabled).toBe(true)
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true)
    /** @example expect(dashboardElement('capabilityDiagnosticsBoundaries').textContent).toContain('UNPROVEN · 需要用户确认 · 等待') */
    expect(dashboardElement('capabilityDiagnosticsBoundaries').textContent).toContain('UNPROVEN · 需要用户确认 · 等待')

    dashboardElement<HTMLButtonElement>('startCapabilityDiagnosticsButton').click()
    dashboardElement<HTMLButtonElement>('startCapabilityDiagnosticsButton').click()
    await settleDashboardTasks()
    /** @example expect(startRequests).toBe(1) */
    expect(startRequests).toBe(1)

    dashboardElement<HTMLButtonElement>('cancelCapabilityDiagnosticsButton').click()
    await settleDashboardTasks()
    /** @example expect(abortedStart).toBe(true) */
    expect(abortedStart).toBe(true)
    /** @example expect(cancelRequests).toBe(1) */
    expect(cancelRequests).toBe(1)
    /** @example expect(dashboardElement<HTMLButtonElement>('cancelCapabilityDiagnosticsButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('cancelCapabilityDiagnosticsButton').disabled).toBe(true)
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true)
  })

  /** @example it('enables only the exact first non-pass confirmation and visually owns its pending request', async () => {}) */
  it('enables only the exact first non-pass confirmation and visually owns its pending request', async () => {
    const ids = [
      'artifact-identity',
      'dashboard-api',
      'configuration',
      'bot-ready',
      'global-commands',
      'text-ingress',
      'text-reply-sent',
      'text-reply-correct',
      'voice-consent-join',
      'voice-transport',
      'voice-provider',
      'voice-speaking',
      'voice-opus-pcm-admission',
      'voice-provider-response',
      'voice-playback',
      'voice-heard',
      'voice-cleanup',
    ]
    const snapshot = {
      artifact: { artifactKind: 'standalone-discord-bot', diagnosticsContractVersion: '1', productVersion: 'test', startedAt: '2026-07-19T00:00:00.000Z' },
      boundaries: ids.map((id, index) => ({
        evidence: index < 7 ? 'automatic' : 'waiting',
        expectedEvidence: ['text-reply-correct', 'voice-consent-join', 'voice-heard'].includes(id) ? 'user-confirmation' : 'automatic',
        id,
        status: index < 7 ? 'pass' : 'unproven',
      })),
      deadlineAt: '2026-07-19T00:15:00.000Z',
      firstNonPassBoundary: 'text-reply-correct',
      firstUnprovenBoundary: 'text-reply-correct',
      phase: 'running',
    }
    const confirmation = createDeferred<Response>()
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(dashboardConfig(), { state: { capabilityDiagnostics: snapshot } }))
      if (path === '/api/diagnostics/confirm')
        return confirmation.promise
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(false) */
    expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(false)
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmVoiceConsentButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('confirmVoiceConsentButton').disabled).toBe(true)
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmVoiceHeardButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('confirmVoiceHeardButton').disabled).toBe(true)

    dashboardElement<HTMLButtonElement>('confirmTextReplyButton').click()
    await settleDashboardTasks()
    /** @example expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true) */
    expect(dashboardElement<HTMLButtonElement>('confirmTextReplyButton').disabled).toBe(true)
    confirmation.resolve(jsonResponse({ ok: true }))
    await settleDashboardTasks()
  })

  /**
   * @example
   * it('renders only allowlisted general events during initial and periodic status refresh', async () => {})
   */
  it('renders only allowlisted general events during initial and periodic status refresh', async () => {
    const sentinels = [
      'synthetic-dom-guild-name-sentinel',
      '939393939393939393',
      'https://synthetic.invalid/private?credential=sentinel',
      'synthetic-dom-error-message-sentinel',
    ]
    let requestCount = 0
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status') {
        requestCount += 1
        return jsonResponse(dashboardStatus(dashboardConfig(), {
          state: {
            botTag: sentinels[0],
            events: [{
              at: '2026-01-01T00:00:00.000Z',
              code: 'message-rejected',
              detail: `${sentinels[1]} ${sentinels[2]}`,
              failureCategory: sentinels[3],
              id: requestCount,
              kind: 'error',
              operationSequence: requestCount,
              reason: 'blocked-user',
              surface: 'text-guild',
              title: sentinels[3],
            }],
            lastError: `${sentinels[3]} ${sentinels[2]}`,
          },
        }))
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    // ROOT CAUSE:
    //
    // The generated Dashboard trusted arbitrary event title/detail and bot-tag
    // strings returned by status, then copied them directly into the DOM. The
    // periodic refresh repeated the same disclosure even though textContent
    // avoided script execution.
    let serialized = document.body.textContent ?? ''
    for (const sentinel of sentinels) {
      // @example
      expect(serialized).not.toContain(sentinel)
    }
    // @example
    expect(serialized).toContain('消息已过滤')
    // @example
    expect(serialized).toContain('用户已屏蔽')

    await vi.advanceTimersByTimeAsync(3_000)
    await settleDashboardTasks()
    serialized = document.body.textContent ?? ''
    for (const sentinel of sentinels) {
      // @example
      expect(serialized).not.toContain(sentinel)
    }
    // @example
    expect(serialized).toContain('消息已过滤')
  })

  /**
   * @example
   * it('renders only bounded allowlisted voice diagnostic stages and counters', async () => {})
   */
  it('renders only bounded allowlisted voice diagnostic stages and counters', async () => {
    // ROOT CAUSE:
    //
    // The voice runtime had no Dashboard projection, so a failed real voice turn could not
    // be segmented between Discord receive, provider response, and playback. Rendering the
    // raw provider or Discord event would make the local diagnostic page a content and
    // credential disclosure surface. The page must instead read only the fixed snapshot
    // schema and ignore every unrecognized field, even when a response is compromised.
    const privateSentinels = [
      'synthetic-private-transcript-sentinel',
      'synthetic-private-audio-sentinel',
      'wss://synthetic-private-endpoint.invalid/realtime?credential=sentinel',
      'synthetic-private-secret-sentinel',
      '919191919191919191',
    ]
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const snapshots = [
      {
        active: [{
          failureCategories: [],
          mode: 'qwen-realtime',
          outcome: 'no-input',
          providerReady: true,
          sessionSequence: 1,
          speaking: false,
          speakingEnds: 0,
          speakingStarts: 0,
          stage: 'provider-ready',
          transportReady: true,
          turns: [{
            inputAppends: 0,
            inputBytes: 0,
            inputCommits: 0,
            opusBytes: 0,
            opusPackets: 0,
            outcome: 'no-input',
            pcmBytes: 0,
            pcmFrames: 0,
            playbackAborted: 0,
            playbackCompleted: 0,
            playbackStarted: 0,
            providerVadTurns: 0,
            receiverAudioObserved: false,
            responseAudioBytes: 0,
            responseAudioChunks: 0,
            responsesCancelled: 0,
            responsesCompleted: 0,
            responsesStarted: 0,
            syntheticInputAppends: 0,
            syntheticInputBytes: 0,
            turnSequence: 1,
            userInputAppends: 0,
            userInputBytes: 0,
          }],
          transcript: privateSentinels[0],
        }],
        audioPayload: privateSentinels[1],
        completed: [],
        droppedSignals: 2,
        endpoint: privateSentinels[2],
        saturatedSessions: 1,
      },
      {
        active: [],
        completed: [{
          completionReason: 'dismissed',
          failureCategories: [],
          guildId: privateSentinels[4],
          mode: 'qwen-realtime',
          outcome: 'provider-no-response',
          providerReady: true,
          sessionSequence: 2,
          speaking: false,
          speakingEnds: 1,
          speakingStarts: 1,
          stage: 'completed',
          transportReady: true,
          turns: [{
            inputAppends: 2,
            inputBytes: 640,
            inputCommits: 1,
            opusBytes: 320,
            opusPackets: 2,
            outcome: 'provider-no-response',
            pcmBytes: 1280,
            pcmFrames: 2,
            playbackAborted: 0,
            playbackCompleted: 0,
            playbackStarted: 0,
            providerVadTurns: 1,
            receiverAudioObserved: true,
            responseAudioBytes: 0,
            responseAudioChunks: 0,
            responsesCancelled: 0,
            responsesCompleted: 0,
            responsesStarted: 1,
            secret: privateSentinels[3],
            syntheticInputAppends: 1,
            syntheticInputBytes: 320,
            turnSequence: 2,
            userInputAppends: 1,
            userInputBytes: 320,
          }],
        }],
        droppedSignals: 3,
        saturatedSessions: 1,
      },
      {
        active: [{
          failureCategories: [],
          mode: 'qwen-realtime',
          outcome: 'response-audio',
          providerReady: true,
          sessionSequence: 3,
          speaking: false,
          speakingEnds: 1,
          speakingStarts: 1,
          stage: 'playing',
          transportReady: true,
          turns: [{
            inputAppends: 1,
            inputBytes: 320,
            inputCommits: 1,
            opusBytes: 160,
            opusPackets: 1,
            outcome: 'response-audio',
            pcmBytes: 640,
            pcmFrames: 1,
            playbackAborted: 0,
            playbackCompleted: 1,
            playbackStarted: 1,
            playerState: 'idle',
            providerVadTurns: 1,
            receiverAudioObserved: true,
            responseAudioBytes: 2048,
            responseAudioChunks: 4,
            responsesCancelled: 0,
            responsesCompleted: 1,
            responsesStarted: 1,
            syntheticInputAppends: 0,
            syntheticInputBytes: 0,
            turnSequence: 3,
            userInputAppends: 1,
            userInputBytes: 320,
          }],
        }],
        completed: [],
        droppedSignals: 3,
        saturatedSessions: 1,
      },
      {
        active: [],
        completed: [{
          completionReason: 'failed',
          failureCategories: ['playback-error'],
          mode: 'qwen-realtime',
          outcome: 'player-failure',
          providerReady: true,
          sessionSequence: 4,
          speaking: false,
          speakingEnds: 1,
          speakingStarts: 1,
          stage: 'failed',
          transportReady: true,
          turns: [{
            failureCategory: 'playback-error',
            inputAppends: 1,
            inputBytes: 320,
            inputCommits: 1,
            opusBytes: 160,
            opusPackets: 1,
            outcome: 'player-failure',
            pcmBytes: 640,
            pcmFrames: 1,
            playbackAborted: 1,
            playbackCompleted: 0,
            playbackStarted: 1,
            playerState: 'error',
            providerVadTurns: 1,
            receiverAudioObserved: true,
            responseAudioBytes: 1024,
            responseAudioChunks: 2,
            responsesCancelled: 1,
            responsesCompleted: 0,
            responsesStarted: 1,
            syntheticInputAppends: 0,
            syntheticInputBytes: 0,
            turnSequence: 4,
            userInputAppends: 1,
            userInputBytes: 320,
          }],
        }],
        droppedSignals: 4,
        saturatedSessions: 2,
      },
    ]
    let statusRequest = 0
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status') {
        const voiceDiagnostics = snapshots[Math.min(statusRequest, snapshots.length - 1)]
        statusRequest += 1
        return jsonResponse(dashboardStatus(dashboardConfig(), { voiceDiagnostics }))
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('no-input')
    // @example
    expect(dashboardElement('voiceDiagnosticsDropped').textContent).toBe('丢弃 2')
    // @example
    expect(dashboardElement('voiceDiagnosticsSaturated').textContent).toBe('饱和 1')

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()
    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('provider-no-response')
    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('dismissed')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('Opus 2 / 320 B')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('Provider 输入 2 / 640 B')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('用户音频 1 / 320 B')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('静音填充 1 / 320 B / 提交 1')

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()
    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('response-audio')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('响应音频 4 / 2048 B')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('播放 1 / 1 / 0')

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()
    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('player-failure')
    // @example
    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toContain('failed')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('播放器 error')
    // @example
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('失败 playback-error')

    const serializedVisibleSurfaces = JSON.stringify({
      body: document.body.textContent,
      console: [...warning.mock.calls, ...error.mock.calls, ...log.mock.calls],
      html: renderAiriSettingsDashboardHtml('synthetic-script-nonce'),
    })
    for (const sentinel of privateSentinels) {
      // @example
      expect(serializedVisibleSurfaces).not.toContain(sentinel)
    }
  })

  /**
   * @example
   * it('does not refill or preview a saved Qwen Workspace ID for R-003', async () => {})
   */
  it('does not refill or preview a saved Qwen Workspace ID for R-003', async () => {
    const workspaceSentinel = 'synthetic-dom-workspace-sensitive-sentinel'
    const configBodies: Array<Record<string, unknown>> = []
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status') {
        return jsonResponse(dashboardStatus(dashboardConfig({
          // A stale or compromised same-origin response must not cause the page
          // to restore an exact saved value after the public contract is fixed.
          qwenRealtimeWorkspaceId: workspaceSentinel,
          qwenRealtimeWorkspaceIdConfigured: true,
        })))
      }
      if (path === '/api/config' && init?.method === 'POST') {
        configBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({ message: 'Synthetic unrelated save completed.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    // ROOT CAUSE:
    //
    // fillConfig assigned the public Workspace ID into a normal text input and
    // updateQwenRealtimeEndpointPreview embedded it in visible text. Submitting
    // any service change then posted the recovered value again as a raw string.
    const workspaceInput = dashboardElement<HTMLInputElement>('qwenRealtimeWorkspaceId')
    const endpointPreview = dashboardElement<HTMLElement>('qwenRealtimeEndpointPreview')

    // @example
    expect(workspaceInput.value).toBe('')
    // @example
    expect(workspaceInput.placeholder).toBe('已配置')
    // @example
    expect(endpointPreview.textContent).not.toContain(workspaceSentinel)

    editText('deepSeekModel', 'synthetic-unrelated-model')
    submitForm('serviceForm')
    await settleDashboardTasks()

    // @example
    expect(configBodies).toHaveLength(1)
    // @example
    expect(configBodies[0].qwenRealtimeWorkspaceId).toEqual({ action: 'unchanged' })
    // @example
    expect(JSON.stringify({ body: configBodies[0], dom: document.body.textContent })).not.toContain(workspaceSentinel)
  })

  /**
   * @example
   * it('coalesces hung periodic status and memory requests instead of creating a request storm', async () => {})
   */
  it('coalesces hung periodic status and memory requests instead of creating a request storm (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // setInterval started a new status and memory request every three seconds even while
    // the prior fetch was unresolved. A stalled local HTTP boundary therefore accumulated
    // unbounded promises and network requests for the lifetime of the Dashboard page.
    const hungStatus = createDeferred<Response>()
    const hungMemory = createDeferred<Response>()
    let memoryRequests = 0
    let statusRequests = 0
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/status') {
        statusRequests += 1
        return statusRequests === 1 ? jsonResponse(dashboardStatus()) : hungStatus.promise
      }
      if (path === '/api/memory') {
        memoryRequests += 1
        return memoryRequests === 1
          ? jsonResponse({ config: { memoryEnabled: false }, memories: [] })
          : hungMemory.promise
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await settleDashboardTasks()

    expect(statusRequests).toBe(2)
    expect(memoryRequests).toBe(2)
  })

  /**
   * @example
   * it('surfaces a sanitized visible periodic refresh failure', async () => {})
   */
  it('surfaces a sanitized visible periodic refresh failure (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The periodic refresh ended in catch(() => {}), so operators saw stale status with no
    // indication that polling had failed. Passing the raw rejection through would expose
    // transport details, so the browser boundary needs a stable visible failure message.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let statusRequests = 0
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status') {
        statusRequests += 1
        if (statusRequests === 1)
          return jsonResponse(dashboardStatus())
        throw new Error('SYNTHETIC_PRIVATE_POLL_DETAIL')
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement('serviceToast').textContent).toBe('自动状态刷新失败，请手动刷新。')
    expect(dashboardElement('serviceToast').textContent).not.toContain('SYNTHETIC_PRIVATE_POLL_DETAIL')
    expect(warning).toHaveBeenCalledWith('[airi-dashboard] automatic status refresh failed')
  })

  /**
   * @example
   * it('does not let an old automatic poll failure overwrite newer save errors', async () => {})
   */
  it('does not let an old automatic poll failure overwrite newer save errors (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The automatic status and memory rejection handlers wrote directly to their fixed
    // toast surfaces. A poll started before a save could therefore reject afterward and
    // replace the newer validation or network error that the operator needed to act on.
    //
    // Each automatic refresh owner now captures the corresponding toast generation when
    // its real request starts. Automatic failures remain structurally observable, but an
    // automatic writer cannot replace an uncleared foreground/save message even when a
    // later poll starts after that message was published.
    const pendingMemoryPoll = createDeferred<Response>()
    const pendingStatusPoll = createDeferred<Response>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let configRequests = 0
    let memoryRequests = 0
    let statusRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/status') {
        statusRequests += 1
        if (statusRequests === 1)
          return jsonResponse(dashboardStatus())
        if (statusRequests === 2)
          return pendingStatusPoll.promise
        throw new Error('SYNTHETIC_NEW_STATUS_POLL_FAILURE')
      }
      if (path === '/api/memory') {
        memoryRequests += 1
        if (memoryRequests === 1)
          return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
        if (memoryRequests === 2)
          return pendingMemoryPoll.promise
        throw new Error('SYNTHETIC_NEW_MEMORY_POLL_FAILURE')
      }
      if (path === '/api/config' && init?.method === 'POST') {
        configRequests += 1
        if (configRequests === 1)
          return jsonResponse({ error: 'Synthetic service validation failure.' }, 400)
        throw new Error('Synthetic memory network failure.')
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    await vi.advanceTimersByTimeAsync(3000)

    submitForm('serviceForm')
    await settleDashboardTasks()
    const memoryEnabled = dashboardElement<HTMLInputElement>('memoryEnabled')
    memoryEnabled.checked = true
    memoryEnabled.dispatchEvent(new Event('change', { bubbles: true }))
    await settleDashboardTasks()

    expect(dashboardElement('serviceToast').textContent).toBe('请求未通过验证。')
    expect(dashboardElement('memoryToast').textContent).toBe('请求失败，请稍后重试。')

    pendingStatusPoll.reject(new Error('SYNTHETIC_OLD_STATUS_POLL_FAILURE'))
    pendingMemoryPoll.reject(new Error('SYNTHETIC_OLD_MEMORY_POLL_FAILURE'))
    await settleDashboardTasks()

    expect(dashboardElement('serviceToast').textContent).toBe('请求未通过验证。')
    expect(dashboardElement('memoryToast').textContent).toBe('请求失败，请稍后重试。')
    expect(warning).toHaveBeenCalledWith('[airi-dashboard] automatic status refresh failed')
    expect(warning).toHaveBeenCalledWith('[airi-dashboard] automatic memory refresh failed')

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement('serviceToast').textContent).toBe('请求未通过验证。')
    expect(dashboardElement('memoryToast').textContent).toBe('请求失败，请稍后重试。')
    expect(document.body.textContent).not.toContain('Synthetic service validation failure.')
    expect(document.body.textContent).not.toContain('Synthetic memory network failure.')
    expect(warning).toHaveBeenCalledTimes(4)
    expect(statusRequests).toBe(3)
    expect(memoryRequests).toBe(3)
  })

  /**
   * @example
   * it('aborts a hung foreground refresh at its deadline without clearing its replacement', async () => {})
   */
  it('aborts a hung foreground refresh at its deadline without clearing its replacement (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Coalescing capped request count but left a never-settling fetch in its foreground slot
    // forever. Save and manual refresh then reused that orphan indefinitely. The owner needs
    // a real AbortSignal deadline, and cleanup must compare record identity before deletion.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const replacement = createDeferred<Response>()
    let firstForegroundSignal: AbortSignal | null | undefined
    let replacementSignal: AbortSignal | null | undefined
    let replacementRequested = false
    let statusRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path !== '/api/status')
        throw new Error(`Unexpected Dashboard request: ${path}`)
      statusRequests += 1
      if (statusRequests === 1)
        return jsonResponse(dashboardStatus())
      if (statusRequests === 2) {
        firstForegroundSignal = init?.signal
        return responseRejectedWhenAborted(firstForegroundSignal)
      }
      if (replacementRequested) {
        replacementRequested = false
        replacementSignal = init?.signal
        return replacement.promise
      }
      return jsonResponse(dashboardStatus())
    })

    dashboardElement<HTMLButtonElement>('refreshButton').click()
    await settleDashboardTasks()
    await vi.advanceTimersByTimeAsync(10_000)
    await settleDashboardTasks()

    expect(firstForegroundSignal?.aborted).toBe(true)

    const requestsBeforeReplacement = statusRequests
    replacementRequested = true
    dashboardElement<HTMLButtonElement>('refreshButton').click()
    await settleDashboardTasks()
    expect(statusRequests).toBe(requestsBeforeReplacement + 1)

    dashboardElement<HTMLButtonElement>('refreshButton').click()
    await settleDashboardTasks()
    expect(statusRequests).toBe(requestsBeforeReplacement + 1)
    expect(replacementSignal?.aborted).toBe(false)
    expect(warning).toHaveBeenCalledWith('[airi-dashboard] foreground refresh failed')

    replacement.resolve(jsonResponse(dashboardStatus(dashboardConfig({ adminRoleIdsText: 'replacement-admin' }))))
    await settleDashboardTasks()
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('replacement-admin')
  })

  /**
   * @example
   * it('aborts owned refreshes and stops polling when the Dashboard page is discarded', async () => {})
   */
  it('aborts owned refreshes and stops polling when the Dashboard page is discarded (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The page-owned interval and fetches had no pagehide cleanup. Browser teardown usually
    // masks that omission, but a retained page could keep timers and local REST work alive.
    let hungStatusSignal: AbortSignal | null | undefined
    let memoryRequests = 0
    let statusRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory') {
        memoryRequests += 1
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      }
      if (path !== '/api/status')
        throw new Error(`Unexpected Dashboard request: ${path}`)
      statusRequests += 1
      if (statusRequests === 1)
        return jsonResponse(dashboardStatus())
      hungStatusSignal = init?.signal
      return responseRejectedWhenAborted(hungStatusSignal)
    })

    await vi.advanceTimersByTimeAsync(3000)
    window.dispatchEvent(new Event('pagehide'))
    await settleDashboardTasks()
    await vi.advanceTimersByTimeAsync(30_000)
    await settleDashboardTasks()

    expect(hungStatusSignal?.aborted).toBe(true)
    expect(statusRequests).toBe(2)
    expect(memoryRequests).toBe(2)
  })

  /**
   * @example
   * it('hard-caps and aborts hung manual requests when the Dashboard is discarded for Discord audit D-020', async () => {})
   */
  it('hard-caps and aborts hung manual requests when the Dashboard is discarded (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Poll and config-save requests gained scoped owners, but manual bot and
    // memory mutations still called the raw fetch boundary without a deadline,
    // AbortSignal, or registry. Repeated clicks therefore created an unbounded
    // number of promises that survived pagehide.
    //
    // The shared request boundary now owns every controller and deadline,
    // rejects excess work per operation, and aborts all retained owners when
    // the page is discarded.
    const actionSignals: Array<AbortSignal | null | undefined> = []
    const memorySignals: Array<AbortSignal | null | undefined> = []
    let actionRequests = 0
    let memoryMutationRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/status')
        return jsonResponse(dashboardStatus())
      if (path === '/api/memory' && init?.method !== 'POST')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/bot/start') {
        actionRequests += 1
        actionSignals.push(init?.signal)
        return responseRejectedWhenAborted(init?.signal)
      }
      if (path === '/api/memory' && init?.method === 'POST') {
        memoryMutationRequests += 1
        memorySignals.push(init.signal)
        return responseRejectedWhenAborted(init.signal)
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    dashboardElement<HTMLSelectElement>('memoryScope').value = 'session'
    editText('memoryContent', 'synthetic-memory-sentinel')
    for (let index = 0; index < 20; index += 1) {
      dashboardElement<HTMLButtonElement>('startButton').click()
      submitForm('memoryForm')
    }
    await settleDashboardTasks()

    expect(actionRequests).toBe(1)
    expect(memoryMutationRequests).toBe(1)
    expect(actionSignals[0]?.aborted).toBe(false)
    expect(memorySignals[0]?.aborted).toBe(false)

    window.dispatchEvent(new Event('pagehide'))
    await settleDashboardTasks()

    expect(actionSignals[0]?.aborted).toBe(true)
    expect(memorySignals[0]?.aborted).toBe(true)
  })

  /**
   * @example
   * it('rejects a non-cooperative manual request after its deadline without publishing a late result for Discord audit D-020', async () => {})
   */
  it('rejects a non-cooperative manual request after its deadline without publishing a late result (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Aborting only refresh/save owners did not cover a provider boundary that
    // ignored AbortSignal. A late manual action result could still update the
    // retained page, while repeated actions kept allocating more work.
    //
    // The request registry retains non-cooperative work until actual settlement,
    // refuses another operation in the same slot, and gates the late result after
    // its absolute deadline.
    const lateAction = createDeferred<Response>()
    let actionRequests = 0
    let actionSignal: AbortSignal | null | undefined
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/status')
        return jsonResponse(dashboardStatus())
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/bot/restart') {
        actionRequests += 1
        actionSignal = init?.signal
        return lateAction.promise
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    dashboardElement<HTMLButtonElement>('restartButton').click()
    await vi.advanceTimersByTimeAsync(10_000)
    await settleDashboardTasks()

    expect(actionSignal?.aborted).toBe(true)
    expect(actionRequests).toBe(1)

    dashboardElement<HTMLButtonElement>('restartButton').click()
    await settleDashboardTasks()
    expect(actionRequests).toBe(1)
    expect(dashboardElement('serviceToast').textContent).toBe('请求正在处理中，请稍后重试。')

    lateAction.resolve(jsonResponse({ message: 'SYNTHETIC_LATE_ACTION_SUCCESS' }))
    await settleDashboardTasks()

    expect(dashboardElement('serviceToast').textContent).toBe('请求超时或已取消，请重试。')
    expect(dashboardElement('serviceToast').textContent).not.toContain('SYNTHETIC_LATE_ACTION_SUCCESS')
  })

  /**
   * @example
   * it('aborts a hung config save and permits a clean replacement save', async () => {})
   */
  it('aborts a hung config save and permits a clean replacement save (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Form save generations gated late UI publication but did not cancel or deadline the
    // underlying REST request. Repeated submit could therefore retain one orphan fetch per
    // generation even though only the latest result was allowed to update form state.
    let configRequests = 0
    let firstSaveSignal: AbortSignal | null | undefined
    let statusConfig = dashboardConfig()
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST') {
        configRequests += 1
        if (configRequests === 1) {
          firstSaveSignal = init.signal
          return responseRejectedWhenAborted(firstSaveSignal)
        }
        statusConfig = dashboardConfig({ allowedChannelIdsText: 'replacement-saved-filter' })
        return jsonResponse({ message: 'Saved replacement.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'hung-save-filter')
    submitForm('filterForm')
    await vi.advanceTimersByTimeAsync(10_000)
    await settleDashboardTasks()

    expect(firstSaveSignal?.aborted).toBe(true)
    expect(dashboardElement('filterToast').textContent).toBe('配置保存超时，请重试。')

    editText('allowedChannelIdsText', 'replacement-save-filter')
    submitForm('filterForm')
    await settleDashboardTasks()

    expect(configRequests).toBe(2)
    expect(dashboardElement('filterToast').textContent).toBe('Saved replacement.')
    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('replacement-saved-filter')
  })

  /**
   * @example
   * it('delivers the latest same-domain save after superseding an active request', async () => {})
   */
  it('delivers the latest same-domain save after superseding an active request (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // A replacement save aborted the prior form owner and immediately called
    // requestJson(). The aborted transport remained in the bounded registry until
    // actual settlement, so the per-operation limit rejected the replacement
    // itself. The stale request was then discarded and the latest payload was
    // never sent.
    //
    // The form lifecycle now retains one active transport plus one coalesced
    // latest payload and dispatches that payload only after the active transport
    // actually settles.
    const firstSave = createDeferred<Response>()
    const configBodies: Array<Record<string, unknown>> = []
    let statusConfig = dashboardConfig()
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST') {
        configBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        if (configBodies.length === 1)
          return firstSave.promise
        statusConfig = dashboardConfig({ allowedChannelIdsText: 'canonical-latest-filter' })
        return jsonResponse({ message: 'Saved latest filter.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'stale-filter')
    submitForm('filterForm')
    await settleDashboardTasks()
    editText('allowedChannelIdsText', 'coalesced-middle-filter')
    submitForm('filterForm')
    await settleDashboardTasks()
    editText('allowedChannelIdsText', 'latest-filter')
    submitForm('filterForm')
    await settleDashboardTasks()

    firstSave.resolve(jsonResponse({ message: 'Saved stale filter.' }))
    await settleDashboardTasks()

    expect(configBodies).toHaveLength(2)
    expect(configBodies[0]).toMatchObject({ allowedChannelIdsText: 'stale-filter' })
    expect(configBodies[1]).toMatchObject({ allowedChannelIdsText: 'latest-filter' })
    expect(dashboardElement('filterToast').textContent).toBe('Saved latest filter.')
    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('latest-filter')
  })

  /**
   * @example
   * it('reports a failed post-save refresh before its non-cooperative sibling settles', async () => {})
   */
  it('reports a failed post-save refresh before its non-cooperative sibling settles (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The config POST could settle successfully, but executeConfigSave() kept the
    // domain queue active while awaiting its follow-up status and memory refreshes.
    // A refresh transport that ignored AbortSignal then prevented the coalesced
    // latest config payload from ever reaching the already-free POST boundary.
    //
    // The save queue now completes at POST settlement. Each refresh branch observes
    // its first failure immediately, while one all-settlement owner retains both real
    // tasks and prevents replacement refreshes until the hung sibling actually settles.
    const hungPostSaveMemory = createDeferred<Response>()
    const hungPostSaveStatus = createDeferred<Response>()
    const configBodies: Array<Record<string, unknown>> = []
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let memoryRequests = 0
    let statusRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory') {
        memoryRequests += 1
        if (memoryRequests === 2)
          return hungPostSaveMemory.promise
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      }
      if (path === '/api/status') {
        statusRequests += 1
        if (statusRequests === 1)
          return jsonResponse(dashboardStatus())
        if (statusRequests === 2)
          return hungPostSaveStatus.promise
        return jsonResponse(dashboardStatus(dashboardConfig({
          allowedChannelIdsText: 'canonical-latest-filter-after-settlement',
        })))
      }
      if (path === '/api/config' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        configBodies.push(body)
        return jsonResponse({ message: configBodies.length === 1 ? 'Saved first filter.' : 'Saved latest filter.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'first-filter')
    submitForm('filterForm')
    await settleDashboardTasks()
    expect(configBodies).toHaveLength(1)

    hungPostSaveStatus.reject(new Error('SYNTHETIC_NON_COOPERATIVE_REFRESH_FAILURE'))
    await settleDashboardTasks()

    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledWith('[airi-dashboard] post-save status refresh failed')
    expect(dashboardElement('filterToast').textContent).toBe('Saved first filter. 状态刷新失败，请手动刷新。')

    editText('allowedChannelIdsText', 'latest-filter-after-settlement')
    submitForm('filterForm')
    await settleDashboardTasks()

    expect(configBodies).toHaveLength(2)
    expect(configBodies[0]).toMatchObject({ allowedChannelIdsText: 'first-filter' })
    expect(configBodies[1]).toMatchObject({ allowedChannelIdsText: 'latest-filter-after-settlement' })
    expect(dashboardElement('filterToast').textContent).toBe('Saved latest filter.')

    editText('allowedChannelIdsText', 'latest-filter-after-partial-refresh-failure')
    submitForm('filterForm')
    await settleDashboardTasks()

    expect(configBodies).toHaveLength(3)
    expect(statusRequests).toBe(2)
    expect(memoryRequests).toBe(2)
    expect(warning).toHaveBeenCalledTimes(1)

    hungPostSaveMemory.resolve(jsonResponse({ config: { memoryEnabled: false }, memories: [] }))
    await settleDashboardTasks()

    expect(statusRequests).toBe(3)
    expect(memoryRequests).toBe(3)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(dashboardElement('filterToast').textContent).toBe('Saved latest filter.')
  })

  /**
   * @example
   * it('does not let an old config refresh failure overwrite a newer toast operation', async () => {})
   */
  it('does not let an old config refresh failure overwrite a newer toast operation (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Post-save failure publication checked only the config form save generation.
    // A newer character reset, service action, or memory action can reuse the same
    // toast surface without changing that save generation. When a delayed refresh
    // failure finally settled, it therefore replaced the newer operation's message.
    //
    // Every fixed toast surface now owns an operation generation. A post-save
    // notification may publish only while both its save and toast generations match.
    const postSaveMemory = createDeferred<Response>()
    const postSaveStatus = createDeferred<Response>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let memoryRequests = 0
    let statusRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory') {
        memoryRequests += 1
        if (memoryRequests === 2)
          return postSaveMemory.promise
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      }
      if (path === '/api/status') {
        statusRequests += 1
        if (statusRequests === 2)
          return postSaveStatus.promise
        return jsonResponse(dashboardStatus())
      }
      if (path === '/api/config' && init?.method === 'POST')
        return jsonResponse({ message: 'Saved character config.' })
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    submitForm('roleForm')
    await settleDashboardTasks()
    expect(dashboardElement('roleToast').textContent).toBe('Saved character config.')

    dashboardElement<HTMLButtonElement>('resetCharacterButton').click()
    expect(dashboardElement('roleToast').textContent).toBe('已重置为默认 airi 角色卡。点“保存角色卡”后生效。')

    postSaveStatus.reject(new Error('SYNTHETIC_STALE_CONFIG_REFRESH_FAILURE'))
    await settleDashboardTasks()

    postSaveMemory.resolve(jsonResponse({ config: { memoryEnabled: false }, memories: [] }))
    await settleDashboardTasks()

    expect(dashboardElement('roleToast').textContent).toBe('已重置为默认 airi 角色卡。点“保存角色卡”后生效。')
    expect(warning).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * it('cancels page transition owners when the Dashboard page is discarded', async () => {})
   */
  it('cancels page transition owners when the Dashboard page is discarded (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // pagehide cleared polling and request deadlines but omitted showPage()'s
    // transition timeout and animation-frame callback. Navigating immediately before
    // page disposal left both callbacks able to mutate a retained document afterward.
    //
    // The page lifecycle now owns and cancels both handles deterministically.
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/status')
        return jsonResponse(dashboardStatus())
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })
    const cancelAnimationFrameMock = vi.fn()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 47))
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    const serviceNavigation = document.querySelector<HTMLButtonElement>('[data-nav="service"]')
    if (!serviceNavigation)
      throw new Error('Missing generated service navigation button.')
    serviceNavigation.click()

    expect(vi.getTimerCount()).toBeGreaterThan(0)
    window.dispatchEvent(new Event('pagehide'))
    await settleDashboardTasks()

    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(47)
    expect(vi.getTimerCount()).toBe(0)
  })

  /**
   * @example
   * it('clears the config save deadline and queued work when the page is discarded', async () => {})
   */
  it('clears the config save deadline and queued work when the page is discarded (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // A config save owned both the shared request deadline and an execute-layer
    // deadline used to classify save cancellation. pagehide cleared only the
    // shared owner, leaving the execute timer alive until its ten-second expiry.
    // A coalesced save also had to be settled without starting after disposal.
    //
    // Page disposal now clears both timers, aborts the actual active transport,
    // settles queued work, and retains only the bounded active owner until the
    // non-cooperative transport actually settles.
    const activeSave = createDeferred<Response>()
    let activeSaveSignal: AbortSignal | null | undefined
    let configRequests = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/status')
        return jsonResponse(dashboardStatus())
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/config' && init?.method === 'POST') {
        configRequests += 1
        activeSaveSignal = init.signal
        return activeSave.promise
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'active-save')
    submitForm('filterForm')
    await settleDashboardTasks()
    editText('allowedChannelIdsText', 'queued-save')
    submitForm('filterForm')
    await settleDashboardTasks()

    expect(configRequests).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    window.dispatchEvent(new Event('pagehide'))
    await settleDashboardTasks()

    expect(activeSaveSignal?.aborted).toBe(true)
    expect(configRequests).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    activeSave.resolve(jsonResponse({ message: 'SYNTHETIC_LATE_SAVE_SUCCESS' }))
    await settleDashboardTasks()
    expect(configRequests).toBe(1)
    expect(dashboardElement('filterToast').textContent).not.toContain('SYNTHETIC_LATE_SAVE_SUCCESS')
  })

  /**
   * @example
   * it('preserves unsaved filter and scoped-rule edits across periodic refresh', async () => {})
   */
  it('preserves unsaved filter and scoped-rule edits across periodic refresh (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The three-second status poll called fillConfig(), which unconditionally assigned
    // allow/block/term/rule controls. Unlike service and character inputs, these domains
    // had no initialized/dirty state, so one poll erased every unsaved local edit.
    const statuses = [
      dashboardStatus(),
      dashboardStatus(dashboardConfig({
        allowedChannelIdsText: 'new-remote-allowed',
        blockedGuildIdsText: 'new-remote-blocked-guild',
        blockedTermsText: 'new-remote-term',
        blockedUserIdsText: 'new-remote-blocked-user',
        channelRulesText: 'new-remote-channel-rule',
        guildRulesText: 'new-remote-guild-rule',
      })),
    ]
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(statuses.shift())
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'local allowed  1\n2')
    editText('blockedUserIdsText', 'local-user')
    editText('blockedGuildIdsText', 'local-guild')
    editText('blockedTermsText', 'local term\n\nsecond term')
    editText('guildRulesText', 'local guild rule')
    editText('channelRulesText', 'local channel rule')

    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('local allowed  1\n2')
    expect(dashboardElement<HTMLTextAreaElement>('blockedUserIdsText').value).toBe('local-user')
    expect(dashboardElement<HTMLTextAreaElement>('blockedGuildIdsText').value).toBe('local-guild')
    expect(dashboardElement<HTMLTextAreaElement>('blockedTermsText').value).toBe('local term\n\nsecond term')
    expect(dashboardElement<HTMLTextAreaElement>('guildRulesText').value).toBe('local guild rule')
    expect(dashboardElement<HTMLTextAreaElement>('channelRulesText').value).toBe('local channel rule')
  })

  /**
   * @example
   * it('preserves unsaved Discord privacy switches across periodic refresh', async () => {})
   */
  it('preserves unsaved Discord privacy switches across periodic refresh (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The packaged Dashboard refreshed its status every three seconds and wrote the
    // last persisted privacy flags into both checkboxes unconditionally. Toggling a
    // switch shortly before the next poll therefore made it appear to recover after
    // one or two seconds, before the user could reach the form's save action.
    //
    // The Discord form lifecycle now marks checkbox changes dirty and rejects remote
    // form hydration until that local draft is saved or the page is discarded.
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus())
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    toggleCheckbox('privacyNoticeEnabled', false)
    toggleCheckbox('memoryConsentRequired', false)
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLInputElement>('privacyNoticeEnabled').checked).toBe(false)
    expect(dashboardElement<HTMLInputElement>('memoryConsentRequired').checked).toBe(false)
    expect(dashboardElement<HTMLElement>('discordUnsavedState').hidden).toBe(false)
  })

  /**
   * @example
   * it('refreshes clean domains and status while another domain is dirty', async () => {})
   */
  it('refreshes clean domains and status while another domain is dirty (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // A single global refresh path owned status and every config control. Fixing this with
    // one global dirty flag would protect edits but incorrectly freeze unrelated clean forms.
    const statuses = [
      dashboardStatus(),
      dashboardStatus(dashboardConfig({
        adminRoleIdsText: 'external-admin',
        guildRulesText: 'external-clean-rule',
      }), { acceptedMessages: 9 }),
    ]
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(statuses.shift())
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('blockedTermsText', 'unsaved-local-term')
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('blockedTermsText').value).toBe('unsaved-local-term')
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('external-admin')
    expect(dashboardElement<HTMLTextAreaElement>('guildRulesText').value).toBe('external-clean-rule')
    expect(dashboardElement('acceptedMessages').textContent).toBe('9')
  })

  /**
   * @example
   * it('ignores an older status response that arrives after a newer clean refresh', async () => {})
   */
  it('ignores an older status response that arrives after a newer clean refresh (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // refresh() had no request generation. Concurrent polls applied in completion order,
    // allowing an older config snapshot to overwrite a newer clean external update.
    const oldPoll = createDeferred<Response>()
    const newPoll = createDeferred<Response>()
    let statusRequest = 0
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path !== '/api/status')
        throw new Error(`Unexpected Dashboard request: ${path}`)
      statusRequest += 1
      if (statusRequest === 1)
        return jsonResponse(dashboardStatus())
      if (statusRequest === 2)
        return oldPoll.promise
      if (statusRequest === 3)
        return newPoll.promise
      throw new Error(`Unexpected status request: ${statusRequest}`)
    })

    await vi.advanceTimersByTimeAsync(3000)
    dashboardElement<HTMLButtonElement>('refreshButton').click()
    await settleDashboardTasks()
    newPoll.resolve(jsonResponse(dashboardStatus(dashboardConfig({ adminRoleIdsText: 'newest-admin' }))))
    await settleDashboardTasks()
    oldPoll.resolve(jsonResponse(dashboardStatus(dashboardConfig({ adminRoleIdsText: 'stale-admin' }))))
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('newest-admin')
  })

  /**
   * @example
   * it('preserves local input and dirty state after validation or network save failure', async () => {})
   */
  it('preserves local input and dirty state after validation or network save failure (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Discord/filter saves had no form-owned saving or dirty lifecycle. Their catch handlers
    // showed an error, but the next poll immediately replaced the failed payload in the DOM.
    let statusConfig = dashboardConfig()
    let saveAttempt = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST') {
        saveAttempt += 1
        if (saveAttempt === 1)
          return jsonResponse({ error: 'Synthetic validation failure.' }, 400)
        throw new Error('Synthetic network failure.')
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'local-after-validation')
    submitForm('filterForm')
    await settleDashboardTasks()
    statusConfig = dashboardConfig({ allowedChannelIdsText: 'remote-after-validation' })
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('local-after-validation')
    expect(dashboardElement('filterToast').textContent).toBe('请求未通过验证。')

    editText('adminRoleIdsText', 'local-after-network')
    submitForm('discordForm')
    await settleDashboardTasks()
    statusConfig = dashboardConfig({ adminRoleIdsText: 'remote-after-network' })
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('local-after-network')
    expect(dashboardElement('discordToast').textContent).toBe('请求失败，请稍后重试。')
    expect(document.body.textContent).not.toContain('Synthetic validation failure.')
    expect(document.body.textContent).not.toContain('Synthetic network failure.')
  })

  /**
   * @example
   * it('does not let a pre-save poll overwrite a successful save or newer local edit', async () => {})
   */
  it('does not let a pre-save poll overwrite a successful save or newer local edit (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // saveConfig() reset state and issued refresh() without fencing already pending status
    // requests. A pre-save response could arrive after success and overwrite the saved value.
    const stalePoll = createDeferred<Response>()
    const save = createDeferred<Response>()
    const postSaveRefresh = createDeferred<Response>()
    let statusRequest = 0
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/config' && init?.method === 'POST')
        return save.promise
      if (path !== '/api/status')
        throw new Error(`Unexpected Dashboard request: ${path}`)
      statusRequest += 1
      if (statusRequest === 1)
        return jsonResponse(dashboardStatus())
      if (statusRequest === 2)
        return stalePoll.promise
      if (statusRequest === 3)
        return postSaveRefresh.promise
      throw new Error(`Unexpected status request: ${statusRequest}`)
    })

    await vi.advanceTimersByTimeAsync(3000)
    editText('allowedChannelIdsText', 'submitted-value')
    submitForm('filterForm')
    save.resolve(jsonResponse({ message: 'Saved.' }))
    await settleDashboardTasks()

    stalePoll.resolve(jsonResponse(dashboardStatus(dashboardConfig({ allowedChannelIdsText: 'stale-value' }))))
    await settleDashboardTasks()
    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('submitted-value')

    editText('allowedChannelIdsText', 'newer-local-value')
    postSaveRefresh.resolve(jsonResponse(dashboardStatus(dashboardConfig({ allowedChannelIdsText: 'server-saved-value' }))))
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('newer-local-value')
  })

  /**
   * @example
   * it('keeps a post-submit edit that equals the former baseline visibly unsaved', async () => {})
   */
  it('keeps a post-submit edit that equals the former baseline visibly unsaved (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Dirty tracking compared edits made during a save with the pre-save
    // baseline. If the user changed submitted B back to old baseline A, the form
    // became clean even though the successful save made B the remote baseline.
    // The post-save refresh then overwrote the newer local A edit with B.
    //
    // Edits made while a save owns the domain stay dirty regardless of the old
    // baseline, and a dedicated domain indicator remains visible until that exact
    // edit generation is successfully saved.
    const save = createDeferred<Response>()
    let statusConfig = dashboardConfig()
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST')
        return save.promise
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'submitted-filter')
    submitForm('filterForm')
    await settleDashboardTasks()
    editText('allowedChannelIdsText', 'remote-allowed')
    statusConfig = dashboardConfig({ allowedChannelIdsText: 'canonical-submitted-filter' })
    save.resolve(jsonResponse({ message: 'Saved submitted filter.' }))
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('remote-allowed')
    expect(dashboardElement<HTMLElement>('filterUnsavedState').hidden).toBe(false)
    expect(dashboardElement('filterUnsavedState').textContent).toBe('过滤设置未保存')
    expect(dashboardElement('filterToast').textContent).toBe('Saved submitted filter.')
  })

  /**
   * @example
   * it('shows independent unsaved state through failure and clears only a successful domain', async () => {})
   */
  it('shows independent unsaved state through failure and clears only a successful domain (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // Domain dirty flags protected controls from refresh but were invisible.
    // Operators could not distinguish a clean remote baseline from preserved
    // unsaved input, especially after validation/network failure.
    //
    // Each domain now renders its own indicator independently from the save/error
    // toast; only a successful save of the same edit generation clears it.
    let saveAttempt = 0
    let statusConfig = dashboardConfig()
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST') {
        saveAttempt += 1
        if (saveAttempt === 1)
          return jsonResponse({ error: 'Synthetic visible validation failure.' }, 400)
        statusConfig = dashboardConfig({ allowedChannelIdsText: 'canonical-visible-filter' })
        return jsonResponse({ message: 'Saved visible filter.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'visible-filter')
    editText('adminRoleIdsText', 'visible-discord')
    expect(dashboardElement<HTMLElement>('filterUnsavedState').hidden).toBe(false)
    expect(dashboardElement<HTMLElement>('discordUnsavedState').hidden).toBe(false)

    submitForm('filterForm')
    await settleDashboardTasks()
    expect(dashboardElement('filterToast').textContent).toBe('请求未通过验证。')
    expect(document.body.textContent).not.toContain('Synthetic visible validation failure.')
    expect(dashboardElement<HTMLElement>('filterUnsavedState').hidden).toBe(false)
    expect(dashboardElement<HTMLElement>('discordUnsavedState').hidden).toBe(false)

    submitForm('filterForm')
    await settleDashboardTasks()
    expect(dashboardElement('filterToast').textContent).toBe('Saved visible filter.')
    expect(dashboardElement<HTMLElement>('filterUnsavedState').hidden).toBe(true)
    expect(dashboardElement<HTMLElement>('discordUnsavedState').hidden).toBe(false)
  })

  /**
   * @example
   * it('resets only submitted domains after save and accepts later clean external refresh', async () => {})
   */
  it('resets only submitted domains after save and accepts later clean external refresh (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The former saveConfig() cleared every secret field and refreshed every form after any
    // save. It had no corresponding-form baseline, so unrelated dirty input was not isolated.
    let statusConfig = dashboardConfig()
    const configBodies: Array<Record<string, unknown>> = []
    await executeGeneratedDashboard(async (path, init) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(dashboardStatus(statusConfig))
      if (path === '/api/config' && init?.method === 'POST') {
        configBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return jsonResponse({ message: 'Saved.' })
      }
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('allowedChannelIdsText', 'saved-filter')
    editText('adminRoleIdsText', 'unsaved-discord')
    submitForm('filterForm')
    statusConfig = dashboardConfig({
      adminRoleIdsText: 'remote-discord',
      allowedChannelIdsText: 'canonical-saved-filter',
    })
    await settleDashboardTasks()

    expect(dashboardElement<HTMLTextAreaElement>('allowedChannelIdsText').value).toBe('canonical-saved-filter')
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('unsaved-discord')
    expect(configBodies[0]).toMatchObject({
      allowedChannelIdsText: 'saved-filter',
      channelRulesText: 'remote-channel-rule',
      guildRulesText: 'remote-guild-rule',
    })
    expect(configBodies[0]).not.toHaveProperty('adminRoleIdsText')
    expect(configBodies[0]).not.toHaveProperty('discordToken')

    editText('adminRoleIdsText', 'saved-discord')
    submitForm('discordForm')
    statusConfig = dashboardConfig({ adminRoleIdsText: 'canonical-saved-discord' })
    await settleDashboardTasks()
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('canonical-saved-discord')
    expect(configBodies[1]).toMatchObject({ adminRoleIdsText: 'saved-discord' })
    expect(configBodies[1]).not.toHaveProperty('allowedChannelIdsText')
    expect(configBodies[1]).not.toHaveProperty('guildRulesText')

    statusConfig = dashboardConfig({ adminRoleIdsText: 'external-clean-discord' })
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('external-clean-discord')
  })

  /**
   * @example
   * it('keeps service and character edits while clean Discord fields initialize', async () => {})
   */
  it('keeps service and character edits while clean Discord fields initialize (Discord audit D-020)', async () => {
    // ROOT CAUSE:
    //
    // The old service/character booleans were special cases rather than one form lifecycle.
    // Migrating the missing domains must retain those two existing dirty guarantees.
    const statuses = [
      dashboardStatus(),
      dashboardStatus(dashboardConfig({ adminRoleIdsText: 'external-admin', deepSeekModel: 'external-model' })),
    ]
    await executeGeneratedDashboard(async (path) => {
      if (path === '/api/memory')
        return jsonResponse({ config: { memoryEnabled: false }, memories: [] })
      if (path === '/api/status')
        return jsonResponse(statuses.shift())
      throw new Error(`Unexpected Dashboard request: ${path}`)
    })

    editText('deepSeekModel', 'local-model')
    editText('characterName', 'Local AIRI')
    await vi.advanceTimersByTimeAsync(3000)
    await settleDashboardTasks()

    expect(dashboardElement<HTMLInputElement>('deepSeekModel').value).toBe('local-model')
    expect(dashboardElement<HTMLInputElement>('characterName').value).toBe('Local AIRI')
    expect(dashboardElement<HTMLTextAreaElement>('adminRoleIdsText').value).toBe('external-admin')
  })
})
