import type { Server, ServerOptions } from './server'

import { Buffer } from 'node:buffer'

import WebSocket from 'crossws/websocket'

import { parse, stringify } from 'superjson'
import { afterEach, describe, expect, it } from 'vitest'

import { createServer } from './server'

interface GatewayEvent {
  type: string
  data: Record<string, unknown>
  metadata?: {
    source?: {
      id?: string
      kind?: string
      plugin?: {
        id?: string
      }
    }
  }
}

interface ModuleIdentity {
  id: string
  kind: 'plugin'
  plugin: {
    id: string
  }
}

interface EventWaiter {
  predicate: (event: GatewayEvent) => boolean
  reject: (error: Error) => void
  resolve: (event: GatewayEvent) => void
}

const PAIRING_TOKEN = 'synthetic-pairing-token'
const DISCORD_MODULE_TOKEN = 'synthetic-discord-module-token'
const DISCORD_BOT_TOKEN = 'synthetic-discord-bot-token'
const DISCORD_IDENTITY: ModuleIdentity = {
  id: 'discord-utility-process',
  kind: 'plugin',
  plugin: {
    id: 'discord',
  },
}

let nextPort = 47_210
const activeClients: GatewayClient[] = []
const activeServers: Server[] = []

class GatewayClient {
  readonly #events: GatewayEvent[] = []
  readonly #frames: string[] = []
  readonly #waiters: EventWaiter[] = []
  readonly #socket: WebSocket

  constructor(url: string) {
    this.#socket = new WebSocket(url)
    this.#socket.onmessage = (message) => {
      const raw = typeof message.data === 'string'
        ? message.data
        : Buffer.from(message.data as ArrayBuffer).toString('utf8')
      this.#frames.push(raw)
      const event = parse<GatewayEvent>(raw)
      const waiterIndex = this.#waiters.findIndex(waiter => waiter.predicate(event))
      if (waiterIndex === -1) {
        this.#events.push(event)
        return
      }

      const [waiter] = this.#waiters.splice(waiterIndex, 1)
      waiter?.resolve(event)
    }
    this.#socket.onclose = () => {
      const error = new Error('Gateway websocket closed before the expected event arrived')
      for (const waiter of this.#waiters.splice(0))
        waiter.reject(error)
    }
    activeClients.push(this)
  }

  open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN)
      return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      this.#socket.onopen = () => resolve()
      this.#socket.onerror = () => reject(new Error('Gateway websocket failed to open'))
    })
  }

  send(event: GatewayEvent): void {
    const frame = stringify(event)
    this.#frames.push(frame)
    this.#socket.send(frame)
  }

  frames(): readonly string[] {
    return this.#frames
  }

  next(predicate: (event: GatewayEvent) => boolean): Promise<GatewayEvent> {
    const eventIndex = this.#events.findIndex(predicate)
    if (eventIndex !== -1) {
      const [event] = this.#events.splice(eventIndex, 1)
      if (event)
        return Promise.resolve(event)
    }

    return new Promise<GatewayEvent>((resolve, reject) => {
      this.#waiters.push({ predicate, reject, resolve })
    })
  }

  close(): void {
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
      this.#socket.close()
  }
}

function moduleCredentials() {
  return [{
    token: DISCORD_MODULE_TOKEN,
    module: {
      name: 'discord',
      identity: DISCORD_IDENTITY,
    },
    capabilities: {
      emit: ['discord:memory:command', 'input:text'],
      exclusiveEmit: ['discord:memory:command'],
      configure: [],
    },
  }]
}

async function startGateway(auth: ServerOptions['auth'] & { moduleCredentials?: ReturnType<typeof moduleCredentials> }) {
  const port = nextPort++
  const server = createServer({
    auth,
    hostname: '127.0.0.1',
    port,
  })
  activeServers.push(server)
  await server.start()
  return `ws://127.0.0.1:${port}/ws`
}

async function authenticate(client: GatewayClient, token: string, module: { name: string, identity: ModuleIdentity }): Promise<void> {
  client.send({
    type: 'module:authenticate',
    data: {
      token,
      module,
    },
  })
  const response = await client.next(event => event.type === 'module:authenticated' || event.type === 'error')
  if (response.type === 'error')
    throw new Error(String(response.data.message ?? 'Gateway authentication failed'))
}

async function announce(client: GatewayClient, name: string, identity: ModuleIdentity): Promise<void> {
  client.send({
    type: 'module:announce',
    data: {
      name,
      identity,
      possibleEvents: [],
    },
  })
  const response = await client.next((event) => {
    if (event.type === 'error')
      return true
    if (event.type === 'module:announced')
      return event.data.name === name
    if (event.type !== 'registry:modules:sync')
      return false

    const modules = event.data.modules
    return Array.isArray(modules) && modules.some((entry) => {
      if (typeof entry !== 'object' || entry === null)
        return false
      const module = entry as { name?: unknown, identity?: { id?: unknown } }
      return module.name === name && module.identity?.id === identity.id
    })
  })
  if (response.type === 'error')
    throw new Error(String(response.data.message ?? 'Gateway announcement failed'))
}

async function registerDiscordMemoryConsumer(client: GatewayClient): Promise<void> {
  client.send({
    type: 'module:consumer:register',
    data: {
      event: 'discord:memory:command',
      mode: 'consumer-group',
      group: 'discord-memory-command',
    },
  })
  client.send({
    type: 'transport:connection:heartbeat',
    data: {
      kind: 'ping',
      message: 'ping',
    },
  })
  await client.next(event => event.type === 'transport:connection:heartbeat' && event.data.kind === 'pong')
}

function memoryCommandEvent(sourcePluginId: string): GatewayEvent {
  return {
    type: 'discord:memory:command',
    data: {
      commandId: 'synthetic-command',
      action: 'memory-clear',
      sessionId: 'synthetic-session',
      userId: 'synthetic-user',
      isOwner: true,
      ownerUserIdConfigured: true,
      requestedAt: 1,
    },
    metadata: {
      source: {
        id: `${sourcePluginId}-claimed-instance`,
        kind: 'plugin',
        plugin: {
          id: sourcePluginId,
        },
      },
    },
  }
}

afterEach(async () => {
  for (const client of activeClients.splice(0))
    client.close()
  for (const server of activeServers.splice(0))
    await server.stop()
})

/**
 * @example
 * describe.sequential('discord gateway security regressions', () => {})
 */
describe.sequential('discord gateway security regressions', () => {
  /**
   * @example
   * it('prevents a paired peer from claiming the reserved Discord module (Discord audit D-001)', async () => {})
   */
  it('prevents a paired peer from claiming the reserved Discord module (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // Pairing authenticated a connection but did not bind a module principal.
    // Any paired peer could announce itself as `discord`, replace the legitimate
    // registration, and receive configuration intended for the bot.
    //
    // Before: pairing token + client-claimed Discord identity registered normally.
    // After: only the Main-provisioned Discord module credential may claim it.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const attacker = new GatewayClient(url)
    await attacker.open()
    await authenticate(attacker, PAIRING_TOKEN, {
      name: 'weather',
      identity: {
        id: 'weather-attacker-instance',
        kind: 'plugin',
        plugin: { id: 'weather' },
      },
    })

    attacker.send({
      type: 'module:announce',
      data: {
        name: 'discord',
        identity: {
          id: 'paired-attacker',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
        possibleEvents: [],
      },
    })
    const result = await attacker.next((event) => {
      if (event.type === 'error')
        return true
      if (event.type !== 'registry:modules:sync' || !Array.isArray(event.data.modules))
        return false
      return event.data.modules.some(entry => typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === 'discord')
    })

    // @example
    expect(result.type).toBe('error')
    // @example
    expect(activeClients.flatMap(client => client.frames()).join('\n')).not.toContain(DISCORD_BOT_TOKEN)
  })

  /**
   * @example
   * it('refuses a second active Discord utility registration (Discord audit D-001)', async () => {})
   */
  it('refuses a second active Discord utility registration (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // The registry silently replaced an existing `(name, index)` entry. A second
    // process holding or replaying credentials could take over the live Discord
    // destination without terminating the first process.
    //
    // Before: the second registration replaced the first.
    // After: a reserved singleton remains owned until its first peer disconnects.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const first = new GatewayClient(url)
    await first.open()
    await authenticate(first, DISCORD_MODULE_TOKEN, { name: 'discord', identity: DISCORD_IDENTITY })
    await announce(first, 'discord', DISCORD_IDENTITY)

    const second = new GatewayClient(url)
    await second.open()
    second.send({
      type: 'module:authenticate',
      data: {
        token: DISCORD_MODULE_TOKEN,
        module: {
          name: 'discord',
          identity: DISCORD_IDENTITY,
        },
      },
    })
    const authentication = await second.next(event => event.type === 'module:authenticated' || event.type === 'error')
    if (authentication.type === 'module:authenticated') {
      second.send({
        type: 'module:announce',
        data: {
          name: 'discord',
          identity: DISCORD_IDENTITY,
          possibleEvents: [],
        },
      })
    }
    const result = authentication.type === 'error'
      ? authentication
      : await second.next(event => event.type === 'error')

    // @example
    expect(result.type).toBe('error')
  })

  /**
   * @example
   * it('keeps Discord configuration off generic gateway frames (Discord audit D-001)', async () => {})
   */
  it('keeps Discord configuration off generic gateway frames (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // Discord configuration and its bot token previously travelled through the
    // generic websocket configurator. A paired module could target the reserved
    // Discord process even though its pairing principal had no configure grant.
    //
    // Before: an ordinary paired principal delivered `module:configure` to Discord.
    // After: the gateway rejects the protected configure route and no bot secret
    // appears in any sent or received websocket frame.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const discord = new GatewayClient(url)
    await discord.open()
    await authenticate(discord, DISCORD_MODULE_TOKEN, {
      name: 'discord',
      identity: DISCORD_IDENTITY,
    })
    await announce(discord, 'discord', DISCORD_IDENTITY)

    const stage = new GatewayClient(url)
    await stage.open()
    const stageIdentity: ModuleIdentity = {
      id: 'stage-configurator-instance',
      kind: 'plugin',
      plugin: { id: 'stage-tamagotchi' },
    }
    await authenticate(stage, PAIRING_TOKEN, {
      name: 'stage-tamagotchi',
      identity: stageIdentity,
    })
    await announce(stage, 'stage-tamagotchi', stageIdentity)
    stage.send({
      type: 'ui:configure',
      data: {
        moduleName: 'discord',
        config: {
          enabled: true,
          allowedChannelIds: ['synthetic-channel'],
        },
      },
    })

    const outcome = await Promise.race([
      discord.next(event => event.type === 'module:configure').then(() => 'delivered' as const),
      stage.next(event => event.type === 'error').then(() => 'rejected' as const),
    ])

    // @example
    expect(outcome).toBe('rejected')
    // @example
    expect(activeClients.flatMap(client => client.frames()).join('\n')).not.toContain(DISCORD_BOT_TOKEN)
    // @example
    expect(discord.frames().some(frame => frame.includes('module:configure'))).toBe(false)
  })

  /**
   * @example
   * Shared events remain available to ordinary paired modules when Discord also has an emit grant.
   */
  it('keeps shared input events available to paired peers (Discord audit D-003)', async () => {
    // ROOT CAUSE:
    //
    // Treating every module credential emit grant as globally exclusive made the
    // Discord grant for `input:text` block every ordinary paired input module.
    // Only grants explicitly marked exclusive may exclude paired peers.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const receiver = new GatewayClient(url)
    const receiverIdentity: ModuleIdentity = {
      id: 'chat-receiver-instance',
      kind: 'plugin',
      plugin: { id: 'chat-receiver' },
    }
    await receiver.open()
    await authenticate(receiver, PAIRING_TOKEN, { name: 'chat-receiver', identity: receiverIdentity })
    await announce(receiver, 'chat-receiver', receiverIdentity)
    receiver.send({
      type: 'module:consumer:register',
      data: {
        event: 'input:text',
        group: 'chat-ingestion',
        mode: 'consumer-group',
      },
    })

    const sender = new GatewayClient(url)
    const senderIdentity: ModuleIdentity = {
      id: 'paired-input-instance',
      kind: 'plugin',
      plugin: { id: 'paired-input' },
    }
    await sender.open()
    await authenticate(sender, PAIRING_TOKEN, { name: 'paired-input', identity: senderIdentity })
    await announce(sender, 'paired-input', senderIdentity)
    sender.send({
      type: 'input:text',
      data: { text: 'synthetic shared input' },
      metadata: {
        source: {
          id: 'forged-discord-source',
          kind: 'plugin',
          plugin: { id: 'discord' },
        },
      },
    })

    const outcome = await Promise.race([
      receiver.next(event => event.type === 'input:text').then(event => ({ event, status: 'delivered' as const })),
      sender.next(event => event.type === 'error').then(event => ({ event, status: 'rejected' as const })),
    ])

    // @example
    expect(outcome.status).toBe('delivered')
    // @example
    expect(outcome.event.metadata?.source).toEqual(senderIdentity)
  })

  /**
   * @example
   * Multiple renderer peers may retain the legacy shared module slot while protected modules remain single-owner.
   */
  it('allows multiple paired renderer instances to announce the same module slot (Discord audit D-001)', async () => {
    // ROOT CAUSE:
    //
    // Applying protected-principal duplicate rejection to generic pairing peers
    // broke Tamagotchi's existing multi-window renderer model. Singleton ownership
    // is required only for exact module-credential principals such as Discord.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const first = new GatewayClient(url)
    const firstIdentity: ModuleIdentity = {
      id: 'stage-window-one',
      kind: 'plugin',
      plugin: { id: 'stage-tamagotchi' },
    }
    await first.open()
    await authenticate(first, PAIRING_TOKEN, { name: 'stage-tamagotchi', identity: firstIdentity })
    await announce(first, 'stage-tamagotchi', firstIdentity)

    const second = new GatewayClient(url)
    const secondIdentity: ModuleIdentity = {
      id: 'stage-window-two',
      kind: 'plugin',
      plugin: { id: 'stage-tamagotchi' },
    }
    await second.open()
    await authenticate(second, PAIRING_TOKEN, { name: 'stage-tamagotchi', identity: secondIdentity })
    await announce(second, 'stage-tamagotchi', secondIdentity)

    // @example
    expect(second.frames().some(frame => frame.includes('moduleAlreadyRegistered'))).toBe(false)
  })

  /**
   * @example
   * it('rejects ui configure before authentication and does not reach the target (Discord audit D-002)', async () => {})
   */
  it('rejects ui configure before authentication and does not reach the target (Discord audit D-002)', async () => {
    // ROOT CAUSE:
    //
    // `ui:configure` was handled before the gateway's shared authentication gate.
    // A raw unauthenticated socket could therefore reconfigure or disable any
    // online module by name.
    //
    // Before: the target received `module:configure` from an unauthenticated peer.
    // After: the sender receives an auth error and the target receives nothing.
    const url = await startGateway({ token: PAIRING_TOKEN })
    const target = new GatewayClient(url)
    await target.open()
    const targetIdentity: ModuleIdentity = {
      id: 'synthetic-target-instance',
      kind: 'plugin',
      plugin: { id: 'synthetic-target' },
    }
    await authenticate(target, PAIRING_TOKEN, {
      name: 'synthetic-target',
      identity: targetIdentity,
    })
    await announce(target, 'synthetic-target', targetIdentity)

    const attacker = new GatewayClient(url)
    await attacker.open()
    attacker.send({
      type: 'ui:configure',
      data: {
        moduleName: 'synthetic-target',
        config: {
          enabled: false,
        },
      },
    })

    const outcome = await Promise.race([
      target.next(event => event.type === 'module:configure').then(() => 'delivered' as const),
      attacker.next(event => event.type === 'error').then(() => 'rejected' as const),
    ])

    // @example
    expect(outcome).toBe('rejected')
  })

  /**
   * @example
   * it('drops a forged owner command from an ordinary paired principal (Discord audit D-003)', async () => {})
   */
  it('drops a forged owner command from an ordinary paired principal (Discord audit D-003)', async () => {
    // ROOT CAUSE:
    //
    // The gateway trusted client-provided `metadata.source`, while the memory
    // consumer trusted Discord's `isOwner` payload. A normal paired module could
    // forge both fields and invoke owner-only memory operations.
    //
    // Before: Stage received the forged Discord owner command.
    // After: the non-Discord principal receives a capability error and Stage does not.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const stage = new GatewayClient(url)
    await stage.open()
    const stageIdentity: ModuleIdentity = {
      id: 'stage-instance',
      kind: 'plugin',
      plugin: { id: 'stage-tamagotchi' },
    }
    await authenticate(stage, PAIRING_TOKEN, {
      name: 'stage-tamagotchi',
      identity: stageIdentity,
    })
    await announce(stage, 'stage-tamagotchi', stageIdentity)
    await registerDiscordMemoryConsumer(stage)

    const attacker = new GatewayClient(url)
    await attacker.open()
    const weatherIdentity: ModuleIdentity = {
      id: 'weather-instance',
      kind: 'plugin',
      plugin: { id: 'weather' },
    }
    await authenticate(attacker, PAIRING_TOKEN, {
      name: 'weather',
      identity: weatherIdentity,
    })
    await announce(attacker, 'weather', weatherIdentity)
    attacker.send(memoryCommandEvent('discord'))

    const outcome = await Promise.race([
      stage.next(event => event.type === 'discord:memory:command').then(() => 'delivered' as const),
      attacker.next(event => event.type === 'error').then(() => 'rejected' as const),
    ])

    // @example
    expect(outcome).toBe('rejected')
  })

  /**
   * @example
   * it('canonicalizes legal Discord command provenance at the gateway (Discord audit D-003)', async () => {})
   */
  it('canonicalizes legal Discord command provenance at the gateway (Discord audit D-003)', async () => {
    // ROOT CAUSE:
    //
    // Even legitimate sockets could replace their stored identity by attaching a
    // new source to any event. Downstream authorization therefore had no stable,
    // server-owned provenance to trust.
    //
    // Before: the consumer observed the source claimed in the event.
    // After: it observes the identity bound by Discord module authentication.
    const url = await startGateway({
      token: PAIRING_TOKEN,
      moduleCredentials: moduleCredentials(),
    })
    const stage = new GatewayClient(url)
    await stage.open()
    const stageIdentity: ModuleIdentity = {
      id: 'stage-instance',
      kind: 'plugin',
      plugin: { id: 'stage-tamagotchi' },
    }
    await authenticate(stage, PAIRING_TOKEN, {
      name: 'stage-tamagotchi',
      identity: stageIdentity,
    })
    await announce(stage, 'stage-tamagotchi', stageIdentity)
    await registerDiscordMemoryConsumer(stage)

    const discord = new GatewayClient(url)
    await discord.open()
    await authenticate(discord, DISCORD_MODULE_TOKEN, {
      name: 'discord',
      identity: DISCORD_IDENTITY,
    })
    await announce(discord, 'discord', DISCORD_IDENTITY)
    discord.send(memoryCommandEvent('weather'))

    const received = await stage.next(event => event.type === 'discord:memory:command')

    // @example
    expect(received.metadata?.source).toEqual(DISCORD_IDENTITY)
    // @example
    expect(received.data.isOwner).toBe(true)
  })
})
