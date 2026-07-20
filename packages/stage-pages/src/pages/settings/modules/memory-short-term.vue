<script setup lang="ts">
import { Button } from '@proj-airi/ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const router = useRouter()
const { t } = useI18n()

function openLongTermMemory() {
  router.push('/settings/modules/memory-long-term')
}
</script>

<template>
  <div class="flex flex-col gap-4 pb-4">
    <div class="border-2 border-neutral-200/50 rounded-lg bg-white/70 p-4 shadow-sm dark:border-neutral-800/60 dark:bg-neutral-900/60">
      <div class="flex items-start gap-3">
        <div class="i-solar:bookmark-bold-duotone mt-0.5 h-6 w-6 text-primary-600 dark:text-primary-300" />
        <div class="min-w-0 flex-1">
          <div class="text-lg text-neutral-900 font-medium dark:text-neutral-50">
            {{ t('settings.pages.modules.memory-short-term.status-title') }}
          </div>
          <p class="mt-1 text-sm text-neutral-600 leading-relaxed dark:text-neutral-400">
            {{ t('settings.pages.modules.memory-short-term.status-description') }}
          </p>
        </div>
      </div>
    </div>

    <div class="border-2 border-neutral-200/50 rounded-lg bg-white/70 p-4 shadow-sm dark:border-neutral-800/60 dark:bg-neutral-900/60">
      <div class="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <div class="text-sm text-neutral-900 font-medium dark:text-neutral-50">
            {{ t('settings.pages.modules.memory-short-term.long-term-title') }}
          </div>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {{ t('settings.pages.modules.memory-short-term.long-term-description') }}
          </p>
        </div>
        <Button
          variant="primary"
          icon="i-solar:book-bookmark-bold-duotone"
          :label="t('settings.pages.modules.memory-short-term.open-long-term')"
          @click="openLongTermMemory"
        />
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-short-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
