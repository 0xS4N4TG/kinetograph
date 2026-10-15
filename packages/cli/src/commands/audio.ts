import { analyzeAudio, hasOnFrame, joinClips, renderAudio } from '@kinetograph/audio';
import type { AudioClipJson } from '@kinetograph/scene';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { frameRange } from '../source.js';
import { ENTRY, openFromArgs, type Command } from './types.js';

const fmt = (n: number, unit: string): string => (Number.isFinite(n) ? `${n.toFixed(1)} ${unit}` : `-inf ${unit}`);

export const audioAnalyze: Command = {
  name: 'audio analyze',
  summary: 'Loudness (LUFS), true peak, clipping and silences of the mixed audio',
  project: true,
  positionals: [ENTRY],
  options: [
    { name: 'range', type: 'string', description: 'Frames to mix and measure, as 10..40; default all' },
    { name: 'scenes', type: 'string', description: 'Also measure frame ranges on their own: 0..90,90..180' },
  ],
  async run(args) {
    const source = await openFromArgs(args);
    try {
      const { fps, durationInFrames } = source.composition;
      const [first, last] = frameRange(args.options.range as string | undefined, durationInFrames);

      // The <Audio> clips live in the frames' trees, so every frame of the range is rendered by the project (in JS
      // only; no pixels).
      const frames: { frame: number; audio: AudioClipJson[] }[] = [];
      for (let frame = first; frame <= last; frame++) frames.push({ frame, audio: (await source.frame(frame)).audio });
      const clips = joinClips(frames);
      if (clips.length === 0 && !hasOnFrame(first, last)) {
        throw new CliError('NO_AUDIO', `frames ${first}..=${last} have no onFrame callbacks and no <Audio> clips`);
      }
      const pcm = await renderAudio({ fps, first, last, clips, baseDir: source.baseDir });

      // Scene ranges are frames; the analysis takes seconds from the start of the mix.
      let scenes: [number, number][] | undefined;
      if (typeof args.options.scenes === 'string') {
        scenes = args.options.scenes.split(',').map((piece) => {
          const [a, b] = native().parseRange(piece.trim(), durationInFrames);
          return [(a! - first) / fps, (b! + 1 - first) / fps];
        });
      }
      const analysis = analyzeAudio(pcm, { scenes });
      const durationSeconds = (last - first + 1) / fps;
      const lines = [
        `${source.composition.id}: frames ${first}..=${last} (${durationSeconds.toFixed(2)} s), ${clips.length} clip(s)`,
        `integrated loudness ${fmt(analysis.integratedLufs, 'LUFS')}`,
        `true peak ${fmt(analysis.truePeakDb, 'dBTP')}`,
        `clipped samples ${analysis.clippedSamples}`,
        analysis.silences.length
          ? `silences: ${analysis.silences.map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)} s`).join(', ')}`
          : 'no silences of 0.5 s or more below -60 dBFS',
        ...(analysis.scenes ?? []).map(
          (s) => `  ${s.from.toFixed(2)}-${s.to.toFixed(2)} s: ${fmt(s.integratedLufs, 'LUFS')}, ${fmt(s.truePeakDb, 'dBTP')}`,
        ),
      ];
      return {
        data: { entry: source.entry, first, last, durationSeconds, sampleRate: pcm.sampleRate, clips: clips.length, ...analysis },
        text: lines.join('\n'),
      };
    } finally {
      source.dispose();
    }
  },
};
