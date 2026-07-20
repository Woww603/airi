<script setup lang="ts">
import type { PromptProjectionSnapshot } from '@proj-airi/stage-ui/stores/devtools/context-observability'

import { computed } from 'vue'

type PromptContribution = PromptProjectionSnapshot['contributions'][number]

const props = defineProps<{
  contributions: PromptContribution[]
}>()

const includedContributions = computed(() => props.contributions.filter(contribution => contribution.status === 'included'))
const excludedContributions = computed(() => props.contributions.filter(contribution => contribution.status === 'excluded'))
const contributionGroups = computed(() => [
  { id: 'included', title: 'Injected Items', items: includedContributions.value },
  { id: 'excluded', title: 'Excluded Items', items: excludedContributions.value },
])

function exclusionReason(contribution: PromptContribution) {
  const reason = contribution.metadata?.reason
  return typeof reason === 'string' ? reason : 'excluded by source policy'
}
</script>

<template>
  <div :class="['grid', 'gap-3', 'xl:grid-cols-2']">
    <section
      v-for="group in contributionGroups"
      :key="group.id"
      :class="[
        'rounded-xl',
        'border',
        'border-neutral-200/70',
        'bg-white/80',
        'p-4',
        'dark:border-neutral-800/80',
        'dark:bg-neutral-950/60',
      ]"
    >
      <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
        <h3 :class="['text-xs', 'font-medium', 'uppercase', 'tracking-[0.08em]', 'text-neutral-500', 'dark:text-neutral-400']">
          {{ group.title }}
        </h3>
        <span :class="['rounded-full', 'bg-neutral-100', 'px-2', 'py-0.5', 'text-xs', 'text-neutral-500', 'dark:bg-neutral-900', 'dark:text-neutral-400']">
          {{ group.items.length }}
        </span>
      </div>

      <div v-if="group.items.length" :class="['mt-3', 'space-y-2']">
        <article
          v-for="contribution in group.items"
          :key="contribution.id"
          :class="[
            'rounded-lg',
            'border',
            'p-3',
            contribution.status === 'included'
              ? 'border-emerald-200/80 bg-emerald-50/60 dark:border-emerald-900/80 dark:bg-emerald-950/20'
              : 'border-amber-200/80 bg-amber-50/60 dark:border-amber-900/80 dark:bg-amber-950/20',
          ]"
        >
          <div :class="['flex', 'flex-wrap', 'items-start', 'justify-between', 'gap-2']">
            <div>
              <div :class="['text-sm', 'font-medium', 'text-neutral-800', 'dark:text-neutral-100']">
                {{ contribution.label }}
              </div>
              <div :class="['mt-0.5', 'text-xs', 'text-neutral-500', 'dark:text-neutral-400']">
                {{ contribution.source }} · {{ contribution.placement }}
                <template v-if="contribution.estimatedTokens !== undefined">
                  · ~{{ contribution.estimatedTokens }} tokens
                </template>
              </div>
            </div>
            <span
              :class="[
                'rounded-full',
                'px-2',
                'py-0.5',
                'text-[11px]',
                contribution.status === 'included'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
              ]"
            >
              {{ contribution.status === 'included' ? 'in prompt' : exclusionReason(contribution) }}
            </span>
          </div>

          <pre
            v-if="contribution.content"
            :class="['mt-2', 'max-h-40', 'overflow-auto', 'whitespace-pre-wrap', 'break-words', 'rounded-md', 'bg-neutral-900/90', 'p-2', 'text-xs', 'font-mono', 'text-neutral-100']"
          >{{ contribution.content }}</pre>
        </article>
      </div>

      <div v-else :class="['mt-3', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
        {{ group.id === 'included' ? 'No dynamic prompt items were injected.' : 'No prompt items were excluded.' }}
      </div>
    </section>
  </div>
</template>
