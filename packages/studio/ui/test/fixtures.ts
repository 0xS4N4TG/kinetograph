import type { CompositionInfo, InspectResult, RenderJob, TimelineData } from '../src/api';

export const intro: CompositionInfo = {
  id: 'Intro',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 150,
  defaultProps: { title: 'Hello', size: 64, visible: true, color: '#ff0000', style: { bold: true } },
};

export const outro: CompositionInfo = {
  id: 'Outro',
  width: 1280,
  height: 720,
  fps: 24,
  durationInFrames: 48,
  defaultProps: {},
};

type InspectLayer = InspectResult['layers'][number];

export function layer(id: string, type: string, extra: Partial<InspectLayer> = {}): InspectLayer {
  return {
    id,
    type,
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
    ...extra,
  };
}

export function inspectFor(comp: CompositionInfo, frame: number): InspectResult {
  return {
    width: comp.width,
    height: comp.height,
    fps: comp.fps,
    durationInFrames: comp.durationInFrames,
    frame,
    margin: 44,
    camera: null,
    layers: [
      layer('bg', 'shape', { opacity: 0.5 }),
      layer('title-group', 'group', {
        children: [
          layer('title', 'text', {
            effects: ['dropShadow'],
            text: { text: 'Hello', font: 'Inter', size: 64, width: 200, height: 80, maxWidth: null, lines: [] },
          }),
        ],
      }),
    ],
  };
}

export const introTimeline: TimelineData = {
  comp: 'Intro',
  fps: 30,
  durationInFrames: 150,
  sequences: [
    { key: '/Scene@0+150', name: 'Scene', from: 0, durationInFrames: 150, parent: null, layer: 'bg' },
    { key: '/Scene@0+150/Title card@10+60', name: 'Title card', from: 10, durationInFrames: 60, parent: '/Scene@0+150', layer: 'title-group' },
    { key: '/Scene@0+150/Sequence@80+40', name: null, from: 80, durationInFrames: 40, parent: '/Scene@0+150', layer: null },
  ],
  layers: [
    { id: 'bg', type: 'shape', parent: null, ranges: [[0, 149]] },
    { id: 'title-group', type: 'group', parent: null, ranges: [[10, 69]] },
    { id: 'title', type: 'text', parent: 'title-group', ranges: [[10, 69]] },
  ],
};

export function job(id: string, extra: Partial<RenderJob> = {}): RenderJob {
  return {
    id,
    comp: 'Intro',
    output: `/work/out/Intro-${id}.mp4`,
    range: [0, 149],
    props: {},
    status: 'queued',
    framesDone: 0,
    framesTotal: 150,
    msPerFrame: null,
    summary: null,
    error: null,
    queuedAt: 1_000,
    finishedAt: null,
    ...extra,
  };
}
