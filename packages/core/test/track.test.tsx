import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cornerPin, planeAt, trackAt, usePlaneTrack, useTrack, type PlaneTrackValue, type TrackFile, type TrackValue } from '../src/index.js';
import { renderAt } from './scene-harness.js';

type XY = [number, number];

/** A square of half-width `h` around (x, y), turned `deg` degrees clockwise (y down). */
function quad(x: number, y: number, h: number, deg: number): [XY, XY, XY, XY] {
  const a = (deg * Math.PI) / 180;
  const at = (dx: number, dy: number): XY => [x + dx * Math.cos(a) - dy * Math.sin(a), y + dx * Math.sin(a) + dy * Math.cos(a)];
  return [at(-h, -h), at(h, -h), at(h, h), at(-h, h)];
}

function write(file: TrackFile): string {
  const path = join(mkdtempSync(join(tmpdir(), 'kt-track-')), 'clip.mp4.track.json');
  writeFileSync(path, JSON.stringify(file));
  return path;
}

// Frames 2..5 tracked; turning 100 degrees a frame (so the heading wraps past 180) and growing.
const file: TrackFile = {
  version: 1,
  clip: { width: 640, height: 360, fps: 30, frames: 10 },
  tracks: [
    {
      name: 'p1',
      model: 'locrotscale',
      frames: [2, 3, 4, 5].map((f) => ({
        frame: f,
        center: [100 + 10 * f, 50 + f] as XY,
        corners: quad(100 + 10 * f, 50 + f, 10 * (1 + (f - 2) * 0.5), 100 * (f - 2)),
        correlation: 0.9,
      })),
      lost: [6],
    },
    { name: 'p2', model: 'loc', frames: [{ frame: 0, center: [1, 2], corners: quad(1, 2, 5, 0), correlation: 1 }], lost: [] },
  ],
};

function read(path: string, frame: number, fps = 30, name?: string): TrackValue {
  let value!: TrackValue;
  function Probe() {
    value = useTrack(path, name);
    return null;
  }
  renderAt(<Probe />, frame, {
    config: { id: 'Main', width: 1280, height: 720, fps, durationInFrames: 90, defaultProps: {}, props: {} },
  });
  return value;
}

describe('useTrack', () => {
  const path = write(file);

  it('gives the marker of the current frame, with scale and unwrapped rotation against the first', () => {
    const v = read(path, 4);
    expect(v.x).toBe(140);
    expect(v.y).toBe(54);
    expect(v.tracked).toBe(true);
    expect(v.scale).toBeCloseTo(2, 6);
    expect(v.rotation).toBeCloseTo(200, 6);
    expect(read(path, 5).rotation).toBeCloseTo(300, 6);
    expect(read(path, 2)).toMatchObject({ scale: 1, rotation: 0, frame: 2 });
  });

  it('holds the first marker before the range and the last after it', () => {
    expect(read(path, 0)).toMatchObject({ x: 120, frame: 2, tracked: false });
    expect(read(path, 9)).toMatchObject({ x: 150, frame: 5, tracked: false });
  });

  it('maps the composition frame to the clip frame by time', () => {
    // At 60 fps, frame 9 is 0.15 s: clip frame 4 at 30 fps.
    expect(read(path, 9, 60).frame).toBe(4);
  });

  it('picks a track by name, and says which there are when the name is wrong', () => {
    expect(read(path, 3, 30, 'p2').x).toBe(1);
    expect(() => trackAt(path, 0, 'nope')).toThrow(/"p1", "p2"/);
  });

  it('is a pure function of the frame', () => {
    expect(trackAt(path, 3)).toEqual(trackAt(path, 3));
    expect(read(path, 3)).toEqual(trackAt(path, 3));
  });

  it('refuses a file that is not a track file', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'kt-track-')), 'x.json');
    writeFileSync(bad, '{"version": 2}');
    expect(() => trackAt(bad, 0)).toThrow(/version 1 track file/);
  });
});

describe('usePlaneTrack', () => {
  const corners = (f: number): [XY, XY, XY, XY] => [
    [10 + f, 20],
    [110 + f, 22],
    [108 + f, 90],
    [12 + f, 88],
  ];
  const withPlanes = write({
    ...file,
    planes: [
      { name: 'screen', tracks: ['p1', 'p2', 'p3', 'p4'], frames: [1, 2, 3, 4].map((f) => ({ frame: f, corners: corners(f) })) },
      { name: 'other', tracks: ['p1', 'p2', 'p3', 'p4'], frames: [{ frame: 0, corners: corners(0) }] },
    ],
  });

  function readPlane(path: string, frame: number, fps = 30, name?: string): PlaneTrackValue {
    let value!: PlaneTrackValue;
    function Probe() {
      value = usePlaneTrack(path, name);
      return null;
    }
    renderAt(<Probe />, frame, {
      config: { id: 'Main', width: 1280, height: 720, fps, durationInFrames: 90, defaultProps: {}, props: {} },
    });
    return value;
  }

  it('gives the corners of the current frame, and the pin cornerPin takes', () => {
    const v = readPlane(withPlanes, 3);
    expect(v).toMatchObject({ frame: 3, tracked: true, corners: corners(3) });
    expect(v.pin).toEqual({ topLeft: [13, 20], topRight: [113, 22], bottomRight: [111, 90], bottomLeft: [15, 88] });
    expect(cornerPin(v.pin)).toEqual({ type: 'cornerPin', ...v.pin });
  });

  it('holds the first corners before the plane and the last after it, and maps frames by time', () => {
    expect(readPlane(withPlanes, 0)).toMatchObject({ frame: 1, tracked: false });
    expect(readPlane(withPlanes, 20)).toMatchObject({ frame: 4, tracked: false, corners: corners(4) });
    // At 60 fps, frame 5 is clip frame 2.
    expect(readPlane(withPlanes, 5, 60).frame).toBe(2);
  });

  it('picks a plane by name and names the planes there are when it is wrong', () => {
    expect(readPlane(withPlanes, 2, 30, 'other').frame).toBe(0);
    expect(() => planeAt(withPlanes, 0, 'nope')).toThrow(/"screen", "other"/);
    expect(() => planeAt(path0(), 0)).toThrow(/no plane track/);
    expect(planeAt(withPlanes, 3)).toEqual(readPlane(withPlanes, 3));
  });
});

/** A track file without planes. */
function path0(): string {
  return write(file);
}
