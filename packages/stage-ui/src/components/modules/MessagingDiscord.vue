<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDiscordStore } from '../../stores/modules/discord'

const { t } = useI18n()
const discordStore = useDiscordStore()
const {
  enabled,
  token,
  configured,
  observedGuilds,
  observedGuildsById,
  selectedGuildId,
  selectedChannelId,
  allowedChannelIdsText,
  adminRoleIdsText,
  allowDirectMessages,
  memoryConsentRequired,
  privacyNoticeEnabled,
  privacyNoticeText,
  auditLogEnabled,
  messagePacingMs,
  rateLimitMaxMessages,
  rateLimitWindowMs,
  selectedGuildRules,
  selectedChannelRules,
} = storeToRefs(discordStore)
const guildRulesDraft = shallowRef('')
const channelRulesDraft = shallowRef('')

const selectedObservedGuild = computed(() => {
  const guildId = selectedGuildId.value.trim()
  if (!guildId)
    return undefined

  return observedGuildsById.value[guildId]
})

const selectedObservedChannels = computed(() => {
  return Object.values(selectedObservedGuild.value?.channels ?? {})
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
})

const hasObservedGuilds = computed(() => observedGuilds.value.length > 0)
const canSaveGuildRules = computed(() => selectedGuildId.value.trim().length > 0)
const canSaveChannelRules = computed(() => selectedGuildId.value.trim().length > 0 && selectedChannelId.value.trim().length > 0)

function saveSettings() {
  void discordStore.saveSettings()
}

function clearToken() {
  discordStore.clearToken()
}

function saveGuildRules() {
  discordStore.saveGuildRules(selectedGuildId.value, guildRulesDraft.value, selectedObservedGuild.value?.guildName)
}

function saveChannelRules() {
  discordStore.saveChannelRules(selectedGuildId.value, selectedChannelId.value, channelRulesDraft.value)
}

function clearGuildRules() {
  discordStore.clearGuildRules(selectedGuildId.value)
  guildRulesDraft.value = ''
}

function clearChannelRules() {
  discordStore.clearChannelRules(selectedGuildId.value, selectedChannelId.value)
  channelRulesDraft.value = ''
}

function selectObservedGuild(guildId: string) {
  selectedGuildId.value = guildId
}

function selectObservedChannel(channelId: string) {
  selectedChannelId.value = channelId
}

watch(selectedGuildRules, (rules) => {
  guildRulesDraft.value = rules?.rules ?? ''
}, { immediate: true })

watch(selectedChannelRules, (rules) => {
  channelRulesDraft.value = rules?.rules ?? ''
}, { immediate: true })
</script>

<template>
  <div :class="['flex flex-col gap-6']">
    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.messaging-discord.enable')"
      :description="t('settings.pages.modules.messaging-discord.enable-description')"
    />

    <FieldInput
      v-model="token"
      type="password"
      :label="t('settings.pages.modules.messaging-discord.token')"
      :description="t('settings.pages.modules.messaging-discord.token-description')"
      :placeholder="t('settings.pages.modules.messaging-discord.token-placeholder')"
    />

    <section
      :class="[
        'border-t border-neutral-200 pt-6 dark:border-neutral-800',
        'flex flex-col gap-5',
      ]"
    >
      <div :class="['flex items-center gap-2']">
        <span :class="['i-solar:shield-check-line-duotone size-5 text-primary-500']" />
        <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
          {{ t('settings.pages.modules.messaging-discord.security.title') }}
        </h2>
      </div>

      <FieldInput
        v-model="allowedChannelIdsText"
        :single-line="false"
        :label="t('settings.pages.modules.messaging-discord.security.allowed-channel-ids')"
        :description="t('settings.pages.modules.messaging-discord.security.allowed-channel-ids-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.allowed-channel-ids-placeholder')"
        input-class="min-h-24 font-mono"
      />

      <FieldCheckbox
        v-model="allowDirectMessages"
        :label="t('settings.pages.modules.messaging-discord.security.allow-direct-messages')"
        :description="t('settings.pages.modules.messaging-discord.security.allow-direct-messages-description')"
      />

      <FieldInput
        v-model="adminRoleIdsText"
        :single-line="false"
        :label="t('settings.pages.modules.messaging-discord.security.admin-role-ids')"
        :description="t('settings.pages.modules.messaging-discord.security.admin-role-ids-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.admin-role-ids-placeholder')"
        input-class="min-h-20 font-mono"
      />

      <FieldCheckbox
        v-model="memoryConsentRequired"
        :label="t('settings.pages.modules.messaging-discord.security.memory-consent-required')"
        :description="t('settings.pages.modules.messaging-discord.security.memory-consent-required-description')"
      />

      <FieldCheckbox
        v-model="privacyNoticeEnabled"
        :label="t('settings.pages.modules.messaging-discord.security.privacy-notice-enabled')"
        :description="t('settings.pages.modules.messaging-discord.security.privacy-notice-enabled-description')"
      />

      <FieldInput
        v-model="privacyNoticeText"
        :single-line="false"
        :label="t('settings.pages.modules.messaging-discord.security.privacy-notice-text')"
        :description="t('settings.pages.modules.messaging-discord.security.privacy-notice-text-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.privacy-notice-text-placeholder')"
        input-class="min-h-20"
      />

      <FieldCheckbox
        v-model="auditLogEnabled"
        :label="t('settings.pages.modules.messaging-discord.security.audit-log-enabled')"
        :description="t('settings.pages.modules.messaging-discord.security.audit-log-enabled-description')"
      />

      <FieldInput
        v-model="messagePacingMs"
        type="number"
        :label="t('settings.pages.modules.messaging-discord.security.message-pacing-ms')"
        :description="t('settings.pages.modules.messaging-discord.security.message-pacing-ms-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.message-pacing-ms-placeholder')"
      />

      <FieldInput
        v-model="rateLimitMaxMessages"
        type="number"
        :label="t('settings.pages.modules.messaging-discord.security.rate-limit-max-messages')"
        :description="t('settings.pages.modules.messaging-discord.security.rate-limit-max-messages-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.rate-limit-max-messages-placeholder')"
      />

      <FieldInput
        v-model="rateLimitWindowMs"
        type="number"
        :label="t('settings.pages.modules.messaging-discord.security.rate-limit-window-ms')"
        :description="t('settings.pages.modules.messaging-discord.security.rate-limit-window-ms-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.security.rate-limit-window-ms-placeholder')"
      />
    </section>

    <div :class="['flex flex-wrap gap-2']">
      <Button
        :label="t('settings.common.save')"
        icon="i-solar:check-circle-line-duotone"
        variant="primary"
        @click="saveSettings"
      />
      <Button
        :label="t('settings.pages.modules.messaging-discord.clear-token')"
        icon="i-solar:trash-bin-minimalistic-line-duotone"
        variant="secondary"
        @click="clearToken"
      />
    </div>

    <div
      v-if="configured"
      :class="[
        'rounded-lg p-4 text-sm',
        'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-100',
      ]"
    >
      {{ t('settings.pages.modules.messaging-discord.configured') }}
    </div>

    <section
      :class="[
        'border-t border-neutral-200 pt-6 dark:border-neutral-800',
        'flex flex-col gap-5',
      ]"
    >
      <div :class="['flex items-center gap-2']">
        <span :class="['i-simple-icons:discord size-5 text-[#5865F2]']" />
        <h2 :class="['text-base font-semibold text-neutral-900 dark:text-neutral-100']">
          {{ t('settings.pages.modules.messaging-discord.rules.title') }}
        </h2>
      </div>

      <FieldInput
        v-model="selectedGuildId"
        :label="t('settings.pages.modules.messaging-discord.rules.guild-id')"
        :description="t('settings.pages.modules.messaging-discord.rules.guild-id-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.rules.guild-id-placeholder')"
      />

      <FieldInput
        v-model="guildRulesDraft"
        :single-line="false"
        :label="t('settings.pages.modules.messaging-discord.rules.guild-rules')"
        :description="t('settings.pages.modules.messaging-discord.rules.guild-rules-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.rules.guild-rules-placeholder')"
        input-class="min-h-32 font-mono"
      />

      <div :class="['flex flex-wrap gap-2']">
        <Button
          :disabled="!canSaveGuildRules"
          :label="t('settings.pages.modules.messaging-discord.rules.save-guild')"
          icon="i-solar:check-circle-line-duotone"
          variant="primary"
          @click="saveGuildRules"
        />
        <Button
          :disabled="!canSaveGuildRules"
          :label="t('settings.pages.modules.messaging-discord.rules.clear-guild')"
          icon="i-solar:trash-bin-minimalistic-line-duotone"
          variant="secondary"
          @click="clearGuildRules"
        />
      </div>

      <FieldInput
        v-model="selectedChannelId"
        :label="t('settings.pages.modules.messaging-discord.rules.channel-id')"
        :description="t('settings.pages.modules.messaging-discord.rules.channel-id-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.rules.channel-id-placeholder')"
      />

      <FieldInput
        v-model="channelRulesDraft"
        :single-line="false"
        :label="t('settings.pages.modules.messaging-discord.rules.channel-rules')"
        :description="t('settings.pages.modules.messaging-discord.rules.channel-rules-description')"
        :placeholder="t('settings.pages.modules.messaging-discord.rules.channel-rules-placeholder')"
        input-class="min-h-28 font-mono"
      />

      <div :class="['flex flex-wrap gap-2']">
        <Button
          :disabled="!canSaveChannelRules"
          :label="t('settings.pages.modules.messaging-discord.rules.save-channel')"
          icon="i-solar:check-circle-line-duotone"
          variant="primary"
          @click="saveChannelRules"
        />
        <Button
          :disabled="!canSaveChannelRules"
          :label="t('settings.pages.modules.messaging-discord.rules.clear-channel')"
          icon="i-solar:trash-bin-minimalistic-line-duotone"
          variant="secondary"
          @click="clearChannelRules"
        />
      </div>

      <div :class="['flex flex-col gap-3']">
        <div :class="['text-sm font-medium text-neutral-800 dark:text-neutral-200']">
          {{ t('settings.pages.modules.messaging-discord.rules.observed') }}
        </div>
        <div
          v-if="hasObservedGuilds"
          :class="['flex flex-col gap-2']"
        >
          <div
            v-for="guild in observedGuilds"
            :key="guild.guildId"
            :class="[
              'flex flex-wrap items-center gap-2',
              'rounded-lg border border-neutral-200 p-2 dark:border-neutral-800',
            ]"
          >
            <Button
              :label="guild.guildName || guild.guildId"
              icon="i-solar:server-square-cloud-line-duotone"
              variant="secondary"
              size="sm"
              @click="selectObservedGuild(guild.guildId)"
            />
            <span :class="['font-mono text-xs text-neutral-500 dark:text-neutral-400']">
              {{ guild.guildId }}
            </span>
          </div>
        </div>
        <div
          v-else
          :class="['text-sm text-neutral-500 dark:text-neutral-400']"
        >
          {{ t('settings.pages.modules.messaging-discord.rules.no-observed') }}
        </div>
      </div>

      <div
        v-if="selectedObservedChannels.length"
        :class="['flex flex-col gap-3']"
      >
        <div :class="['text-sm font-medium text-neutral-800 dark:text-neutral-200']">
          {{ t('settings.pages.modules.messaging-discord.rules.observed-channels') }}
        </div>
        <div :class="['flex flex-wrap gap-2']">
          <Button
            v-for="channel in selectedObservedChannels"
            :key="channel.channelId"
            :label="channel.channelId"
            icon="i-solar:hashtag-chat-line-duotone"
            variant="secondary"
            size="sm"
            @click="selectObservedChannel(channel.channelId)"
          />
        </div>
      </div>
    </section>
  </div>
</template>
