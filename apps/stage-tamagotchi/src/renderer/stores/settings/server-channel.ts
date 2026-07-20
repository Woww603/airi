import type { ElectronServerChannelConfig } from '../../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useSensitiveStorage } from '@proj-airi/stage-shared/composables'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { toast } from 'vue-sonner'

import {
  electronApplyServerChannelConfig,
  electronGetServerChannelConfig,

} from '../../../shared/eventa'

export const useServerChannelSettingsStore = defineStore('tamagotchi-server-channel-settings', () => {
  const tlsConfig = useSensitiveStorage<{ cert?: string, key?: string, passphrase?: string } | null | undefined>('settings/server-channel/websocket-tls-config', null)
  const hostname = useLocalStorage<string>('settings/server-channel/hostname', '127.0.0.1')
  const authToken = useSensitiveStorage<string>('settings/server-channel/auth-token', '')
  const lastApplyError = ref<string | null>(null)
  let authoritativeConfigSnapshot: string | undefined

  const getServerChannelConfig = useElectronEventaInvoke(electronGetServerChannelConfig)
  const applyServerChannelConfig = useElectronEventaInvoke(electronApplyServerChannelConfig)

  function syncConfigFromServer(config: ElectronServerChannelConfig) {
    const normalizedConfig: ElectronServerChannelConfig = {
      tlsConfig: config.tlsConfig ? {} : null,
      hostname: config.hostname,
      authToken: config.authToken,
    }

    // Vue watchers run after this function returns. Record the authoritative
    // state first so the delayed callback cannot write server values back.
    authoritativeConfigSnapshot = JSON.stringify(normalizedConfig)
    tlsConfig.value = normalizedConfig.tlsConfig
    hostname.value = normalizedConfig.hostname
    authToken.value = normalizedConfig.authToken
  }

  async function refreshServerChannelConfig() {
    const config = await getServerChannelConfig()
    syncConfigFromServer(config)
    return config
  }

  watch([tlsConfig, hostname, authToken], async ([newTls, newHost, newAuth], [oldTls, oldHost, oldAuth]) => {
    const nextConfig: ElectronServerChannelConfig = {
      tlsConfig: newTls ? {} : null,
      hostname: newHost,
      authToken: newAuth,
    }

    if (JSON.stringify(nextConfig) === authoritativeConfigSnapshot
      || (JSON.stringify(newTls) === JSON.stringify(oldTls) && newHost === oldHost && newAuth === oldAuth)) {
      return
    }

    lastApplyError.value = null

    try {
      const config = await applyServerChannelConfig(nextConfig)
      syncConfigFromServer(config)
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Failed to apply WebSocket security setting'
      lastApplyError.value = message

      syncConfigFromServer({
        tlsConfig: oldTls ? {} : null,
        hostname: oldHost,
        authToken: oldAuth,
      })

      toast.error(message)
    }
  })

  return {
    lastApplyError,
    refreshServerChannelConfig,
    syncConfigFromServer,
    tlsConfig,
    hostname,
    authToken,
  }
})
