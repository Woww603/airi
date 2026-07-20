import { mkdtemp, rm } from 'node:fs/promises'
import { request as sendHttpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { StandaloneDiscordAppController } from './app-controller'
import { StandaloneDashboardServer } from './dashboard'
import { StandaloneDashboardState } from './dashboard-state'

const servers: StandaloneDashboardServer[] = []
const tempDirectories: string[] = []

async function requestWithHost(url: string, host: string): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const request = sendHttpRequest(url, {
      headers: { Host: host },
      method: 'GET',
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.once('error', reject)
    request.end()
  })
}

async function createTestDashboard(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'airi-dashboard-server-'))
  tempDirectories.push(directory)
  const state = new StandaloneDashboardState()
  const controller = new StandaloneDiscordAppController({
    env,
    envFilePath: join(directory, '.env.local'),
    state,
  })
  const server = new StandaloneDashboardServer({
    apiToken: 'test-dashboard-token',
    controller,
    settings: { enabled: true, host: '127.0.0.1', port: 0 },
  })
  servers.push(server)
  const address = await server.start()
  return { address, controller, state }
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map(server => server.stop()))
  await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

/**
 * @example
 * describe('standalone dashboard HTTP authorization', () => {})
 */
describe('standalone dashboard HTTP authorization', () => {
  /**
   * @example
   * it('never serializes Discord identity or raw errors through status events', async () => {})
   */
  it('never serializes Discord identity or raw errors through status events', async () => {
    const sentinels = [
      'synthetic-http-guild-name-sentinel',
      '929292929292929292',
      'https://synthetic.invalid/private?credential=sentinel',
      'synthetic-http-error-message-sentinel',
    ]
    const { address, state } = await createTestDashboard()
    const acceptedObservation = {
      operationSequence: 1,
      scope: `${sentinels[0]} / ${sentinels[1]}`,
      surface: 'text-guild' as const,
    }
    const ingressObservation = {
      error: `${sentinels[3]} ${sentinels[2]}`,
      failureCategory: 'discord-ingress-failure' as const,
      operationSequence: 2,
      scope: sentinels[1],
      surface: 'text-guild' as const,
    }
    state.recordAcceptedMessage(acceptedObservation)
    state.recordIngressFailure(ingressObservation)

    // ROOT CAUSE:
    //
    // `/api/status` serialized the state object verbatim, so every arbitrary
    // event detail and last-error value became readable by Dashboard clients.
    const response = await fetch(`${address.url}/api/status`, {
      headers: { 'X-AIRI-Dashboard-Token': 'test-dashboard-token' },
    })
    const serialized = JSON.stringify(await response.json())

    /** @example expect(response.status).toBe(200) */
    expect(response.status).toBe(200)
    for (const sentinel of sentinels) {
      /** @example expect(serialized).not.toContain(sentinel) */
      expect(serialized).not.toContain(sentinel)
    }
  })

  /**
   * @example
   * it('never serializes a configured Qwen Workspace ID through public HTTP for R-003', async () => {})
   */
  it('never serializes a configured Qwen Workspace ID through public HTTP for R-003', async () => {
    const workspaceSentinel = 'synthetic-http-workspace-sensitive-sentinel'
    const { address } = await createTestDashboard({
      QWEN_REALTIME_WORKSPACE_ID: workspaceSentinel,
    })

    // ROOT CAUSE:
    //
    // Both /api/config and /api/status delegated to getPublicConfig(), whose
    // projection included the exact saved Workspace ID. The local capability
    // prevented cross-origin reads but did not protect the value from Dashboard
    // scripts, DOM automation, or future same-origin observers.
    const headers = { 'X-AIRI-Dashboard-Token': 'test-dashboard-token' }
    const configResponse = await fetch(`${address.url}/api/config`, { headers })
    const statusResponse = await fetch(`${address.url}/api/status`, { headers })
    const pageResponse = await fetch(address.url)
    const serializedPublicBoundary = JSON.stringify({
      config: await configResponse.json(),
      html: await pageResponse.text(),
      status: await statusResponse.json(),
    })

    /** @example expect(configResponse.status).toBe(200) */
    expect(configResponse.status).toBe(200)
    /** @example expect(statusResponse.status).toBe(200) */
    expect(statusResponse.status).toBe(200)
    /** @example expect(serializedPublicBoundary).not.toContain(workspaceSentinel) */
    expect(serializedPublicBoundary).not.toContain(workspaceSentinel)
    /** @example expect(serializedPublicBoundary).toContain('qwenRealtimeWorkspaceIdConfigured') */
    expect(serializedPublicBoundary).toContain('qwenRealtimeWorkspaceIdConfigured')
  })

  /**
   * @example
   * it('exposes only a fixed tokenless readiness response behind the exact Host boundary', async () => {})
   */
  it('exposes only a fixed tokenless readiness response behind the exact Host boundary (Discord audit D-032)', async () => {
    // ROOT CAUSE:
    //
    // The legacy Dashboard window probes the capability-protected `/api/status`
    // endpoint without a token, so a correctly secured standalone server always
    // reports 403 and the wrapper never observes readiness.
    //
    // A dedicated `/healthz` contract must remain inside the exact Host check,
    // expose no state or capability, and accept GET only. All `/api/*` routes
    // continue to require the per-run capability.
    const { address, controller } = await createTestDashboard()
    const getPublicConfig = vi.spyOn(controller, 'getPublicConfig')

    const health = await fetch(`${address.url}/healthz`)
    /** @example expect(health.status).toBe(204) */
    expect(health.status).toBe(204)
    /** @example expect(await health.text()).toBe('') */
    expect(await health.text()).toBe('')
    /** @example expect(getPublicConfig).not.toHaveBeenCalled() */
    expect(getPublicConfig).not.toHaveBeenCalled()

    const wrongHost = await requestWithHost(`${address.url}/healthz`, `attacker.invalid:${address.port}`)
    /** @example expect(wrongHost).toBe(403) */
    expect(wrongHost).toBe(403)

    const nonLoopbackHostAlias = await requestWithHost(`${address.url}/healthz`, `0.0.0.0:${address.port}`)
    /** @example expect(nonLoopbackHostAlias).toBe(403) */
    expect(nonLoopbackHostAlias).toBe(403)

    const wrongMethod = await fetch(`${address.url}/healthz`, { method: 'POST' })
    /** @example expect(wrongMethod.status).toBe(404) */
    expect(wrongMethod.status).toBe(404)
    /** @example expect((await fetch(`${address.url}/api/status`)).status).toBe(403) */
    expect((await fetch(`${address.url}/api/status`)).status).toBe(403)
  })

  /**
   * @example
   * it('keeps the browser capability out of HTML while authorizing same-origin API operations', async () => {})
   */
  it('keeps the browser capability out of HTML while authorizing same-origin API operations', async () => {
    // ROOT CAUSE:
    //
    // The page renderer serialized the bearer capability into inline JavaScript.
    // Any script, DOM inspector, page source capture, or HTML log could read it.
    //
    // Before: `const dashboardApiToken = "..."` appeared in every response.
    // After: the server sets an HttpOnly Strict loopback session cookie and the
    // browser sends no credential header from client JavaScript.
    const { address } = await createTestDashboard()

    const pageResponse = await fetch(address.url)
    /** @example expect(pageResponse.status).toBe(200) */
    expect(pageResponse.status).toBe(200)
    /** @example expect(pageResponse.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'') */
    expect(pageResponse.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'')
    /** @example expect(pageResponse.headers.get('content-security-policy')).not.toContain('script-src \'unsafe-inline\'') */
    expect(pageResponse.headers.get('content-security-policy')).not.toContain('script-src \'unsafe-inline\'')
    /** @example expect(pageResponse.headers.get('x-frame-options')).toBe('DENY') */
    expect(pageResponse.headers.get('x-frame-options')).toBe('DENY')
    const pageHtml = await pageResponse.text()
    const sessionCookie = pageResponse.headers.get('set-cookie')?.split(';', 1)[0]
    /** @example expect(sessionCookie).toBe('airi_dashboard_session=test-dashboard-token') */
    expect(sessionCookie).toBe('airi_dashboard_session=test-dashboard-token')
    /** @example expect(pageResponse.headers.get('set-cookie')).toContain('HttpOnly') */
    expect(pageResponse.headers.get('set-cookie')).toContain('HttpOnly')
    /** @example expect(pageResponse.headers.get('set-cookie')).toContain('SameSite=Strict') */
    expect(pageResponse.headers.get('set-cookie')).toContain('SameSite=Strict')
    /** @example expect(pageResponse.headers.get('set-cookie')).toContain('Path=/') */
    expect(pageResponse.headers.get('set-cookie')).toContain('Path=/')
    /** @example expect(pageHtml).not.toContain('test-dashboard-token') */
    expect(pageHtml).not.toContain('test-dashboard-token')
    /** @example expect(pageHtml).not.toContain('X-AIRI-Dashboard-Token') */
    expect(pageHtml).not.toContain('X-AIRI-Dashboard-Token')
    /** @example expect(pageHtml).not.toContain('localStorage') */
    expect(pageHtml).not.toContain('localStorage')
    /** @example expect(pageHtml).not.toContain('sessionStorage') */
    expect(pageHtml).not.toContain('sessionStorage')
    /** @example expect(pageHtml).not.toContain('document.cookie') */
    expect(pageHtml).not.toContain('document.cookie')
    /** @example expect(pageHtml).not.toContain('location.search') */
    expect(pageHtml).not.toContain('location.search')
    /** @example expect(pageHtml).not.toContain('location.hash') */
    expect(pageHtml).not.toContain('location.hash')
    /** @example expect(address.url).not.toContain('test-dashboard-token') */
    expect(address.url).not.toContain('test-dashboard-token')
    /** @example expect(pageHtml).toMatch(/<script nonce="[\w-]+">/) */
    expect(pageHtml).toMatch(/<script nonce="[\w-]+">/)

    /** @example expect((await fetch(`${address.url}/api/status`)).status).toBe(403) */
    expect((await fetch(`${address.url}/api/status`)).status).toBe(403)
    /** @example expect((await fetch(`${address.url}/api/status`, { headers: { Cookie: 'airi_dashboard_session=wrong-token' } })).status).toBe(403) */
    expect((await fetch(`${address.url}/api/status`, {
      headers: { Cookie: 'airi_dashboard_session=wrong-token' },
    })).status).toBe(403)
    /** @example expect((await fetch(`${address.url}/api/status`, { headers: { 'X-AIRI-Dashboard-Token': 'wrong-token' } })).status).toBe(403) */
    expect((await fetch(`${address.url}/api/status`, {
      headers: { 'X-AIRI-Dashboard-Token': 'wrong-token' },
    })).status).toBe(403)
    const browserStatusResponse = await fetch(`${address.url}/api/status`, {
      headers: { Cookie: sessionCookie ?? '' },
    })
    /** @example expect(browserStatusResponse.status).toBe(200) */
    expect(browserStatusResponse.status).toBe(200)
    /** @example expect(await browserStatusResponse.text()).not.toContain('test-dashboard-token') */
    expect(await browserStatusResponse.text()).not.toContain('test-dashboard-token')
    // The header remains a non-browser compatibility path, but is never emitted
    // by the dashboard client script.
    /** @example expect((await fetch(`${address.url}/api/status`, { headers: { 'X-AIRI-Dashboard-Token': 'test-dashboard-token' } })).status).toBe(200) */
    expect((await fetch(`${address.url}/api/status`, {
      headers: { 'X-AIRI-Dashboard-Token': 'test-dashboard-token' },
    })).status).toBe(200)

    /** @example expect((await fetch(`${address.url}/api/bot/stop`, { headers: { Cookie: sessionCookie ?? '', 'Content-Type': 'application/json', 'Origin': 'https://attacker.example' }, method: 'POST' })).status).toBe(403) */
    expect((await fetch(`${address.url}/api/bot/stop`, {
      headers: {
        'Cookie': sessionCookie ?? '',
        'Content-Type': 'application/json',
        'Origin': 'https://attacker.example',
      },
      method: 'POST',
    })).status).toBe(403)
    /** @example expect((await fetch(`${address.url}/api/bot/stop`, { headers: { Cookie: sessionCookie ?? '', 'Content-Type': 'application/json', 'Origin': address.url }, method: 'POST' })).status).toBe(200) */
    expect((await fetch(`${address.url}/api/bot/stop`, {
      headers: {
        'Cookie': sessionCookie ?? '',
        'Content-Type': 'application/json',
        'Origin': address.url,
      },
      method: 'POST',
    })).status).toBe(200)
  })

  /** @example it('protects capability diagnostic mutations with the same origin, token, and JSON boundary', async () => {}) */
  it('protects capability diagnostic mutations with the same origin, token, and JSON boundary', async () => {
    const { address } = await createTestDashboard()
    const headers = {
      'Content-Type': 'application/json',
      'Origin': address.url,
      'X-AIRI-Dashboard-Token': 'test-dashboard-token',
    }

    const missingCapability = await fetch(`${address.url}/api/diagnostics/start`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'Origin': address.url },
      method: 'POST',
    })
    /** @example expect(missingCapability.status).toBe(403) */
    expect(missingCapability.status).toBe(403)

    const invalidBody = await fetch(`${address.url}/api/diagnostics/start`, {
      body: '{}',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      method: 'POST',
    })
    /** @example expect(invalidBody.status).toBe(415) */
    expect(invalidBody.status).toBe(415)

    const [firstStart, concurrentStart] = await Promise.all([
      fetch(`${address.url}/api/diagnostics/start`, { body: '{}', headers, method: 'POST' }),
      fetch(`${address.url}/api/diagnostics/start`, { body: '{}', headers, method: 'POST' }),
    ])
    const startResponses = [firstStart, concurrentStart]
    /** @example expect(startResponses.map(response => response.status).sort()).toEqual([200, 409]) */
    expect(startResponses.map(response => response.status).sort()).toEqual([200, 409])
    const acceptedStart = startResponses.find(response => response.status === 200)
    if (!acceptedStart)
      throw new Error('Concurrent diagnostic start unexpectedly had no accepted request.')
    /** @example expect((await acceptedStart.json()).marker).toMatch(/^airi-diagnostic-/) */
    expect((await acceptedStart.json()).marker).toMatch(/^airi-diagnostic-/)

    // ROOT CAUSE:
    // The confirmation route returned success whenever the state machine accepted
    // a stale or failed confirmation. That made an unconsumed user action look
    // complete over HTTP. The route must preserve the state-machine result.
    const unconsumedConfirmation = await fetch(`${address.url}/api/diagnostics/confirm`, {
      body: JSON.stringify({ action: 'voice-consent-join' }),
      headers,
      method: 'POST',
    })
    /** @example expect(unconsumedConfirmation.status).toBe(409) */
    expect(unconsumedConfirmation.status).toBe(409)
    /** @example expect(await unconsumedConfirmation.json()).toEqual({ confirmed: false }) */
    expect(await unconsumedConfirmation.json()).toEqual({ confirmed: false })

    const invalidConfirmation = await fetch(`${address.url}/api/diagnostics/confirm`, {
      body: JSON.stringify({ action: 'anything-else' }),
      headers,
      method: 'POST',
    })
    /** @example expect(invalidConfirmation.status).toBe(400) */
    expect(invalidConfirmation.status).toBe(400)

    const cancelled = await fetch(`${address.url}/api/diagnostics/cancel`, { body: '{}', headers, method: 'POST' })
    /** @example expect(cancelled.status).toBe(200) */
    expect(cancelled.status).toBe(200)
  })

  /**
   * @example
   * it('enforces JSON media type and byte limits for dashboard writes', async () => {})
   */
  it('enforces JSON media type and byte limits for dashboard writes', async () => {
    const { address } = await createTestDashboard()
    const headers = {
      'Origin': address.url,
      'X-AIRI-Dashboard-Token': 'test-dashboard-token',
    }

    const wrongMediaType = await fetch(`${address.url}/api/config`, {
      body: '{}',
      headers,
      method: 'POST',
    })
    /** @example expect(wrongMediaType.status).toBe(415) */
    expect(wrongMediaType.status).toBe(415)

    const oversized = await fetch(`${address.url}/api/config`, {
      body: JSON.stringify({ systemPrompt: '😀'.repeat(20_000) }),
      headers: { ...headers, 'Content-Type': 'application/json' },
      method: 'POST',
    })
    /** @example expect(oversized.status).toBe(413) */
    expect(oversized.status).toBe(413)
    /** @example expect(await oversized.json()).toEqual({ error: 'Request body is too large.' }) */
    expect(await oversized.json()).toEqual({ error: 'Request body is too large.' })
  })

  /**
   * @example
   * it('returns bounded client errors without exposing internal exception details', async () => {})
   */
  it('returns bounded client errors without exposing internal exception details', async () => {
    const { address, controller } = await createTestDashboard()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sentinels = [
      'synthetic-dashboard-read-error https://synthetic.invalid/private?credential=read',
      'synthetic-dashboard-save-error https://synthetic.invalid/private?credential=save',
      'synthetic-dashboard-memory-error https://synthetic.invalid/private?credential=memory',
    ]
    const headers = {
      'Content-Type': 'application/json',
      'Origin': address.url,
      'X-AIRI-Dashboard-Token': 'test-dashboard-token',
    }

    const malformed = await fetch(`${address.url}/api/config`, {
      body: '{',
      headers,
      method: 'POST',
    })
    /** @example expect(malformed.status).toBe(400) */
    expect(malformed.status).toBe(400)
    /** @example expect(await malformed.json()).toEqual({ error: 'Request body must be valid JSON.' }) */
    expect(await malformed.json()).toEqual({ error: 'Request body must be valid JSON.' })

    vi.spyOn(controller, 'getPublicConfig').mockRejectedValueOnce(new Error(sentinels[0]))
    const internalFailure = await fetch(`${address.url}/api/config`, {
      headers: { 'X-AIRI-Dashboard-Token': 'test-dashboard-token' },
    })
    /** @example expect(internalFailure.status).toBe(500) */
    expect(internalFailure.status).toBe(500)
    /** @example expect(await internalFailure.json()).toEqual({ error: 'Dashboard request failed.' }) */
    expect(await internalFailure.json()).toEqual({ error: 'Dashboard request failed.' })

    vi.spyOn(controller, 'saveConfig').mockRejectedValueOnce(new Error(sentinels[1]))
    const saveFailure = await fetch(`${address.url}/api/config`, {
      body: '{}',
      headers,
      method: 'POST',
    })
    /** @example expect(saveFailure.status).toBe(500) */
    expect(saveFailure.status).toBe(500)
    /** @example expect(await saveFailure.json()).toEqual({ error: 'Dashboard request failed.' }) */
    expect(await saveFailure.json()).toEqual({ error: 'Dashboard request failed.' })

    vi.spyOn(controller, 'addMemory').mockRejectedValueOnce(new Error(sentinels[2]))
    const memoryFailure = await fetch(`${address.url}/api/memory`, {
      body: '{}',
      headers,
      method: 'POST',
    })
    /** @example expect(memoryFailure.status).toBe(500) */
    expect(memoryFailure.status).toBe(500)
    /** @example expect(await memoryFailure.json()).toEqual({ error: 'Dashboard request failed.' }) */
    expect(await memoryFailure.json()).toEqual({ error: 'Dashboard request failed.' })

    const serialized = JSON.stringify(consoleError.mock.calls)
    for (const sentinel of sentinels) {
      /** @example expect(serialized).not.toContain(sentinel) */
      expect(serialized).not.toContain(sentinel)
    }
    /** @example expect(serialized).toContain('dashboard-request-failure') */
    expect(serialized).toContain('dashboard-request-failure')
    consoleError.mockRestore()
  })

  /**
   * @example
   * Secret updates cross the HTTP boundary only as explicit unchanged, set, or clear actions.
   */
  it('validates secret patch actions at the dashboard HTTP boundary (Discord audit D-006)', async () => {
    const { address, controller } = await createTestDashboard()
    const saveConfig = vi.spyOn(controller, 'saveConfig').mockResolvedValue({
      message: 'Synthetic config accepted.',
      ok: true,
    })
    const headers = {
      'Content-Type': 'application/json',
      'Origin': address.url,
      'X-AIRI-Dashboard-Token': 'test-dashboard-token',
    }

    // ROOT CAUSE:
    //
    // The dashboard currently parses secret fields as optional strings. A blank
    // field and an omitted field are indistinguishable, while object actions are
    // silently discarded instead of being validated at the HTTP boundary.
    //
    // The fixed boundary carries an explicit discriminated action and rejects
    // malformed or ambiguous secret updates before the controller is invoked.
    const valid = await fetch(`${address.url}/api/config`, {
      body: JSON.stringify({
        deepSeekApiKey: {
          action: 'set',
          value: 'deepseek-synthetic-replacement',
        },
        discordToken: {
          action: 'unchanged',
        },
        sttApiKey: {
          action: 'clear',
        },
      }),
      headers,
      method: 'POST',
    })

    /** @example expect(valid.status).toBe(200) */
    expect(valid.status).toBe(200)
    /** @example expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ deepSeekApiKey: { action: 'set', value: 'deepseek-synthetic-replacement', }, discordToken: { action: 'unchanged', }, sttApiKey: { action: 'clear', }, })) */
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      deepSeekApiKey: {
        action: 'set',
        value: 'deepseek-synthetic-replacement',
      },
      discordToken: {
        action: 'unchanged',
      },
      sttApiKey: {
        action: 'clear',
      },
    }))

    saveConfig.mockClear()
    const invalid = await fetch(`${address.url}/api/config`, {
      body: JSON.stringify({
        discordToken: {
          action: 'set',
          value: '   ',
        },
      }),
      headers,
      method: 'POST',
    })

    /** @example expect(invalid.status).toBe(400) */
    expect(invalid.status).toBe(400)
    /** @example expect(saveConfig).not.toHaveBeenCalled() */
    expect(saveConfig).not.toHaveBeenCalled()
  })
})
