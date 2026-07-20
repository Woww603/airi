const http = require('node:http')

const readinessErrorMessages = {
  DASHBOARD_NOT_READY: 'Dashboard is not ready.',
  DASHBOARD_PROCESS_EXITED: 'Dashboard process exited before readiness.',
  DASHBOARD_REQUEST_FAILED: 'Dashboard readiness request failed.',
  DASHBOARD_REQUEST_TIMEOUT: 'Dashboard readiness request timed out.',
  DASHBOARD_URL_INVALID: 'Dashboard readiness URL is invalid.',
  DASHBOARD_WAIT_TIMEOUT: 'Dashboard did not become ready.',
}

class DashboardReadinessError extends Error {
  constructor(code) {
    super(readinessErrorMessages[code])
    this.code = code
    this.name = 'DashboardReadinessError'
  }
}

function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback
}

/**
 * Normalizes a standalone Dashboard URL to its canonical origin root.
 *
 * Before:
 * - `http://127.0.0.1:6122`
 *
 * After:
 * - `http://127.0.0.1:6122/`
 *
 * Use when:
 * - The wrapper must validate its configured local Dashboard before transport.
 * - BrowserWindow must load only the root page that bootstraps the capability.
 *
 * Expects:
 * - An HTTP loopback URL with no userinfo, query, fragment, or non-root path.
 *
 * Returns:
 * - The canonical origin root with a trailing slash.
 */
function resolveDashboardRootUrl(baseUrl) {
  let dashboardUrl
  try {
    dashboardUrl = new URL(baseUrl)
  }
  catch {
    throw new DashboardReadinessError('DASHBOARD_URL_INVALID')
  }

  const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])
  if (
    dashboardUrl.protocol !== 'http:'
    || !loopbackHosts.has(dashboardUrl.hostname)
    || dashboardUrl.username
    || dashboardUrl.password
    || dashboardUrl.pathname !== '/'
    || dashboardUrl.search
    || dashboardUrl.hash
  ) {
    throw new DashboardReadinessError('DASHBOARD_URL_INVALID')
  }

  return `${dashboardUrl.origin}/`
}

/**
 * Probes the standalone Dashboard's public, state-free readiness endpoint.
 *
 * Use when:
 * - A local wrapper must distinguish a listening Dashboard from another service.
 * - The wrapper must not acquire or transport the per-run Dashboard capability.
 *
 * Expects:
 * - A loopback HTTP Dashboard base URL.
 * - Only a 2xx `/healthz` response represents readiness.
 *
 * Returns:
 * - A promise that resolves without exposing response content.
 */
function probeDashboardReadiness(baseUrl, options = {}) {
  let dashboardRootUrl
  try {
    dashboardRootUrl = resolveDashboardRootUrl(baseUrl)
  }
  catch (error) {
    return Promise.reject(error)
  }

  const readinessUrl = new URL('/healthz', dashboardRootUrl)

  const requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 1_000, 30_000)
  return new Promise((resolve, reject) => {
    const request = http.get(readinessUrl, (response) => {
      response.resume()
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        resolve()
        return
      }

      reject(new DashboardReadinessError('DASHBOARD_NOT_READY'))
    })
    request.on('error', (error) => {
      if (error instanceof DashboardReadinessError) {
        reject(error)
        return
      }

      reject(new DashboardReadinessError('DASHBOARD_REQUEST_FAILED'))
    })
    request.setTimeout(requestTimeoutMs, () => {
      request.destroy(new DashboardReadinessError('DASHBOARD_REQUEST_TIMEOUT'))
    })
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Waits for Dashboard readiness with a bounded retry lifecycle.
 *
 * Use when:
 * - The wrapper has started the standalone process and must wait before loading it.
 * - A child-process exit must terminate readiness waiting immediately.
 *
 * Expects:
 * - `isServiceRunning`, when supplied, describes the exact child owned by the wrapper.
 * - Retry and request timeout values are positive bounded integers.
 *
 * Returns:
 * - A promise that resolves on a 2xx health response or rejects with a fixed category.
 */
async function waitForDashboardReadiness(baseUrl, options = {}) {
  const attempts = boundedInteger(options.attempts, 40, 100)
  const delayMs = boundedInteger(options.delayMs, 500, 10_000)
  const isServiceRunning = options.isServiceRunning

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isServiceRunning && !isServiceRunning())
      throw new DashboardReadinessError('DASHBOARD_PROCESS_EXITED')

    try {
      await probeDashboardReadiness(baseUrl, { requestTimeoutMs: options.requestTimeoutMs })
      return
    }
    catch (error) {
      if (error instanceof DashboardReadinessError && error.code === 'DASHBOARD_URL_INVALID')
        throw error
    }

    if (isServiceRunning && !isServiceRunning())
      throw new DashboardReadinessError('DASHBOARD_PROCESS_EXITED')

    if (attempt + 1 < attempts)
      await delay(delayMs)
  }

  throw new DashboardReadinessError('DASHBOARD_WAIT_TIMEOUT')
}

module.exports = {
  DashboardReadinessError,
  probeDashboardReadiness,
  resolveDashboardRootUrl,
  waitForDashboardReadiness,
}
