<script setup lang="ts">
import { useChatMemoryStore } from '@proj-airi/stage-ui/stores/chat-memory'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { Button, DoubleCheckButton, FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()
const memoryStore = useChatMemoryStore()
const chatSessionStore = useChatSessionStore()
const { enabled, fragments, loading, memoryCount } = storeToRefs(memoryStore)
const { activeSessionId } = storeToRefs(chatSessionStore)

const activeMemorySessionId = computed(() => activeSessionId.value || 'default')
const currentScope = computed(() => memoryStore.currentScope(activeMemorySessionId.value))
const currentScopeParams = computed<Record<string, unknown>>(() => ({
  userId: currentScope.value.userId,
  characterId: currentScope.value.characterId,
  sessionId: currentScope.value.sessionId,
}))
const sortedFragments = computed(() => [...fragments.value].sort((a, b) => b.createdAt - a.createdAt))

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(locale.value || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function roleLabel(role: 'user' | 'assistant') {
  return t(`settings.pages.modules.memory-long-term.roles.${role}`)
}

async function refreshMemories() {
  await memoryStore.loadCurrentScope(activeMemorySessionId.value)
}

async function forgetMemory(id: string) {
  await memoryStore.forgetMemory(activeMemorySessionId.value, id)
}

async function clearMemories() {
  await memoryStore.clearCurrentScope(activeMemorySessionId.value)
}

watch(activeMemorySessionId, () => {
  void refreshMemories()
}, { immediate: true })
</script>

<template>
  <div class="flex flex-col gap-4 pb-4">
    <div class="border-2 border-neutral-200/50 rounded-lg bg-white/70 p-4 shadow-sm dark:border-neutral-800/60 dark:bg-neutral-900/60">
      <div class="grid grid-cols-1 items-start gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <FieldCheckbox
          v-model="enabled"
          :label="t('settings.pages.modules.memory-long-term.enable')"
          :description="t('settings.pages.modules.memory-long-term.enable-description')"
        />

        <div class="flex flex-wrap items-center gap-2 md:justify-end">
          <Button
            variant="secondary"
            icon="i-solar:refresh-bold-duotone"
            :label="t('settings.pages.modules.memory-long-term.refresh')"
            :loading="loading"
            @click="refreshMemories"
          />
          <DoubleCheckButton
            variant="danger"
            :disabled="memoryCount === 0"
            @confirm="clearMemories"
          >
            {{ t('settings.pages.modules.memory-long-term.clear') }}
            <template #confirm>
              {{ t('settings.pages.modules.memory-long-term.confirm-clear') }}
            </template>
            <template #cancel>
              {{ t('settings.pages.card.cancel') }}
            </template>
          </DoubleCheckButton>
        </div>
      </div>

      <div class="grid grid-cols-1 mt-4 gap-2 text-xs text-neutral-500 sm:grid-cols-2 dark:text-neutral-400">
        <div>
          {{ t('settings.pages.modules.memory-long-term.scope', currentScopeParams) }}
        </div>
        <div class="sm:text-right">
          {{ t('settings.pages.modules.memory-long-term.count', { count: memoryCount }) }}
        </div>
      </div>
    </div>

    <div class="border-2 border-sky-200/50 rounded-lg bg-sky-50/70 p-4 text-sm text-sky-950 dark:border-sky-800/50 dark:bg-sky-950/30 dark:text-sky-100">
      <div class="mb-1 flex items-center gap-2 font-medium">
        <div class="i-solar:shield-check-bold-duotone h-4 w-4" />
        {{ t('settings.pages.modules.memory-long-term.privacy-title') }}
      </div>
      <p class="text-sky-900/80 dark:text-sky-100/75">
        {{ t('settings.pages.modules.memory-long-term.privacy-description') }}
      </p>
    </div>

    <div v-if="loading" class="rounded-lg bg-neutral-100/70 p-4 text-sm text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400">
      {{ t('settings.pages.modules.memory-long-term.loading') }}
    </div>

    <div v-else-if="sortedFragments.length === 0" class="rounded-lg bg-neutral-100/70 p-4 text-sm text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400">
      {{ t('settings.pages.modules.memory-long-term.empty') }}
    </div>

    <div v-else class="flex flex-col gap-3">
      <div
        v-for="memory in sortedFragments"
        :key="memory.id"
        class="border-2 border-neutral-200/50 rounded-lg bg-white/75 p-4 shadow-sm dark:border-neutral-800/60 dark:bg-neutral-900/60"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span class="rounded-md bg-neutral-100 px-2 py-1 text-neutral-700 font-medium dark:bg-neutral-800 dark:text-neutral-200">
              {{ roleLabel(memory.role) }}
            </span>
            <span>{{ formatDate(memory.createdAt) }}</span>
            <span>{{ t('settings.pages.modules.memory-long-term.accessed', { count: memory.accessCount }) }}</span>
          </div>
          <DoubleCheckButton
            variant="danger"
            size="sm"
            @confirm="forgetMemory(memory.id)"
          >
            <span class="inline-flex items-center gap-2">
              <div class="i-solar:trash-bin-trash-bold-duotone h-4 w-4" />
              {{ t('settings.pages.modules.memory-long-term.delete') }}
            </span>
            <template #confirm>
              {{ t('settings.pages.modules.memory-long-term.confirm-delete') }}
            </template>
            <template #cancel>
              {{ t('settings.pages.card.cancel') }}
            </template>
          </DoubleCheckButton>
        </div>

        <p class="whitespace-pre-wrap break-words text-sm text-neutral-800 leading-relaxed dark:text-neutral-100">
          {{ memory.content }}
        </p>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-long-term.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
