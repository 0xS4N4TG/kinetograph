// `toneFrequency` (packages/cli/skills/kinetograph/references/AUTHORING.md §6.4): the pitch of a clip times `ratio`, its length unchanged. The sound is
// first stretched to `ratio` times its length without changing its pitch (WSOLA: overlapping windows taken from the
// input at the stretched pace, each one nudged to where it lines up best with the last), then read back `ratio` times
// as fast, which brings the length back and moves the pitch. Every channel uses the same window positions (found on
// their average), so stereo stays aligned. Pure arithmetic on the samples: the same input always gives the same output.

/** The window: about 21 ms at 48 kHz, long enough to hold a period of most voices and instruments. */
const WINDOW = 1024;
const HOP = WINDOW / 2;
/** How far, in samples, a window may move from its nominal place to line up with the last one. */
const TOLERANCE = 256;
/** The search compares every `STRIDE`th sample, which is plenty to find the best lag and four times cheaper. */
const STRIDE = 4;

/** Periodic Hann: windows `HOP` apart add up to exactly 1. */
const HANN = Float32Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW));

function mono(channels: Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0]!.length);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i]! += channel[i]! / channels.length;
  return out;
}

/** WSOLA: each channel stretched to `stretch` times its length, pitch kept. */
function timeStretch(channels: Float32Array[], stretch: number): Float32Array[] {
  const length = channels[0]!.length;
  const outLength = Math.round(length * stretch);
  const guide = mono(channels);
  const out = channels.map(() => new Float32Array(outLength + WINDOW));
  const analysisHop = HOP / stretch;
  let previous = 0;
  for (let k = 0; k * HOP < outLength; k++) {
    const nominal = Math.round(k * analysisHop);
    let position = nominal;
    if (k > 0) {
      // Where the last window would have gone on had it been longer: the next window should look like that.
      const natural = previous + HOP;
      let best = Number.NEGATIVE_INFINITY;
      const lo = Math.max(0, nominal - TOLERANCE);
      const hi = Math.min(length - WINDOW, nominal + TOLERANCE);
      for (let candidate = lo; candidate <= hi; candidate++) {
        let score = 0;
        for (let i = 0; i < HOP; i += STRIDE) {
          const a = natural + i;
          const b = candidate + i;
          if (a < length && b < length) score += guide[a]! * guide[b]!;
        }
        if (score > best) {
          best = score;
          position = candidate;
        }
      }
      if (hi < lo) position = Math.max(0, Math.min(nominal, length - 1));
    }
    const at = k * HOP;
    for (let c = 0; c < channels.length; c++) {
      const input = channels[c]!;
      const output = out[c]!;
      for (let i = 0; i < WINDOW; i++) {
        const from = position + i;
        if (from < length) output[at + i]! += input[from]! * HANN[i]!;
      }
    }
    previous = position;
  }
  // The first half window has only one window over it; the overlap-add gain there is the Hann's rise, not 1.
  return out.map((channel) => {
    const trimmed = channel.subarray(0, outLength);
    for (let i = 0; i < Math.min(HOP, outLength); i++) trimmed[i] = HANN[i]! > 1e-3 ? trimmed[i]! / HANN[i]! : trimmed[i]!;
    return trimmed;
  });
}

/** `input` read `speed` times as fast into `length` samples, by linear interpolation. */
function resample(input: Float32Array, speed: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const at = i * speed;
    const j = Math.floor(at);
    if (j + 1 >= input.length) {
      out[i] = j < input.length ? input[j]! : 0;
      continue;
    }
    const t = at - j;
    out[i] = input[j]! * (1 - t) + input[j + 1]! * t;
  }
  return out;
}

/**
 * The channels with their pitch multiplied by `ratio` (Remotion's `toneFrequency`, 0.01 to 2) and the same length.
 * `ratio` 1 returns the input.
 */
export function shiftPitch(channels: Float32Array[], ratio: number): Float32Array[] {
  if (!(ratio >= 0.01 && ratio <= 2)) throw new RangeError(`toneFrequency must be between 0.01 and 2, got ${ratio}`);
  if (ratio === 1 || channels.length === 0 || channels[0]!.length < WINDOW) return channels;
  const length = channels[0]!.length;
  return timeStretch(channels, ratio).map((stretched) => resample(stretched, ratio, length));
}
