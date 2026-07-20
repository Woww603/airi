<script setup lang="ts">
import { Button, Input, Textarea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'

import { useChatSessionStore } from '../../../../stores/chat/session-store'

const chatSession = useChatSessionStore()
const { activeSessionId, sessionMessages, sessionMetas } = storeToRefs(chatSession)

const personaNameDraft = shallowRef('')
const personaDescriptionDraft = shallowRef('')
const authorNoteDraft = shallowRef('')
const summaryDraft = shallowRef('')

const activeProfile = computed(() => sessionMetas.value[activeSessionId.value]?.promptProfile)
const currentSourceMessageIds = computed(() => (sessionMessages.value[activeSessionId.value] ?? [])
  .filter(message => (message.role === 'user' || message.role === 'assistant') && message.id)
  .map(message => message.id!))
const newMessagesSinceSummary = computed(() => {
  const covered = new Set(activeProfile.value?.rollingSummary?.sourceMessageIds ?? [])
  return currentSourceMessageIds.value.filter(id => !covered.has(id)).length
})

watch(
  () => [activeSessionId.value, activeProfile.value] as const,
  ([, profile]) => {
    personaNameDraft.value = profile?.userPersona?.name ?? ''
    personaDescriptionDraft.value = profile?.userPersona?.description ?? ''
    authorNoteDraft.value = profile?.authorNote ?? ''
    summaryDraft.value = profile?.rollingSummary?.content ?? ''
  },
  { immediate: true },
)

function savePersonaAndNote() {
  chatSession.updateSessionPromptProfile(activeSessionId.value, {
    authorNote: authorNoteDraft.value,
    userPersona: {
      description: personaDescriptionDraft.value,
      name: personaNameDraft.value,
    },
  })
}

function saveSummary() {
  chatSession.updateSessionPromptProfile(activeSessionId.value, {
    rollingSummary: summaryDraft.value.trim()
      ? {
          content: summaryDraft.value,
          sourceMessageIds: currentSourceMessageIds.value,
          updatedAt: Date.now(),
        }
      : undefined,
  })
}
</script>

<template>
  <details
    v-if="activeSessionId"
    :class="[
      'mx-2',
      'rounded-xl',
      'border',
      'border-neutral-200/70',
      'bg-white/70',
      'dark:border-neutral-800/70',
      'dark:bg-neutral-950/50',
    ]"
  >
    <summary :class="['cursor-pointer', 'select-none', 'px-3', 'py-2', 'text-sm', 'text-neutral-600', 'dark:text-neutral-300']">
      Prompt memory & persona
      <span v-if="newMessagesSinceSummary > 0" :class="['ml-2', 'text-xs', 'text-amber-600', 'dark:text-amber-300']">
        {{ newMessagesSinceSummary }} new message{{ newMessagesSinceSummary === 1 ? '' : 's' }} since summary
      </span>
    </summary>

    <div :class="['grid', 'gap-4', 'border-t', 'border-neutral-200/70', 'p-3', 'dark:border-neutral-800/70', 'xl:grid-cols-2']">
      <section :class="['space-y-2']">
        <div>
          <h3 :class="['text-sm', 'font-medium', 'text-neutral-800', 'dark:text-neutral-100']">
            User persona
          </h3>
          <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            Session-only identity shown to the model before the character prompt.
          </p>
        </div>
        <Input v-model="personaNameDraft" aria-label="Persona name" placeholder="Persona name" size="sm" />
        <Textarea v-model="personaDescriptionDraft" aria-label="Persona description" placeholder="Traits, background, preferences" />

        <div>
          <h3 :class="['text-sm', 'font-medium', 'text-neutral-800', 'dark:text-neutral-100']">
            Author's note
          </h3>
          <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            Temporary direction appended late in the system prompt.
          </p>
        </div>
        <Textarea v-model="authorNoteDraft" aria-label="Author note" placeholder="Tone, scene direction, temporary constraint" />
        <div :class="['flex', 'justify-end']">
          <Button label="Save persona & note" size="sm" @click="savePersonaAndNote" />
        </div>
      </section>

      <section :class="['space-y-2']">
        <div>
          <h3 :class="['text-sm', 'font-medium', 'text-neutral-800', 'dark:text-neutral-100']">
            Editable rolling summary
          </h3>
          <p :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            Write a compact memory of earlier turns. Saving marks the current message range as covered; AIRI does not silently rewrite it.
          </p>
        </div>
        <Textarea v-model="summaryDraft" aria-label="Conversation summary" placeholder="Important facts, decisions, relationship changes, unresolved goals" />
        <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
          <span :class="['text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
            {{ activeProfile?.rollingSummary?.sourceMessageIds.length ?? 0 }} covered · {{ newMessagesSinceSummary }} new
          </span>
          <Button :label="summaryDraft.trim() ? 'Save summary' : 'Clear summary'" size="sm" @click="saveSummary" />
        </div>
      </section>
    </div>
  </details>
</template>
