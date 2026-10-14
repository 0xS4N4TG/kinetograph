import { describe, expect, it } from 'vitest';
import type { SceneJson } from '@kinetograph/scene';
import { lintAudio, lintInspect, lintScene, mergeFindings } from '../src/lint.js';
import type { InspectLayer, InspectResult } from '../src/native.js';

function layer(over: Partial<InspectLayer> & { id: string }): InspectLayer {
  return {
    type: 'shape',
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0, anchorY: 0, rotateX: 0, rotateY: 0, z: 0 },
    matrix: [1, 0, 0, 1, 0, 0],
    box: { x: 0, y: 0, width: 100, height: 50 },
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    effects: [],
    clip: null,
    mask: false,
    matte: null,
    matteSource: false,
    motionBlur: null,
    ...over,
  };
}

function text(id: string, at: { x: number; y: number }, w: number, over: Partial<InspectLayer['text']> = {}): InspectLayer {
  return layer({
    id,
    type: 'text',
    matrix: [1, 0, 0, 1, at.x, at.y],
    box: { x: 0, y: 0, width: w, height: 40 },
    bounds: { x: at.x, y: at.y, width: w, height: 40 },
    text: {
      text: 'hello', font: 'DM Sans', size: 32, width: w, height: 40, maxWidth: null,
      lines: [{ text: 'hello', top: 0, bottom: 40, baseline: 30 }], ...over,
    },
  });
}

const frame = (layers: InspectLayer[]): InspectResult => ({
  width: 1000, height: 600, fps: 30, durationInFrames: 90, frame: 0, margin: 0, camera: null, layers,
});

describe('lintInspect', () => {
  it('has nothing to say about text that fits', () => {
    expect(lintInspect(frame([text('t', { x: 100, y: 100 }, 200)]))).toEqual([]);
  });

  it('flags a line wider than the maxWidth it should wrap at', () => {
    const findings = lintInspect(frame([text('title', { x: 100, y: 100 }, 400, { maxWidth: 300 })]));
    expect(findings).toEqual([expect.objectContaining({ rule: 'text-overflow-box', severity: 'error', layer: 'title' })]);
  });

  it('flags text running past the canvas edge, with by how much and on which side', () => {
    const findings = lintInspect(frame([text('t', { x: 900, y: 100 }, 300)]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'text-overflow-canvas', layer: 't' });
    expect(findings[0]!.message).toContain('200 px past the right edge');
  });

  it('measures text through its matrix, not its bounds (effects widen bounds)', () => {
    const t = text('t', { x: 100, y: 100 }, 200);
    t.bounds = { x: -500, y: -500, width: 3000, height: 3000 };
    expect(lintInspect(frame([t]))).toEqual([]);
    const scaled = text('s', { x: 600, y: 100 }, 200);
    scaled.matrix = [2, 0, 0, 2, 600, 100]; // 400 px wide, ends at 1000
    scaled.transform.scale = 2;
    expect(lintInspect(frame([scaled]))).toEqual([]);
    scaled.matrix = [2.5, 0, 0, 2.5, 600, 100]; // ends at 1100
    expect(lintInspect(frame([scaled]))[0]).toMatchObject({ rule: 'text-overflow-canvas' });
  });

  it('warns about a layer completely off the canvas, but not a partly visible one, a hidden one or a matte source', () => {
    const at = (x: number) => ({ matrix: [1, 0, 0, 1, x, 0] as InspectLayer['matrix'], bounds: { x, y: 0, width: 100, height: 50 } });
    const off = layer({ id: 'off', ...at(2000) });
    const partly = layer({ id: 'partly', ...at(950) });
    const hidden = layer({ id: 'hidden', opacity: 0, ...at(2000) });
    const source = layer({ id: 'src', matteSource: true, ...at(2000) });
    const findings = lintInspect(frame([off, partly, hidden, source]));
    expect(findings).toEqual([expect.objectContaining({ rule: 'off-canvas', severity: 'warning', layer: 'off' })]);
  });

  it('judges off-canvas by where the renderer puts a layer, not its flat matrix', () => {
    // Inside a group turned in 3D: the flat matrix is off the canvas, the bounds (after the turn) are on it.
    const turned = layer({ id: 'turned', matrix: [1, 0, 0, 1, -400, 0], bounds: { x: 20, y: 0, width: 30, height: 50 } });
    expect(lintInspect(frame([turned]))).toEqual([]);
    const gone = layer({ id: 'gone', bounds: { x: -400, y: 0, width: 100, height: 50 } });
    expect(lintInspect(frame([gone]))).toEqual([expect.objectContaining({ rule: 'off-canvas', layer: 'gone' })]);
  });

  it('looks inside groups, using canvas matrices', () => {
    const group = layer({ id: 'g', type: 'group', box: null, bounds: null, children: [text('inner', { x: 900, y: 10 }, 300)] });
    expect(lintInspect(frame([group]))[0]).toMatchObject({ rule: 'text-overflow-canvas', layer: 'inner' });
  });

  it('warns about overlapping text', () => {
    const findings = lintInspect(frame([text('a', { x: 100, y: 100 }, 200), text('b', { x: 150, y: 110 }, 200)]));
    expect(findings).toEqual([expect.objectContaining({ rule: 'text-overlap', layer: 'a' })]);
    expect(findings[0]!.message).toContain('"b"');
    expect(lintInspect(frame([text('a', { x: 100, y: 100 }, 200), text('b', { x: 100, y: 300 }, 200)]))).toEqual([]);
  });
});

describe('lintScene', () => {
  const scene = (over: Partial<SceneJson> = {}): SceneJson => ({
    width: 100, height: 100, fps: 30, durationInFrames: 1,
    fonts: { 'DM Sans': 'fonts/dm.ttf' },
    layers: [
      { id: 'a', type: 'text', text: 'x', font: 'Inter', size: 20 },
      { id: 'g', type: 'group', children: [{ id: 'img', type: 'image', src: 'missing.png' }] },
      { id: 'ok', type: 'image', src: 'there.png', effects: [{ type: 'lut', src: 'look.cube' } as never] },
    ],
    ...over,
  });
  const exists = (present: string[]) => (path: string) => present.some((p) => path.endsWith(p));

  it('finds an unregistered font, a missing font file and missing images and luts', () => {
    const findings = lintScene(scene(), '/proj', exists(['there.png']));
    expect(findings.map((f) => [f.rule, f.layer])).toEqual([
      ['missing-font', null],
      ['missing-font', 'a'],
      ['missing-asset', 'img'],
      ['missing-asset', 'ok'],
    ]);
    expect(findings[1]!.message).toContain('"Inter"');
    expect(findings[3]!.message).toContain('look.cube');
  });

  it('is quiet when everything is there', () => {
    const ok = scene({ layers: [{ id: 'a', type: 'text', text: 'x', font: 'DM Sans', size: 20 }] });
    expect(lintScene(ok, '/proj', () => true)).toEqual([]);
  });
});

describe('lintAudio and mergeFindings', () => {
  it('names a missing audio file by its clip id', () => {
    const clip = { id: 'music', src: 'a.mp3', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false };
    expect(lintAudio([clip], '/p', () => false)).toEqual([
      expect.objectContaining({ rule: 'missing-asset', layer: 'music' }),
    ]);
    expect(lintAudio([clip], '/p', () => true)).toEqual([]);
  });

  it('merges a finding seen at several frames into one issue and puts errors first', () => {
    const warn = { rule: 'off-canvas', severity: 'warning' as const, layer: 'a', message: 'm' };
    const err = { rule: 'missing-font', severity: 'error' as const, layer: null, message: 'f' };
    const issues = mergeFindings([
      { frame: 0, findings: [warn] },
      { frame: 30, findings: [warn, err] },
      { frame: 60, findings: [warn] },
    ]);
    expect(issues.map((i) => [i.rule, i.frames])).toEqual([
      ['missing-font', [30]],
      ['off-canvas', [0, 30, 60]],
    ]);
  });
});
