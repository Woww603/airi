/** Fixed readiness failure categories safe to show in the local wrapper. */
export type DashboardReadinessErrorCode
  = | 'DASHBOARD_NOT_READY'
    | 'DASHBOARD_PROCESS_EXITED'
    | 'DASHBOARD_REQUEST_FAILED'
    | 'DASHBOARD_REQUEST_TIMEOUT'
    | 'DASHBOARD_URL_INVALID'
    | 'DASHBOARD_WAIT_TIMEOUT'

/** A readiness failure whose message never includes response bodies or capabilities. */
export class DashboardReadinessError extends Error {
  /** Stable failure category for diagnostics and tests. */
  code: DashboardReadinessErrorCode
}

/** Options for one readiness HTTP request. */
export interface DashboardReadinessProbeOptions {
  /** Maximum wait for the HTTP response in milliseconds. @default 1000 */
  requestTimeoutMs?: number
}

/** Options for the wrapper's bounded readiness lifecycle. */
export interface DashboardReadinessWaitOptions extends DashboardReadinessProbeOptions {
  /** Maximum number of health requests. @default 40 */
  attempts?: number
  /** Delay between failed health requests in milliseconds. @default 500 */
  delayMs?: number
  /** Reports whether the exact Dashboard child owned by the wrapper is still running. */
  isServiceRunning?: () => boolean
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
export function resolveDashboardRootUrl(baseUrl: string): string

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
export function probeDashboardReadiness(baseUrl: string, options?: DashboardReadinessProbeOptions): Promise<void>

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
export function waitForDashboardReadiness(baseUrl: string, options?: DashboardReadinessWaitOptions): Promise<void>
