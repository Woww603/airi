import { describe, expect, it } from 'vitest'

import { ToolRegistryService } from './tools'

function registerNeverSettlingTool(service: ToolRegistryService) {
  service.register({
    ownerSessionId: 'session-a',
    ownerPluginId: 'plugin-a',
    tool: {
      id: 'hang',
      title: 'Hang',
      description: 'Never settles.',
      activation: { keywords: [], patterns: [] },
      parameters: { type: 'object', properties: {} },
    },
    execute: () => new Promise(() => {}),
  })
}

/**
 * @example
 * describe('tool registry service invocation limits', () => {})
 */
describe('tool registry service invocation limits', () => {
  /**
   * @example
   * it('rejects calls above the configured concurrency limit', async () => {})
   */
  it('rejects calls above the configured concurrency limit', async () => {
    const service = new ToolRegistryService({
      maxConcurrentInvocations: 2,
      invocationTimeoutMs: 20,
    })
    registerNeverSettlingTool(service)

    const first = service.invoke('plugin-a', 'hang', {})
    const second = service.invoke('plugin-a', 'hang', {})

    // @example
    await expect(service.invoke('plugin-a', 'hang', {})).rejects.toThrow('concurrent invocation limit')
    // @example
    await expect(first).rejects.toThrow('timed out')
    // @example
    await expect(second).rejects.toThrow('timed out')

    // Timed-out executions remain charged until the plugin actually settles, so a
    // malicious tool cannot turn caller timeouts into unlimited background work.
    // @example
    await expect(service.invoke('plugin-a', 'hang', {})).rejects.toThrow('concurrent invocation limit')
  })
})
