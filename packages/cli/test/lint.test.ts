import { describe, expect, it } from 'vitest';
import type { SceneJson, Unsupported } from '@kinetographdev/scene';
import { lintAudio, lintCompat, lintInspect, lintNotes, lintScene, mergeFindings, sortIssues, textInsideCanvas } from '../src/lint.js';
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
    clipBounds: null,
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
      text: id, font: 'DM Sans', size: 32, width: w, height: 40, maxWidth: null,
      lines: [{ text: id, top: 0, bottom: 40, baseline: 30 }], ...over,
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

  describe('layers that cannot be seen', () => {
    const past = (over: Partial<InspectLayer> = {}) => ({ ...text('toast', { x: 900, y: 100 }, 300), ...over });
    const inGroup = (group: Partial<InspectLayer>, ...children: InspectLayer[]) =>
      layer({ id: 'g', type: 'group', box: null, bounds: null, children, ...group });
    const rectOf = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

    it('reports text past the edge at opacity 1, and not at opacity 0', () => {
      expect(lintInspect(frame([past()]))).toEqual([expect.objectContaining({ rule: 'text-overflow-canvas', layer: 'toast' })]);
      expect(lintInspect(frame([past({ opacity: 0 })]))).toEqual([]);
    });

    it('skips a layer inside a group at opacity 0, and reports it inside one at opacity 1', () => {
      expect(lintInspect(frame([inGroup({ opacity: 0 }, past())]))).toEqual([]);
      expect(lintInspect(frame([inGroup({ opacity: 1 }, past())]))).toEqual([
        expect.objectContaining({ rule: 'text-overflow-canvas', layer: 'toast' }),
      ]);
    });

    it('skips a layer under any hidden ancestor, however deep', () => {
      const deep = inGroup({ id: 'outer', opacity: 0.5 }, inGroup({ id: 'hidden', opacity: 0 }, inGroup({ id: 'inner' }, past())));
      expect(lintInspect(frame([deep]))).toEqual([]);
    });

    it('skips the warnings of a layer that is off the canvas at opacity 0', () => {
      const off = layer({ id: 'off', matrix: [1, 0, 0, 1, 2000, 0], bounds: rectOf(2000, 0, 100, 50) });
      expect(lintInspect(frame([inGroup({ opacity: 0 }, off)]))).toEqual([]);
      expect(lintInspect(frame([inGroup({ opacity: 1 }, off)]))).toEqual([expect.objectContaining({ rule: 'off-canvas', layer: 'off' })]);
    });

    it('skips an overlap when either text is hidden, also through its group', () => {
      const a = text('a', { x: 100, y: 100 }, 200);
      const b = text('b', { x: 150, y: 110 }, 200);
      expect(lintInspect(frame([a, { ...b, opacity: 0 }]))).toEqual([]);
      expect(lintInspect(frame([a, inGroup({ id: 'g2', opacity: 0 }, b)]))).toEqual([]);
      expect(lintInspect(frame([a, inGroup({ id: 'g2', opacity: 1 }, b)]))).toHaveLength(1);
    });

    it('skips a layer that its own clip or an ancestor clip cuts away completely', () => {
      const off = (id: string) => layer({ id, matrix: [1, 0, 0, 1, 2000, 0], bounds: rectOf(2000, 0, 100, 50) });
      // Clip keeps a box that does not reach the layer, or keeps nothing (zero area).
      expect(lintInspect(frame([inGroup({ clip: 'inset', clipBounds: rectOf(0, 0, 500, 500) }, off('a'))]))).toEqual([]);
      expect(lintInspect(frame([{ ...off('b'), clip: 'ellipse', clipBounds: rectOf(2050, 25, 0, 0) }]))).toEqual([]);
      // Clips nest: the inner clip is inside the layer's reach but the outer one is not.
      const nested = inGroup({ clip: 'polygon', clipBounds: rectOf(0, 0, 500, 500) },
        inGroup({ id: 'g2', clip: 'inset', clipBounds: rectOf(1900, 0, 400, 100) }, off('c')));
      expect(lintInspect(frame([nested]))).toEqual([]);
    });

    it('still reports a layer that a clip only partly cuts, or that sits inside the clip', () => {
      const clipped = (clipBounds: InspectLayer['clipBounds']) =>
        inGroup({ clip: 'inset', clipBounds }, past({ bounds: rectOf(900, 100, 300, 40) }));
      // Cut at the canvas edge, nothing of the text is drawn past it; cut to a box beyond the edge, none of it is on the canvas.
      expect(lintInspect(frame([clipped(rectOf(0, 0, 1000, 600))]))).toEqual([]);
      expect(lintInspect(frame([clipped(rectOf(1100, 100, 100, 40))]))).toEqual([expect.objectContaining({ rule: 'off-canvas' })]);
      expect(lintInspect(frame([clipped(rectOf(0, 0, 1200, 600))]))).toEqual([expect.objectContaining({ rule: 'text-overflow-canvas' })]);
      expect(lintInspect(frame([clipped(rectOf(0, 0, 800, 600))]))).toEqual([]);
    });
  });
});

describe('lint false positives', () => {
  const rectOf = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const inGroup = (group: Partial<InspectLayer>, ...children: InspectLayer[]) =>
    layer({ id: 'g', type: 'group', box: null, bounds: null, children, ...group });

  it('does not report text that a box around it clips to the canvas (a ticker, a scroller)', () => {
    const wide = text('ticker', { x: 100, y: 100 }, 3000);
    expect(lintInspect(frame([inGroup({ clip: 'inset', clipBounds: rectOf(0, 0, 1000, 600) }, wide)]))).toEqual([]);
    // Clipped to a box that itself runs past the canvas: what is drawn still does.
    expect(lintInspect(frame([inGroup({ clip: 'inset', clipBounds: rectOf(0, 0, 1200, 600) }, wide)]))).toEqual([
      expect.objectContaining({ rule: 'text-overflow-canvas', layer: 'ticker' }),
    ]);
  });

  it('does not report text that fades in or out over other text, blended, or the same words twice', () => {
    const a = text('a', { x: 100, y: 100 }, 200);
    const b = text('b', { x: 150, y: 110 }, 200);
    expect(lintInspect(frame([a, b]))).toHaveLength(1);
    expect(lintInspect(frame([a, { ...b, opacity: 0.5 }]))).toEqual([]);
    expect(lintInspect(frame([inGroup({ id: 'g2', opacity: 0.4 }, a), b]))).toEqual([]);
    expect(lintInspect(frame([a, { ...b, blendMode: 'screen' }]))).toEqual([]);
    const shadow = text('shadow', { x: 104, y: 104 }, 200, { text: 'a' });
    expect(lintInspect(frame([a, shadow]))).toEqual([]);
  });

  it('does not count the text of two layers that are clipped apart as overlapping', () => {
    const a = text('a', { x: 100, y: 100 }, 200);
    const b = text('b', { x: 150, y: 110 }, 200);
    const left = inGroup({ id: 'l', clip: 'inset', clipBounds: rectOf(0, 0, 200, 600) }, a);
    const right = inGroup({ id: 'r', clip: 'inset', clipBounds: rectOf(300, 0, 700, 600) }, b);
    expect(lintInspect(frame([left, right]))).toEqual([]);
  });

  it('lists the text layers that are wholly inside the canvas', () => {
    const inside = text('in', { x: 100, y: 100 }, 200);
    const out = text('out', { x: 900, y: 100 }, 300);
    expect(textInsideCanvas(frame([inside, out]))).toEqual(['in']);
  });

  it('makes text that runs past the edge as it moves one warning, not an error per frame', () => {
    const slide = (x: number) => frame([text('title', { x, y: 100 }, 300)]);
    const perFrame = [-250, -120, 40, 300].map((x, i) => {
      const result = slide(x);
      return { frame: i * 10, findings: lintInspect(result), inside: textInsideCanvas(result) };
    });
    const issues = mergeFindings(perFrame);
    expect(issues).toEqual([
      expect.objectContaining({ rule: 'text-overflow-canvas', layer: 'title', severity: 'warning', frames: [0, 10] }),
    ]);
    expect(issues[0]!.message).toContain('moving in or out');
  });

  it('keeps it an error when the text is past the edge in every frame it is drawn', () => {
    const result = frame([text('title', { x: 900, y: 100 }, 300)]);
    const issues = mergeFindings([0, 30].map((f) => ({ frame: f, findings: lintInspect(result), inside: textInsideCanvas(result) })));
    expect(issues).toEqual([expect.objectContaining({ rule: 'text-overflow-canvas', severity: 'error', frames: [0, 30] })]);
  });
});

describe('lintNotes', () => {
  it('turns what the project noted into warnings without a frame', () => {
    expect(lintNotes(['a font did not download'])).toEqual([
      { rule: 'project-note', severity: 'warning', layer: null, message: 'a font did not download', frames: [] },
    ]);
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

  it('finds a missing video or gif file, at any depth, naming the layer and the file', () => {
    const media = scene({
      fonts: {},
      layers: [
        { id: 'clip', type: 'video', src: 'clips/gone.mp4' },
        { id: 'g', type: 'group', children: [{ id: 'spinner', type: 'gif', src: 'spin.gif' }] },
        { id: 'here', type: 'video', src: 'clips/there.mp4' },
        { id: 'there', type: 'gif', src: 'there.gif' },
      ],
    });
    const findings = lintScene(media, '/proj', exists(['clips/there.mp4', 'there.gif']));
    expect(findings).toEqual([
      { rule: 'missing-asset', severity: 'error', layer: 'clip', message: 'video file not found: clips/gone.mp4' },
      { rule: 'missing-asset', severity: 'error', layer: 'spinner', message: 'gif file not found: spin.gif' },
    ]);
  });

  it('resolves a video src against the base directory, so absolute staticFile paths work', () => {
    const seen: string[] = [];
    const media = scene({ fonts: {}, layers: [{ id: 'v', type: 'video', src: '/abs/public/a.mp4' }, { id: 'w', type: 'video', src: 'b.mp4' }] });
    lintScene(media, '/proj', (path) => (seen.push(path), true));
    expect(seen).toEqual(['/abs/public/a.mp4', '/proj/b.mp4']);
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

  it('does not look for an @remotion/sfx sound on disk: it is downloaded when the audio is mixed', () => {
    const clip = { id: 'hit', src: 'https://remotion.media/whip.wav', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false };
    expect(lintAudio([clip], '/p', () => false)).toEqual([]);
    expect(lintAudio([{ ...clip, src: 'https://example.com/a.wav' }], '/p', () => false)).toHaveLength(1);
  });

  it('leaves the sound of a <Video> to its layer, which already reports the missing file', () => {
    const sound = { id: 'v', src: 'a.mp4', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false, video: true };
    expect(lintAudio([sound], '/p', () => false)).toEqual([]);
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

describe('lintCompat', () => {
  const item = (over: Partial<Unsupported> = {}): Unsupported => ({
    path: '$0.2 <div>', element: 'div', property: 'transform', value: 'skewX(10deg)', reason: 'skew is not supported', ...over,
  });

  it('is empty when every checked frame is drawn natively', () => {
    expect(lintCompat([{ frame: 0, unsupported: [] }, { frame: 30, unsupported: [] }])).toEqual([]);
  });

  it('makes one warning per issue group, with the checked frames it holds at', () => {
    const filter = item({ element: 'span', property: 'filter', value: 'url(#f)', reason: 'url filters are not supported' });
    const issues = lintCompat([
      { frame: 0, unsupported: [] },
      { frame: 10, unsupported: [item(), filter] },
      { frame: 20, unsupported: [item({ value: 'skewY(3deg)', path: '$1 <div>' })] },
      { frame: 30, unsupported: [item()] },
    ]);
    expect(issues).toEqual([
      {
        rule: 'compat',
        severity: 'warning',
        layer: null,
        message: 'not supported, so the frame is drawn without it or approximated: div transform: skew is not supported (skewX(10deg); skewY(3deg)) at $0.2 <div>, $1 <div>',
        frames: [10, 20, 30],
      },
      {
        rule: 'compat',
        severity: 'warning',
        layer: null,
        message: 'not supported, so the frame is drawn without it or approximated: span filter: url filters are not supported (url(#f)) at $0.2 <div>',
        frames: [10],
      },
    ]);
  });

  it('names an unsupported element without a property or value', () => {
    const canvas = item({ element: 'canvas', property: null, value: null, reason: 'element not supported', path: '$0 <canvas>' });
    const [issue] = lintCompat([{ frame: 4, unsupported: [canvas] }]);
    expect(issue!.message).toBe('not supported, so the frame is drawn without it or approximated: canvas: element not supported at $0 <canvas>');
  });

  it('sorts with the other findings: errors first, then by first frame', () => {
    const compat = lintCompat([{ frame: 0, unsupported: [item()] }]);
    const merged = mergeFindings([{ frame: 50, findings: [{ rule: 'missing-font', severity: 'error', layer: null, message: 'f' }] }]);
    expect(sortIssues([...compat, ...merged]).map((i) => i.rule)).toEqual(['missing-font', 'compat']);
  });
});
