import type { MetadataEventSource } from '@proj-airi/server-shared/types'

/** Module identity bound to a websocket credential during authentication. */
export interface AuthenticatedModuleBinding {
  /** Registry name reserved for this connection. */
  name: string
  /** Optional registry index reserved for this connection. */
  index?: number
  /** Immutable event source owned by this connection. */
  identity: MetadataEventSource
}

/** Event and configuration authority granted to one module credential. */
export interface ModuleCredentialCapabilities {
  /** Event types this credential may emit. `*` grants every event type. */
  emit?: readonly string[]
  /** Granted event types that generic paired peers must never emit. */
  exclusiveEmit?: readonly string[]
  /** Module names this credential may configure. `*` grants every module name. */
  configure?: readonly string[]
}

/** Server-side credential for one exact module principal. */
export interface ModuleCredential {
  /** Session credential delivered only to the intended module. */
  token: string
  /** Exact module name, index, and identity bound by this credential. */
  module: AuthenticatedModuleBinding
  /** Least-privilege grants applied after authentication. */
  capabilities: ModuleCredentialCapabilities
}

export interface Peer {
  /**
   * Unique random [uuid v4](https://developer.mozilla.org/en-US/docs/Glossary/UUID) identifier for the peer.
   */
  get id(): string
  send: (data: unknown, options?: {
    compress?: boolean
  }) => number | void | undefined
  close?: (code?: number, reason?: string) => void
  /**
   * WebSocket lifecycle state (mirrors WebSocket.readyState)
   */
  readyState?: number
  request?: {
    url?: string
    headers?: Headers
  }
  remoteAddress?: string
}

export interface NamedPeer {
  name: string
  index?: number
  peer: Peer
}

export enum WebSocketReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

export interface AuthenticatedPeer extends NamedPeer {
  authenticated: boolean
  /** Exact module principal fixed during authentication. */
  boundModule?: AuthenticatedModuleBinding
  /** Whether this peer used the generic pairing token or a module credential. */
  credentialKind?: 'pairing' | 'module'
  /** Least-privilege grants copied from the authenticated module credential. */
  capabilities?: ModuleCredentialCapabilities
  identity?: MetadataEventSource
  lastHeartbeatAt?: number
  healthy?: boolean
  missedHeartbeats?: number
}
