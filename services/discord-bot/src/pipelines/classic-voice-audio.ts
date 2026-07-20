import type { Readable } from 'node:stream'

import type { AudioResource } from '@discordjs/voice'

import { PassThrough } from 'node:stream'

import { createAudioResource, demuxProbe, StreamType } from '@discordjs/voice'

/**
 * Provider and Discord Voice format pair for classic synthesized replies.
 *
 * OpenAI-compatible providers call their Ogg-contained Opus output `opus`,
 * while Discord Voice names the matching demux path `OggOpus`. Keeping both
 * values here prevents the request and playback boundaries from drifting.
 */
export const CLASSIC_DISCORD_VOICE_AUDIO_FORMAT = Object.freeze({
  playbackInputType: StreamType.OggOpus,
  providerResponseFormat: 'opus' as const,
})

/**
 * Sanitized failure for provider bytes that are not Discord-compatible Ogg Opus.
 *
 * Use when:
 * - Container probing or Ogg resource construction rejects synthesized audio.
 * - Callers need an observable category without provider bytes or parser details.
 *
 * Expects:
 * - The original parser/provider error is not copied into this error.
 *
 * Returns:
 * - A fixed name and message safe for structured lifecycle classification.
 */
export class DiscordVoiceAudioFormatError extends Error {
  constructor() {
    super('Classic Discord voice audio is not a supported Ogg Opus stream.')
    this.name = 'DiscordVoiceAudioFormatError'
  }
}

/**
 * Validates and prepares classic provider audio for direct Discord playback.
 *
 * Use when:
 * - An OpenAI-compatible speech response is about to enter classic Discord TTS playback.
 * - Provider bytes must be rejected rather than relabelled when their container is wrong.
 *
 * Expects:
 * - `input` is the complete finite response stream for one synthesized reply.
 * - The provider was requested with {@link CLASSIC_DISCORD_VOICE_AUDIO_FORMAT}.
 *
 * Returns:
 * - A resource whose Ogg demuxer emits Discord-ready Opus packets without FFmpeg.
 */
export async function createClassicDiscordVoiceAudioResource(input: Readable): Promise<AudioResource> {
  // Readable.from(Buffer) defaults to object mode. Discord's demux probe
  // correctly rejects object-mode streams, so normalize Buffer chunks without
  // changing their bytes before validating the provider container.
  const byteStream = input.readableObjectMode
    ? input.pipe(new PassThrough())
    : input
  let probedStream: Readable | undefined
  try {
    // xsAI returns only ArrayBuffer, without a trustworthy MIME/container
    // contract. Probe the actual bytes before selecting Discord's direct path.
    const probe = await demuxProbe(byteStream)
    probedStream = probe.stream
    if (probe.type !== CLASSIC_DISCORD_VOICE_AUDIO_FORMAT.playbackInputType)
      throw new DiscordVoiceAudioFormatError()

    return createAudioResource(probedStream, {
      inputType: CLASSIC_DISCORD_VOICE_AUDIO_FORMAT.playbackInputType,
    })
  }
  catch (error) {
    if (probedStream && !probedStream.destroyed)
      probedStream.destroy()
    if (byteStream !== probedStream && !byteStream.destroyed)
      byteStream.destroy()
    if (input !== byteStream && !input.destroyed)
      input.destroy()

    if (error instanceof DiscordVoiceAudioFormatError)
      throw error
    throw new DiscordVoiceAudioFormatError()
  }
}
