// The AAC `AudioSpecificConfig` of `MediaParserInternals.createAacCodecPrivate`.

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * The two bytes that configure an AAC decoder: the audio object type (5 bits), the sampling frequency's index in the
 * standard's table (4), the channel configuration (4) and three bits of padding. A `codecPrivate` of more than two
 * bytes is already a config and is returned as it is.
 */
export function createAacCodecPrivate({
  audioObjectType,
  sampleRate,
  channelConfiguration,
  codecPrivate,
}: {
  audioObjectType: number;
  sampleRate: number;
  channelConfiguration: number;
  codecPrivate: Uint8Array | null;
}): Uint8Array {
  if (codecPrivate !== null && codecPrivate.length > 2) return codecPrivate;
  const index = SAMPLE_RATES.indexOf(sampleRate);
  if (index < 0) throw new Error(`Unexpected sample rate ${sampleRate}`);
  if (channelConfiguration === 0 || channelConfiguration > 7) {
    throw new Error(`Invalid channel configuration ${channelConfiguration}`);
  }
  const bits = (audioObjectType << 11) | (index << 7) | (channelConfiguration << 3);
  return new Uint8Array([(bits >> 8) & 0xff, bits & 0xff]);
}
