/// <reference lib="dom" />
// @vitest-environment jsdom

import type { StandaloneVoiceDiagnosticsSnapshot } from './voiceDiagnostics'

import { Script } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderAiriSettingsDashboardHtml } from './dashboard-ui'
import { StandaloneVoiceDiagnostics } from './voiceDiagnostics'

function dashboardElement(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element)
    throw new Error(`Missing generated dashboard element: ${id}`)
  return element
}

function dashboardStatus(voiceDiagnostics: StandaloneVoiceDiagnosticsSnapshot) {
  return {
    config: {},
    state: {
      acceptedMessages: 0,
      botStatus: 'ready',
      events: [],
      failedReplies: 0,
      rejectedMessages: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      successfulReplies: 0,
      voiceDiagnostics,
    },
  }
}

async function settleDashboardTasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1)
    await Promise.resolve()
}

/** Executes the generated Dashboard browser entrypoint with one public status snapshot. */
async function renderDashboardSnapshot(snapshot: StandaloneVoiceDiagnosticsSnapshot): Promise<void> {
  const html = renderAiriSettingsDashboardHtml('synthetic-script-nonce')
  const inlineScript = html.match(/<script nonce="synthetic-script-nonce">([\s\S]*?)<\/script>/)?.[1]
  if (!inlineScript)
    throw new Error('Generated dashboard did not contain its executable script.')

  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
    const path = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname
        : new URL(input.url).pathname
    if (path === '/api/status')
      return Promise.resolve(new Response(JSON.stringify(dashboardStatus(snapshot)), { headers: { 'Content-Type': 'application/json' } }))
    if (path === '/api/memory')
      return Promise.resolve(new Response(JSON.stringify({ config: { memoryEnabled: false }, memories: [] }), { headers: { 'Content-Type': 'application/json' } }))
    throw new Error(`Unexpected Dashboard request: ${path}`)
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
  // The production Dashboard boundary is an inline script returned by the
  // HTML renderer. jsdom shares lexical scope across document.write scripts,
  // so an IIFE preserves one browser-entrypoint execution per test.
  // Source/context: services/discord-bot/src/standalone/dashboard-ui.ts.
  // Removal condition: delete this wrapper when the Dashboard becomes an
  // importable browser entrypoint.
  new Script(`(() => {${inlineScript}\n})()`).runInThisContext()
  await settleDashboardTasks()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.documentElement.innerHTML = ''
})

/**
 * @example
 * describe('standalone dashboard memory scope safety', () => {})
 */
describe('standalone dashboard memory scope safety', () => {
  /**
   * @example
   * it('requires an explicit scope and confirms scopes shared beyond one session', () => {})
   */
  it('requires an explicit scope and confirms scopes shared beyond one session', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html).toContain('<option value="" selected disabled>请选择范围</option>')
    expect(html).toContain('wideMemoryScopeLabels')
    expect(html).not.toContain('scope: String(form.get(\'scope\') || \'global\')')
  })
})

/** @example describe('standalone capability diagnostic dashboard', () => {}) */
describe('standalone capability diagnostic dashboard', () => {
  /** @example it('renders only fixed diagnostic controls and status labels', () => {}) */
  it('renders only fixed diagnostic controls and status labels', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html).toContain('id="startCapabilityDiagnosticsButton"')
    expect(html).toContain('id="cancelCapabilityDiagnosticsButton"')
    expect(html).toContain('id="confirmTextReplyButton"')
    expect(html).toContain('id="confirmVoiceConsentButton"')
    expect(html).toContain('id="confirmVoiceHeardButton"')
    expect(html).toContain('\'/api/diagnostics/start\'')
    expect(html).toContain('\'/api/diagnostics/confirm\'')
    expect(html).toContain('\'/api/diagnostics/cancel\'')
    expect(html).toContain('capabilityStatusLabels')
    expect(html).not.toContain('Discord session token')
  })
})

/**
 * @example
 * describe('standalone dashboard speech settings', () => {})
 */
describe('standalone dashboard speech settings', () => {
  /** @example it('renders local admission statuses through a fixed safe label map', () => {}) */
  it('renders local admission statuses through a fixed safe label map', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html.includes('voiceDiagnosticLocalAdmissionStatuses')).toBe(true)
    expect(html.includes('voiceDiagnosticLabel(voiceDiagnosticLocalAdmissionStatuses, turn.localAdmissionStatus)')).toBe(true)
    expect(html.includes('\'Local admission \' + String(turn.localAdmissionStatus)')).toBe(false)
  })

  /** @example it('renders the fixed capacity failure without conflating local admission and provider input', () => {}) */
  it('renders the fixed capacity failure without conflating local admission and provider input', async () => {
    // ROOT CAUSE:
    //
    // A locally admitted turn can fail before any provider append. Rendering
    // that as a generic provider error hides the ownership boundary from the
    // Dashboard and makes a failed cleanup look like a replacement.
    //
    // The generated browser entrypoint must consume a bounded typed snapshot,
    // not merely retain labels in its HTML source.
    const diagnostics = new StandaloneVoiceDiagnostics()
    diagnostics.record({ mode: 'qwen-realtime', runtimeSequence: 65, sessionSequence: 65, stage: 'session-started' })
    diagnostics.record({ runtimeSequence: 65, sessionSequence: 65, stage: 'local-input-admitted', turnSequence: 65 })
    diagnostics.record({ failureCategory: 'provider-input-capacity', runtimeSequence: 65, sessionSequence: 65, stage: 'failure', turnSequence: 65 })
    diagnostics.record({ cleanupReason: 'failed', runtimeSequence: 65, sessionSequence: 65, stage: 'session-cleaned' })
    const snapshot = diagnostics.getSnapshot()

    expect(snapshot.completed).toHaveLength(1)
    expect(snapshot.completed[0]?.completionReason).toBe('failed')
    expect(snapshot.completed[0]?.failureCategories).toEqual(['provider-input-capacity'])
    expect(snapshot.completed[0]?.turns[0]).toMatchObject({
      failureCategory: 'provider-input-capacity',
      inputAppends: 0,
      localAdmissionStatus: 'admitted',
      turnSequence: 65,
    })

    await renderDashboardSnapshot(snapshot)

    expect(dashboardElement('voiceDiagnosticsSessionState').textContent).toBe('Session #65 / qwen-realtime / failed / no-input / failed')
    expect(dashboardElement('voiceDiagnosticsSessionDetail').textContent).toContain('provider-input-capacity')
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('Provider 输入 0 / 0 B')
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('Local admission admitted')
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).toContain('失败 provider-input-capacity')
    expect(dashboardElement('voiceDiagnosticsTurnDetail').textContent).not.toContain('失败 provider-error')
  })

  /**
   * @example
   * it('emits executable dashboard JavaScript', () => {})
   */
  it('emits executable dashboard JavaScript', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')
    const inlineScript = html.match(/<script nonce="test-script-nonce">([\s\S]*?)<\/script>/)?.[1]

    expect(inlineScript).toBeDefined()

    // ROOT CAUSE:
    //
    // A regex literal inside the HTML template lost its escaping when rendered,
    // producing `.replace(//+$/, '')` and preventing every dashboard listener
    // from registering. Parsing the emitted script catches the actual boundary.
    expect(() => new Script(inlineScript)).not.toThrow()
  })

  /**
   * @example
   * it('matches AIRI provider navigation for chat, speech, and transcription', () => {})
   */
  it('matches AIRI provider navigation for chat, voice call, speech, and transcription', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html).toContain('role="tablist"')
    expect(html).toContain('data-service-tab="chat"')
    expect(html).toContain('data-service-tab="voice-call"')
    expect(html).toContain('data-service-tab="speech"')
    expect(html).toContain('data-service-tab="transcription"')
    expect(html).toContain('data-service-panel="chat"')
    expect(html).toContain('data-service-panel="voice-call"')
    expect(html).toContain('data-service-panel="speech"')
    expect(html).toContain('data-service-panel="transcription"')
    expect(html).toContain('data-provider-preset="classic-voice-call"')
    expect(html).toContain('data-provider-preset="qwen-realtime-voice-call"')
    expect(html).toContain('data-provider-preset="openai-stt"')
    expect(html).toContain('data-provider-preset="openai-compatible-stt"')
    expect(html).toContain('data-provider-preset="openai-tts"')
    expect(html).toContain('data-provider-preset="openai-compatible-tts"')
  })

  /**
   * @example
   * it('renders STT and TTS provider fields without embedding secret values', () => {})
   */
  it('renders STT and TTS provider fields without embedding secret values', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html).toContain('id="sttApiKey"')
    expect(html).toContain('id="sttApiBaseUrl"')
    expect(html).toContain('id="sttModel"')
    expect(html).toContain('id="ttsApiKey"')
    expect(html).toContain('id="ttsApiBaseUrl"')
    expect(html).toContain('id="ttsModel"')
    expect(html).toContain('id="ttsVoice"')
    expect(html).not.toContain('stt-key')
    expect(html).not.toContain('tts-key')
  })

  /**
   * @example
   * it('renders Qwen Realtime fields without embedding the API key', () => {})
   */
  it('renders Qwen Realtime fields without embedding the API key', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    expect(html).toContain('id="voiceCallMode"')
    expect(html).toContain('id="qwenRealtimeApiKey"')
    expect(html).toContain('id="qwenRealtimeRegion"')
    expect(html).toContain('id="qwenRealtimeWorkspaceId"')
    expect(html).toContain('id="qwenRealtimeWorkspaceIdClear"')
    expect(html).toContain('id="qwenRealtimeWorkspaceId" name="qwenRealtimeWorkspaceId" placeholder="未配置" type="password"')
    expect(html).toContain('id="qwenRealtimeModel"')
    expect(html).toContain('id="qwenRealtimeVoice"')
    expect(html).toContain('id="qwenRealtimeInterruptionSensitivity"')
    expect(html).toContain('id="qwenRealtimeInterruptionSensitivityLabel"')
    expect(html).toContain('data-qwen-interruption-sensitivity="25"')
    expect(html).toContain('data-qwen-interruption-sensitivity="40"')
    expect(html).toContain('data-qwen-interruption-sensitivity="70"')
    expect(html).toContain('打断灵敏度')
    expect(html).toContain('Qwen 语义 VAD')
    expect(html).toContain('id="qwenRealtimeSilenceDurationMs"')
    expect(html).toContain('回合结束防抖（毫秒）')
    expect(html).not.toContain('id="qwenRealtimeVadType"')
    expect(html).not.toContain('id="qwenRealtimeVadThreshold"')
    expect(html).not.toContain('id="qwenRealtimeVadPrefixPaddingMs"')
    expect(html).not.toContain('dashscope-secret')
    expect(html).toContain('qwenRealtimeWorkspaceId: secretPatch(\'qwenRealtimeWorkspaceId\', \'qwenRealtimeWorkspaceIdClear\')')
  })

  /**
   * @example
   * Every dashboard password field exposes an explicit clear control and emits a tri-state patch.
   */
  it('renders explicit unchanged, set, and clear secret controls (Discord audit D-006)', () => {
    // ROOT CAUSE:
    //
    // Password inputs currently submit raw strings. Blank therefore has to serve as
    // both "leave unchanged" and "clear", which cannot represent user intent safely.
    //
    // The rendered UI must make clearing explicit and map all five local secrets to
    // the discriminated unchanged/set/clear HTTP contract without rendering values.
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')

    // @example
    expect(html).toContain('id="discordTokenClear"')
    // @example
    expect(html).toContain('id="deepSeekApiKeyClear"')
    // @example
    expect(html).toContain('id="sttApiKeyClear"')
    // @example
    expect(html).toContain('id="ttsApiKeyClear"')
    // @example
    expect(html).toContain('id="qwenRealtimeApiKeyClear"')
    // @example
    expect(html).toContain('function secretPatch(fieldId, clearFieldId)')
    // @example
    expect(html).toContain('action: \'unchanged\'')
    // @example
    expect(html).toContain('action: \'set\'')
    // @example
    expect(html).toContain('action: \'clear\'')
    // @example
    expect(html).not.toContain('dashboard-secret-synthetic-sentinel')
  })

  /**
   * @example
   * it('offers every documented Qwen3.5 Omni Realtime voice', () => {})
   */
  it('offers every documented Qwen3.5 Omni Realtime voice', () => {
    const html = renderAiriSettingsDashboardHtml('test-script-nonce')
    const selector = html.match(/<select id="qwenRealtimeVoice"[^>]*>([\s\S]*?)<\/select>/)?.[1]
    const voices = Array.from(selector?.matchAll(/<option value="([^"]+)"[^>]*>/g) ?? [], match => match[1])

    expect(html).toContain('id="qwenRealtimeCustomVoice"')
    expect(html).not.toContain('qwenRealtimeVoiceSuggestions')
    expect(voices).toEqual([
      'Tina',
      'Cindy',
      'Liora Mira',
      'Sunnybobi',
      'Raymond',
      'Ethan',
      'Theo Calm',
      'Serena',
      'Harvey',
      'Maia',
      'Evan',
      'Qiao',
      'Momo',
      'Wil',
      'Angel',
      'Li Cassian',
      'Mia',
      'Joyner',
      'Gold',
      'Katerina',
      'Ryan',
      'Jennifer',
      'Aiden',
      'Mione',
      'Sunny',
      'Dylan',
      'Eric',
      'Peter',
      'Joseph Chen',
      'Marcus',
      'Li',
      'Kiki',
      'Rocky',
      'Sohee',
      'Lenn',
      'Ono Anna',
      'Sonrisa',
      'Bodega',
      'Emilien',
      'Andre',
      'Radio Gol',
      'Alek',
      'Rizky',
      'Roya',
      'Arda',
      'Hana',
      'Dolce',
      'Jakub',
      'Griet',
      'Eliška',
      'Marina',
      'Siiri',
      'Ingrid',
      'Sigga',
      'Bea',
      'Chloe',
    ])
  })
})
