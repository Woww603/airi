import type { InferOutput } from 'valibot'

import { any, array, number, object, optional, parse, safeParse, string } from 'valibot'

import { createConfig } from '../libs/electron/persistence'

const artistryGlobalsSchema = object({
  comfyuiServerUrl: optional(string(), 'http://localhost:8188'),
  comfyuiSavedWorkflows: optional(array(any()), []),
  comfyuiActiveWorkflow: optional(string(), ''),
  replicateApiKey: optional(string(), ''),
  replicateDefaultModel: optional(string(), 'black-forest-labs/flux-schnell'),
  replicateAspectRatio: optional(string(), '16:9'),
  replicateInferenceSteps: optional(number(), 4),
  nanobananaApiKey: optional(string(), ''),
  nanobananaModel: optional(string(), 'gemini-3.1-flash-image-preview'),
  nanobananaResolution: optional(string(), '1K'),
})

export const artistryConfigSchema = object({
  artistryProvider: optional(string(), 'none'),
  artistryGlobals: optional(artistryGlobalsSchema, {}),
})

/**
 * Normalizes artistry globals into a persistence-safe non-secret projection.
 *
 * Before:
 * - `{ replicateApiKey: "r8_secret", nanobananaApiKey: "AIza_secret" }`
 *
 * After:
 * - `{ replicateApiKey: "", nanobananaApiKey: "" }`
 */
export function sanitizeArtistryGlobalsForPersistence(input: unknown): InferOutput<typeof artistryGlobalsSchema> {
  const parsed = safeParse(artistryGlobalsSchema, input)
  const globals = parsed.success ? parsed.output : parse(artistryGlobalsSchema, {})
  return {
    ...globals,
    replicateApiKey: '',
    nanobananaApiKey: '',
  }
}

export function createArtistryConfig() {
  const config = createConfig('artistry', 'options.json', artistryConfigSchema)
  config.setup()
  const current = config.get()
  config.update({
    artistryProvider: current?.artistryProvider || 'none',
    artistryGlobals: sanitizeArtistryGlobalsForPersistence(current?.artistryGlobals),
  })

  return config
}
