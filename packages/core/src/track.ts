// `useTrack(file, trackName?)`: a tracked point from a `.track.json` that `kinetograph track` wrote (Blender's tracker),
// at the current frame (packages/cli/skills/kinetograph/references/AUTHORING.md, "Motion tracking").
//
// A pure function of the file and the frame: composition frame f is the clip's frame floor(f * clip fps / fps), the
// picture a <Video> starting at frame 0 shows then; the value is that frame's marker, or the last one before it (a track
// holds its last position after it is lost and after its range), or the first one for a frame before the range.
// Coordinates are video pixels, y down, (0, 0) the frame's top-left corner.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { staticFile } from './assets.js';
import { useCurrentFrame, useVideoConfig } from './timeline.js';

export type TrackPointXY = [number, number];

export interface TrackFileFrame {
  frame: number;
  center: TrackPointXY;
  /** Top-left, top-right, bottom-right, bottom-left. */
  corners: [TrackPointXY, TrackPointXY, TrackPointXY, TrackPointXY];
  correlation: number;
}

export interface TrackFile {
  version: number;
  clip: { width: number; height: number; fps: number; frames: number };
  tracks: { name: string; model: string; frames: TrackFileFrame[]; lost: number[] }[];
}

export interface TrackValue {
  /** The tracked point, video pixels. */
  x: number;
  y: number;
  /** Size of the pattern quad against the first frame's (square root of the area ratio). */
  scale: number;
  /** Degrees clockwise the pattern has turned since the first frame, unwrapped (it can pass 180). */
  rotation: number;
  /** The pattern quad: top-left, top-right, bottom-right, bottom-left (a corner pin). */
  corners: [TrackPointXY, TrackPointXY, TrackPointXY, TrackPointXY];
  /** The clip frame whose marker this is. */
  frame: number;
  /** False when the value is held: the clip frame asked for has no marker of its own. */
  tracked: boolean;
}

interface Prepared {
  frames: TrackFileFrame[];
  scale: number[];
  rotation: number[];
}

interface Loaded {
  mtimeMs: number;
  size: number;
  file: TrackFile;
  tracks: Map<string, Prepared>;
}

const loaded = new Map<string, Loaded>();

const area = (q: TrackPointXY[]): number => {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i]!;
    const [bx, by] = q[(i + 1) % 4]!;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
};

/** The direction of the quad's horizontal edges (top and bottom together), in degrees, y down. */
const heading = ([tl, tr, br, bl]: TrackPointXY[]): number =>
  (Math.atan2(tr![1] - tl![1] + br![1] - bl![1], tr![0] - tl![0] + br![0] - bl![0]) * 180) / Math.PI;

function prepare(frames: TrackFileFrame[]): Prepared {
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  const scale: number[] = [];
  const rotation: number[] = [];
  const area0 = sorted.length ? area(sorted[0]!.corners) : 1;
  let turned = 0;
  let previous = sorted.length ? heading(sorted[0]!.corners) : 0;
  for (const f of sorted) {
    const h = heading(f.corners);
    let delta = h - previous;
    while (delta > 180) delta -= 360;
    while (delta <= -180) delta += 360;
    turned += delta;
    previous = h;
    rotation.push(turned);
    scale.push(area0 > 0 ? Math.sqrt(area(f.corners) / area0) : 1);
  }
  return { frames: sorted, scale, rotation };
}

/** The track file at `path` (a name in the public folder, or a path), read once and again when it changes on disk. */
export function readTrackFile(path: string): TrackFile {
  return load(path).file;
}

function load(name: string): Loaded {
  const path = isAbsolute(name) ? name : staticFile(name);
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new Error(`useTrack(): cannot read ${path}: ${error instanceof Error ? error.message : String(error)}. Make it with \`kinetograph track <video> --point x,y\`.`);
  }
  const have = loaded.get(path);
  if (have && have.mtimeMs === stats.mtimeMs && have.size === stats.size) return have;
  let file: TrackFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as TrackFile;
  } catch (error) {
    throw new Error(`useTrack(): ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (file?.version !== 1 || !Array.isArray(file.tracks) || typeof file.clip?.fps !== 'number') {
    throw new Error(`useTrack(): ${path} is not a version 1 track file (kinetograph track writes one)`);
  }
  const entry: Loaded = { mtimeMs: stats.mtimeMs, size: stats.size, file, tracks: new Map() };
  loaded.set(path, entry);
  return entry;
}

/**
 * The value of track `trackName` (default: the first) of the file at clip frame `clipFrame`; `useTrack` is this at the
 * current frame. Pure: the same file and frame give the same value.
 */
export function trackAt(file: string, clipFrame: number, trackName?: string): TrackValue {
  const entry = load(file);
  const track = trackName === undefined ? entry.file.tracks[0] : entry.file.tracks.find((t) => t.name === trackName);
  if (!track) {
    const names = entry.file.tracks.map((t) => JSON.stringify(t.name)).join(', ') || 'none';
    throw new Error(`useTrack(): ${file} has no track ${trackName === undefined ? '' : JSON.stringify(trackName) + ' '}(tracks: ${names})`);
  }
  let prepared = entry.tracks.get(track.name);
  if (!prepared) {
    prepared = prepare(track.frames);
    entry.tracks.set(track.name, prepared);
  }
  const { frames } = prepared;
  if (frames.length === 0) throw new Error(`useTrack(): track ${JSON.stringify(track.name)} of ${file} has no markers`);
  // The last marker at or before the frame, or the first.
  let lo = 0;
  let hi = frames.length - 1;
  if (clipFrame < frames[0]!.frame) hi = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.frame <= clipFrame) lo = mid;
    else hi = mid - 1;
  }
  const m = frames[lo]!;
  return {
    x: m.center[0],
    y: m.center[1],
    scale: prepared.scale[lo]!,
    rotation: prepared.rotation[lo]!,
    corners: m.corners,
    frame: m.frame,
    tracked: m.frame === clipFrame,
  };
}

/**
 * A tracked point at the current frame, from a `.track.json` (`kinetograph track`): `file` is a name in the public
 * folder (`clip.mp4.track.json`) or a path such as `staticFile(...)` gives. The clip is taken to start at frame 0 of the
 * sequence; a clip at another frame rate is mapped by time.
 */
export function useTrack(file: string, trackName?: string): TrackValue {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const clipFps = load(file).file.clip.fps;
  const clipFrame = Math.floor((frame * clipFps) / fps + 1e-9);
  return trackAt(file, clipFrame, trackName);
}
