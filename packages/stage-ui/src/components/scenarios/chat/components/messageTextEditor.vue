<script setup lang="ts">
import { Button, Textarea } from '@proj-airi/ui'
import { computed } from 'vue'

const emit = defineEmits<{
  cancel: []
  save: [content: string]
}>()
const draft = defineModel<string>({ required: true })

const canSave = computed(() => draft.value.trim().length > 0)

function save() {
  if (canSave.value)
    emit('save', draft.value.trim())
}
</script>

<template>
  <div :class="['w-full', 'space-y-2']">
    <Textarea
      v-model="draft"
      aria-label="Edit message"
      :submit-on-enter="false"
    />
    <div :class="['flex', 'justify-end', 'gap-2']">
      <Button
        label="Cancel"
        size="sm"
        variant="ghost"
        @click="emit('cancel')"
      />
      <Button
        :disabled="!canSave"
        label="Save"
        size="sm"
        @click="save"
      />
    </div>
  </div>
</template>
