import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import config from '../electron-builder.config'

/**
 * @example
 * describe('desktop packaging security policy', () => {})
 */
describe('desktop packaging security policy', () => {
  /**
   * @example
   * it('enables production Electron fuses and signature enforcement', () => {})
   */
  it('enables production Electron fuses and signature enforcement', () => {
    // @example
    expect(config.electronFuses).toEqual(expect.objectContaining({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
    }))
    // @example
    expect(config.mac?.forceCodeSigning).toBe(true)
    // @example
    expect(config.win?.verifyUpdateCodeSignature).toBe(true)
    // @example
    expect(config.mac?.extendInfo).toEqual(expect.objectContaining({
      NSAppTransportSecurity: expect.objectContaining({
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      }),
      NSMicrophoneUsageDescription: expect.any(String),
      NSCameraUsageDescription: expect.any(String),
    }))
    // @example
    expect(config.afterPack).toEqual(expect.any(Function))
  })

  /**
   * @example
   * it('does not grant dynamic-loader environment overrides', async () => {})
   */
  it('does not grant dynamic-loader environment overrides', async () => {
    const entitlements = await readFile(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8')

    // @example
    expect(entitlements).not.toContain('com.apple.security.cs.allow-dyld-environment-variables')
  })

  /**
   * @example
   * it('publishes only after platform signing completes', async () => {})
   */
  it('publishes only after platform signing completes', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/release-tamagotchi.yml', import.meta.url), 'utf8')
    const buildInvocations = workflow.match(/electron-builder build[^\n]+--publish=never/g) ?? []
    const releaseSigningBlock = workflow.slice(
      workflow.indexOf('id: signpath-release-windows'),
      workflow.indexOf('- name: Move Signed Artifacts (Automatic + Windows Only)'),
    )
    const manualSigningBlock = workflow.slice(
      workflow.indexOf('id: signpath-manual-windows'),
      workflow.indexOf('- name: Move Signed Artifacts (Manual + Release + Windows Only)'),
    )
    const mutableActionReferences = [...workflow.matchAll(/uses:\s+\S+@\S+/g)]
      .map(([match]) => match.replace(/^uses:\s+/, ''))
      .filter(reference => !/@[\da-f]{40}$/.test(reference))
    const disabledCredentialPersistence = workflow.match(/persist-credentials: false/g) ?? []
    const windowsSignatureChecks = workflow.match(/Get-AuthenticodeSignature/g) ?? []
    const windowsPublisherChecks = workflow.match(/SignerCertificate\.Subject -ne \$env:WINDOWS_PUBLISHER_NAME/g) ?? []

    // @example
    expect(buildInvocations).toHaveLength(3)
    // @example
    expect(workflow).not.toContain('--publish=${{')
    // @example
    expect(releaseSigningBlock).not.toContain('continue-on-error: true')
    // @example
    expect(manualSigningBlock).not.toContain('continue-on-error: true')
    // @example
    expect(workflow).toContain('WINDOWS_PUBLISHER_NAME: $' + '{{ secrets.WINDOWS_PUBLISHER_NAME }}')
    // @example
    expect(workflow).toContain('CSC_LINK="$RUNNER_TEMP/apple-developer-code-signing.p12"')
    // @example
    expect(mutableActionReferences).toEqual([])
    // @example
    expect(disabledCredentialPersistence).toHaveLength(2)
    // @example
    expect(windowsSignatureChecks).toHaveLength(2)
    // @example
    expect(windowsPublisherChecks).toHaveLength(2)
  })
})
