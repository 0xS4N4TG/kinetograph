// Seconds of each voiceover line (public/vo/<file>.wav): the Tiny Agent narrator, a Qwen3-TTS clone. The whole script
// is ONE take (tools/narration/take.json, take full_0 of voice/takes/onetake-v2), cut into these lines in the middle of
// its own pauses by lib/voice/split_take.py, so the pieces butt back together into exactly that take.
export const VO_SECONDS: Record<string, number> = {
  '02-1891': 2.551,
  '03-today': 2.78,
  '04-you-dont': 1.23,
  '05-render': 1.76,
  '07a-your': 1.85,
  '07b-write': 1.31,
  '07c-text': 0.72,
  'm1-3d': 0.69,
  'm2-iso': 1.09,
  'm3-shaders': 0.6,
  'm4-canvas': 0.4,
  'm5-glass': 1.19,
  '08-remotion': 2.29,
  '09-film': 1.837,
  '10-pixels': 2.01,
  '12-end': 3.451,
};
