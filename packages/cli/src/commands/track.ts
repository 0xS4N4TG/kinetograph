// `kinetograph track <video> --point x,y`: tracks points through a video with Blender's tracker (libmv, in the addon)
// and writes `<video>.track.json`, which `useTrack()` reads (packages/cli/skills/kinetograph/references/AUTHORING.md,
// "Motion tracking"). Precomputed: a render never tracks.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { whole } from '../args.js';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { OUTPUT_OPTION, type Command } from './types.js';

interface TrackFileJson {
  clip: { width: number; height: number; fps: number; frames: number };
  tracks: { name: string; model: string; frames: { frame: number; center: [number, number] }[]; lost: number[] }[];
}

/** `"120,80"` or `"name=120,80"` as a point. */
function parsePoint(text: string): { name?: string; x: number; y: number } {
  const m = /^(?:([^=]+)=)?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(text);
  const x = Number(m?.[2]);
  const y = Number(m?.[3]);
  if (!m || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CliError('INVALID_ARG', `--point takes x,y in video pixels (or name=x,y), got "${text}"`);
  }
  return { ...(m[1] ? { name: m[1].trim() } : {}), x, y };
}

const optionalWhole = (what: string, value: unknown, min: number): number | undefined =>
  value === undefined ? undefined : whole(what, value as number, min);

export const track: Command = {
  name: 'track',
  summary: "Track points through a video with Blender's tracker; writes <video>.track.json for useTrack()",
  project: false,
  positionals: [{ name: 'video', description: 'The video file to track' }],
  options: [
    {
      name: 'point',
      type: 'string',
      multiple: true,
      description: 'A point to track, x,y in video pixels of the first frame tracked (y down, 0,0 the top-left corner); name=x,y names it. Repeat for more',
    },
    { name: 'model', type: 'string', description: 'Motion model: loc (default), locrot, locscale, locrotscale, affine, perspective' },
    { name: 'pattern', type: 'number', description: 'Pattern size in px (default 21, as Blender)' },
    { name: 'search', type: 'number', description: 'Search area size in px (default 71, as Blender)' },
    { name: 'match', type: 'string', description: 'Match against the keyframe (default, as Blender) or the previous frame: keyframe | previous' },
    { name: 'min-correlation', type: 'number', description: 'A match below this ends the track (default 0.75)' },
    { name: 'margin', type: 'number', description: 'Px the pattern keeps from the frame edge (default 0)' },
    { name: 'from', type: 'number', description: 'First frame (default 0)' },
    { name: 'to', type: 'number', description: 'Last frame (default the last of the clip)' },
    { name: 'backwards', type: 'boolean', description: 'Place the points at --to and track back to --from' },
    { ...OUTPUT_OPTION, description: 'Output file (default <video>.track.json)' },
  ],
  async run(args, context) {
    const video = resolve(String(args.positionals.video));
    const points = ((args.options.point as string[] | undefined) ?? []).map(parsePoint);
    if (points.length === 0) throw new CliError('INVALID_ARG', 'give at least one --point x,y');
    const output = resolve((args.options.output as string | undefined) ?? `${video}.track.json`);
    const pattern = optionalWhole('--pattern', args.options.pattern, 5);
    const search = optionalWhole('--search', args.options.search, 5);
    const margin = optionalWhole('--margin', args.options.margin, 0);
    const from = optionalWhole('--from', args.options.from, 0);
    const to = optionalWhole('--to', args.options.to, 0);
    const minCorrelation = args.options['min-correlation'] as number | undefined;
    context.progress(`tracking ${points.length} point(s) through ${video}`);
    let text: string;
    try {
      text = native().track(
        video,
        {
          points,
          model: args.options.model as string | undefined,
          pattern,
          search,
          minCorrelation,
          margin,
          match: args.options.match as string | undefined,
          from,
          to,
          backwards: args.options.backwards === true,
        },
        undefined,
      );
    } catch (error) {
      const code = (error as { code?: string }).code === 'IO' ? 'IO' : 'INVALID_ARG';
      throw new CliError(code, error instanceof Error ? error.message : String(error));
    }
    writeFileSync(output, `${text}\n`);
    const file = JSON.parse(text) as TrackFileJson;
    const tracks = file.tracks.map((t) => ({
      name: t.name,
      model: t.model,
      first: t.frames[0]?.frame ?? null,
      last: t.frames.at(-1)?.frame ?? null,
      frames: t.frames.length,
      lost: t.lost,
    }));
    const lines = [
      `wrote ${output} (${file.clip.width}x${file.clip.height}, ${file.clip.fps} fps, ${file.clip.frames} frames)`,
      ...tracks.map(
        (t) => `  ${t.name} (${t.model}): frames ${t.first}..${t.last}, ${t.frames} tracked${t.lost.length ? `, lost at frame ${t.lost.join(', ')}` : ''}`,
      ),
    ];
    return { data: { output, clip: file.clip, tracks }, text: lines.join('\n') };
  },
};
