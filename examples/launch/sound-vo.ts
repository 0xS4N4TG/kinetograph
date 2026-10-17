// Seconds of each voiceover line (public/vo/<file>.wav): the Tiny Agent narrator, a Qwen3-TTS clone. The whole script
// is ONE take (tools/narration/take.json, take full_2), cut into these lines in the middle of its own pauses by
// lib/voice/split_take.py, so the pieces butt back together into exactly that take.
export const VO_SECONDS: Record<string, number> = {
  '02-question': 2.032,
  '03-screenshot': 2.41,
  '04-you-dont': 1.41,
  '05-render': 1.78,
  '07a-your': 1.64,
  '07b-write': 1.57,
  '07c-past': 1.37,
  'm1-3d': 0.77,
  'm2-iso': 0.9,
  'm3-webgl': 0.94,
  'm4-canvas': 0.51,
  'm5-glass': 1.54,
  '08-remotion': 6.53,
  '09-numbers': 3.06,
  '10-pixels': 2.09,
  '12-end': 3.436,
};
