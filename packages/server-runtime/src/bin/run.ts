#!/usr/bin/env tsx

import process, { env } from 'node:process'

import { useLogg } from '@guiiai/logg'

import { createServer } from '../server'
import { ServerProcessLifecycle } from './processLifecycle'

/**
 * Runs the standalone AIRI server process with one signal owner.
 *
 * Call stack:
 *
 * main
 *   -> {@link ServerProcessLifecycle.start}
 *     -> createServer().start()
 *   -> SIGINT / SIGTERM
 *     -> {@link ServerProcessLifecycle.shutdown}
 *       -> createServer().stop()
 */
async function main() {
  const log = useLogg('@proj-airi/server-runtime/cli')
  const server = createServer({
    port: env.PORT ? Number.parseInt(env.PORT) : 6121,
  })
  const lifecycle = new ServerProcessLifecycle(server, process, {
    onError: error => log.withError(error).error('server process shutdown failed'),
  })

  await lifecycle.start()
}

void main().catch((error) => {
  useLogg('@proj-airi/server-runtime/cli').withError(error).error('server process failed to start')
  process.exitCode = 1
})
