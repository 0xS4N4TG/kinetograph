// `kinetograph track <video> --point x,y`: tracks points through a video with Blender's tracker (libmv, in the addon)
// and writes `<video>.track.json`, which `useTrack()` reads (packages/cli/skills/kinetograph/references/AUTHORING.md,
// "Motion tracking"). `--detect` places points with Blender's Detect Features first; `--plane` makes plane tracks
// from the tracked points, which `usePlaneTrack()` reads. Precomputed: a render never tracks.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { whole } from '../args.js';
import { CliError } from '../errors.js';
import { native } from '../native.js';
import { OUTPUT_OPTION, type Command } from './types.js';

interface TrackFileJson {
  clip: { width: number; height: number; fps: number; frames: number };
  tracks: { name: string; model: string; frames: { frame: number; center: [number, number] }[]; lost: number[] }[];
  planes?: { name: string; tracks: string[]; frames: { frame: number }[] }[];
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

/** `"name=rest"` or `"rest"`. */
function splitName(text: string): { name?: string; rest: string } {
  const i = text.indexOf('=');
  return i === -1 ? { rest: text } : { name: text.slice(0, i).trim(), rest: text.slice(i + 1) };
}

/** A comma-separated list of numbers, `count` of them (or an even number, at least 6, for a polygon). */
function parseNumbers(flag: string, text: string, count?: number): number[] {
  const values = text.split(',').map((v) => Number(v.trim()));
  const ok = values.every(Number.isFinite) && (count === undefined ? values.length >= 6 && values.length % 2 === 0 : values.length === count);
  if (!ok) {
    const want = count === undefined ? 'x,y pairs, at least three' : `${count} numbers`;
    throw new CliError('INVALID_ARG', `${flag} takes ${want} in video pixels, got "${text}"`);
  }
  return values;
}

/** `--plane [name=]all|p1,p2,...` as a plane request. */
function parsePlane(text: string, index: number): { name: string; tracks?: string[] } {
  const { name, rest } = splitName(text);
  const list = rest.split(',').map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) throw new CliError('INVALID_ARG', `--plane takes all or track names (p1,p2,p3,p4), got "${text}"`);
  return { name: name || `plane${index + 1}`, ...(list.length === 1 && list[0] === 'all' ? {} : { tracks: list }) };
}

const optionalWhole = (what: string, value: unknown, min: number): number | undefined =>
  value === undefined ? undefined : whole(what, value as number, min);

const list = (value: unknown): string[] => (value as string[] | undefined) ?? [];

export const track: Command = {
  name: 'track',
  summary: "Track points (placed, or found by Detect Features) and plane tracks through a video with Blender's tracker; writes <video>.track.json",
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
    { name: 'detect', type: 'boolean', description: "Place more points with Blender's Detect Features (Harris corners) on the first frame tracked, named on from the --point ones" },
    { name: 'detect-margin', type: 'number', description: 'Px from the frame edge where nothing is detected (default 16, as Blender)' },
    { name: 'detect-threshold', type: 'number', description: 'Harris threshold, Blender units; lower finds more (default 0.5)' },
    { name: 'detect-distance', type: 'number', description: 'Px between detected points, at least (default 120)' },
    { name: 'detect-inside', type: 'string', multiple: true, description: 'Keep only features inside this polygon, x,y,x,y,... in video pixels (Blender: inside the annotation). Repeat for more' },
    { name: 'detect-outside', type: 'string', multiple: true, description: 'Keep only features outside this polygon (Blender: outside the annotation). Repeat for more' },
    {
      name: 'plane',
      type: 'string',
      multiple: true,
      description: 'A plane track from 4+ point tracks: all, or names p1,p2,p3,p4; name=... names it (default plane1, plane2, ...). Repeat for more',
    },
    {
      name: 'plane-corners',
      type: 'string',
      multiple: true,
      description: "A plane's corners on the first frame tracked, x,y of top-left, top-right, bottom-right, bottom-left (8 numbers); name=... picks the plane (default the first). Default: the box around its tracks' patterns, as Blender",
    },
    { ...OUTPUT_OPTION, description: 'Output file (default <video>.track.json)' },
  ],
  async run(args, context) {
    const video = resolve(String(args.positionals.video));
    const points = list(args.options.point).map(parsePoint);
    const detecting = args.options.detect === true;
    if (points.length === 0 && !detecting) throw new CliError('INVALID_ARG', 'give at least one --point x,y, or --detect');
    const output = resolve((args.options.output as string | undefined) ?? `${video}.track.json`);
    const pattern = optionalWhole('--pattern', args.options.pattern, 5);
    const search = optionalWhole('--search', args.options.search, 5);
    const margin = optionalWhole('--margin', args.options.margin, 0);
    const from = optionalWhole('--from', args.options.from, 0);
    const to = optionalWhole('--to', args.options.to, 0);
    const minCorrelation = args.options['min-correlation'] as number | undefined;

    const inside = list(args.options['detect-inside']).map((t) => parseNumbers('--detect-inside', t));
    const outside = list(args.options['detect-outside']).map((t) => parseNumbers('--detect-outside', t));
    const detectFlags = ['detect-margin', 'detect-threshold', 'detect-distance'].filter((f) => args.options[f] !== undefined);
    if (!detecting && (detectFlags.length || inside.length || outside.length)) {
      throw new CliError('INVALID_ARG', `--${detectFlags[0] ?? (inside.length ? 'detect-inside' : 'detect-outside')} needs --detect`);
    }
    if (inside.length && outside.length) {
      throw new CliError('INVALID_ARG', '--detect-inside and --detect-outside cannot be used together (Blender has one placement)');
    }
    const threshold = args.options['detect-threshold'] as number | undefined;
    if (threshold !== undefined && !(threshold >= 0)) throw new CliError('INVALID_ARG', `--detect-threshold must be 0 or more, got ${threshold}`);
    const detect = detecting
      ? {
          margin: optionalWhole('--detect-margin', args.options['detect-margin'], 0),
          threshold,
          minDistance: optionalWhole('--detect-distance', args.options['detect-distance'], 0),
          ...(inside.length ? { inside } : {}),
          ...(outside.length ? { outside } : {}),
        }
      : undefined;

    const planes: { name: string; tracks?: string[]; corners?: number[] }[] = list(args.options.plane).map(parsePlane);
    for (const text of list(args.options['plane-corners'])) {
      const { name, rest } = splitName(text);
      const plane = name ? planes.find((p) => p.name === name) : planes[0];
      if (!plane) throw new CliError('INVALID_ARG', `--plane-corners ${name ? `names no --plane "${name}"` : 'needs a --plane'}`);
      plane.corners = parseNumbers('--plane-corners', rest, 8);
    }

    context.progress(`tracking ${points.length} point(s)${detecting ? ' and detected features' : ''} through ${video}`);
    let text: string;
    try {
      text = native().track(
        video,
        {
          points,
          detect,
          planes: planes.length ? planes : undefined,
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
    const planeSummary = (file.planes ?? []).map((p) => ({
      name: p.name,
      tracks: p.tracks,
      first: p.frames[0]?.frame ?? null,
      last: p.frames.at(-1)?.frame ?? null,
      frames: p.frames.length,
    }));
    const detected = detecting ? file.tracks.length - points.length : undefined;
    const lines = [
      `wrote ${output} (${file.clip.width}x${file.clip.height}, ${file.clip.fps} fps, ${file.clip.frames} frames)`,
      ...(detected !== undefined ? [`  Detect Features placed ${detected} point(s)`] : []),
      ...tracks
        .slice(0, 20)
        .map(
          (t) => `  ${t.name} (${t.model}): frames ${t.first}..${t.last}, ${t.frames} tracked${t.lost.length ? `, lost at frame ${t.lost.join(', ')}` : ''}`,
        ),
      ...(tracks.length > 20 ? [`  ... and ${tracks.length - 20} more tracks (all in the file)`] : []),
      ...planeSummary.map((p) => `  plane ${p.name} (${p.tracks.length} tracks): frames ${p.first}..${p.last}`),
    ];
    return {
      data: { output, clip: file.clip, tracks, ...(detected !== undefined ? { detected } : {}), ...(planeSummary.length ? { planes: planeSummary } : {}) },
      text: lines.join('\n'),
    };
  },
};
