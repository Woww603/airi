import type { StaticAssetResolveResult, StaticAssetSession, StaticAssetSessionValidationResult } from './types'

import { readFile } from 'node:fs/promises'

import { eventHandler, getCookie, getRequestURL, serveStatic } from 'h3'

import { HttpError, toH3HttpError } from '../errors'
import { normalizeStaticAssetPath, parseStaticAssetRequestPath } from './paths'
import { createStaticAssetSessionCookieName } from './session-store'

const staticAssetSecurityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

export interface StaticAssetRouteOptions {
  authorize: (params: {
    extensionId: string
    assetSessionId: string
    assetPath: string
    cookieValue: string | undefined
  }) => Promise<StaticAssetSessionValidationResult>
  refreshSession: (assetSessionId: string) => StaticAssetSession | undefined
  resolveAsset: (params: { extensionId: string, assetPath: string }) => Promise<StaticAssetResolveResult>
  getType?: (ext: string) => string | undefined
  /** Maximum file size served for one plugin asset. @default 67108864 */
  maxAssetBytes?: number
}

/**
 * Creates the secured extension static asset route handler.
 *
 * Use when:
 * - Serving plugin iframe assets under `/_airi/extensions/:extensionId/sessions/:assetSessionId/ui/**assetPath`
 *
 * Expects:
 * - Cookie-backed asset session data to be present and valid
 * - `resolveAsset` to map request params into a validated local file
 *
 * Returns:
 * - H3 event handler that enforces cookie auth before static file response
 */
export function createStaticAssetRoute(options: StaticAssetRouteOptions) {
  const maxAssetBytes = Number.isFinite(options.maxAssetBytes)
    ? Math.min(Math.max(Math.trunc(options.maxAssetBytes!), 1), 64 * 1024 * 1024)
    : 64 * 1024 * 1024

  return eventHandler(async (event) => {
    try {
      Object.entries(staticAssetSecurityHeaders).forEach(([key, value]) => {
        event.res.headers.set(key, value)
      })

      if (event.req.method !== 'GET' && event.req.method !== 'HEAD') {
        throw new HttpError({
          status: 405,
          code: 'EXTENSION_ASSET_METHOD_NOT_ALLOWED',
          message: 'Method Not Allowed',
        })
      }

      const requestPath = parseStaticAssetRequestPath(getRequestURL(event).pathname)
      const extensionId = requestPath?.extensionId ?? ''
      const assetSessionId = requestPath?.assetSessionId ?? ''
      const assetPath = normalizeStaticAssetPath(requestPath?.assetPath ?? '')

      if (!extensionId || !assetSessionId || !assetPath) {
        throw new HttpError({
          status: 401,
          code: 'EXTENSION_ASSET_REQUEST_INVALID',
          message: 'Unauthorized',
          reason: 'required extensionId, assetSessionId, or assetPath is missing',
        })
      }

      const cookieValue = getCookie(event, createStaticAssetSessionCookieName(assetSessionId))
      const auth = await options.authorize({
        extensionId,
        assetSessionId,
        assetPath,
        cookieValue,
      })
      if (!auth.ok) {
        throw auth.error
      }

      options.refreshSession(assetSessionId)

      let resolved: Awaited<ReturnType<StaticAssetRouteOptions['resolveAsset']>> | undefined
      const resolveOnce = async () => {
        if (!resolved) {
          resolved = await options.resolveAsset({ extensionId, assetPath })
        }

        if (resolved.ok && resolved.size > maxAssetBytes) {
          throw new HttpError({
            status: 413,
            code: 'EXTENSION_ASSET_TOO_LARGE',
            message: 'Payload Too Large',
            reason: 'plugin asset exceeds configured byte limit',
          })
        }

        return resolved
      }

      return await serveStatic(event, {
        getType: options.getType,
        getContents: async () => {
          const item = await resolveOnce()
          if (!item.ok) {
            throw item.error
          }
          return await readFile(item.filePath)
        },
        getMeta: async () => {
          const item = await resolveOnce()
          if (!item.ok) {
            throw item.error
          }

          return {
            size: item.size,
            mtime: item.mtime,
          }
        },
      })
    }
    catch (error) {
      if (error instanceof HttpError) {
        throw toH3HttpError(error, {
          headers: staticAssetSecurityHeaders,
        })
      }

      throw error
    }
  })
}
