import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { openaiTranscribe, textFromResult } from './tts'

/**
 * @example
 * describe('speech transcription result normalization', () => {})
 */
describe('speech transcription result normalization', () => {
  /**
   * @example
   * it('reads object and segmented transcription results without inventing text', () => {})
   */
  it('reads object and segmented transcription results without inventing text', () => {
    expect(textFromResult({ text: 'hello' })).toBe('hello')
    expect(textFromResult([{ text: 'first' }, { text: 'second' }])).toBe('first')
    expect(textFromResult([])).toBe('')
  })

  /**
   * @example
   * it('reproduces Discord audit D-018 by propagating sanitized STT cancellation instead of returning blank text', async () => {})
   */
  it('reproduces Discord audit D-018 by propagating sanitized STT cancellation instead of returning blank text', async () => {
    const lifecycle = new AbortController()
    lifecycle.abort(new Error('Synthetic Discord speaker generation stopped.'))

    // ROOT CAUSE:
    //
    // The legacy pipeline caught every remote STT error and returned an empty
    // transcript. Timeout/cancellation therefore looked like valid blank audio,
    // hid the provider failure, and prevented lifecycle code from classifying it.
    // @example
    await expect(openaiTranscribe(
      Buffer.from([1]),
      { apiKey: 'synthetic-key', model: 'synthetic-model' },
      { abortSignal: lifecycle.signal },
    )).rejects.toMatchObject({
      kind: 'cancelled',
      message: 'Speech transcription request was cancelled.',
      name: 'SpeechProviderCancelledError',
    })
  })
})
