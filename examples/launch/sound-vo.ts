// Seconds of each voiceover line (public/vo/<file>.wav): the Tiny Agent narrator, a Qwen3-TTS clone, made by
// tools/narration (script.json, then lib/voice/narrate.sh and finalize.sh); 07 is split into 07a and 07b.
export const VO_SECONDS: Record<string, number> = {
  '02-question': 1.765,
  '03-screenshot': 2.031,
  '04-you-dont': 1.218,
  '05-render': 1.697,
  '07a-your': 1.4,
  '07b-write': 1.663,
  '08-remotion': 6.061,
  '09-numbers': 2.213,
  '10-pixels': 1.783,
  '12-end': 3.486,
};
