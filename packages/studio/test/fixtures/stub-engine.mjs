// A stand-in engine for the studio's tests (src/engine.ts): no project is run and no GPU is touched. The composition ids
// come from a marker in the project (`KG_MARK:<name>`), so that a test can tell which build is being served; frames are
// made of the arguments they were asked for, so that a test can read back what reached the engine.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, message) => Object.assign(new Error(message), { code });

export function createEngine({ entry, bundleFile }) {
  // Differs between workers, so a test can tell a cached answer from a recomputed one.
  const nonce = Math.random().toString(36).slice(2, 8);

  function marker() {
    if (entry.endsWith('.json')) {
      const scene = JSON.parse(readFileSync(entry, 'utf8'));
      if (scene.boom) throw fail('SCENE_INVALID', 'invalid scene: boom');
      return scene.id ?? 'scene';
    }
    const found = /KG_MARK:(\w+)/.exec(readFileSync(bundleFile, 'utf8'));
    if (!found) throw fail('PROJECT_ERROR', 'no marker');
    if (found[1] === 'boom') throw fail('PROJECT_ERROR', 'the project failed while loading');
    return found[1];
  }

  const compositions = () => [
    { id: marker(), width: 64, height: 36, fps: 30, durationInFrames: 90, defaultProps: { title: 'hi' } },
    { id: 'Short', width: 64, height: 36, fps: 30, durationInFrames: 6, defaultProps: {} },
  ];
  const find = (comp) => {
    const found = compositions().find((c) => c.id === comp);
    if (!found) throw fail('COMPOSITION_NOT_FOUND', `no composition "${comp}"`);
    return found;
  };

  return {
    async compositions() {
      return compositions();
    },

    async plan({ comp, range }) {
      const composition = find(comp);
      if (range === undefined) return { composition, range: [0, composition.durationInFrames - 1] };
      const m = /^(\d*)\.\.(=?)(\d*)$/.exec(range);
      if (!m) throw fail('INVALID_ARG', `bad range "${range}"`);
      const first = m[1] === '' ? 0 : Number(m[1]);
      const last = m[3] === '' ? composition.durationInFrames - 1 : Number(m[3]) - (m[2] === '=' ? 0 : 1);
      return { composition, range: [first, last] };
    },

    async frame({ comp, props, frame }) {
      const composition = find(comp);
      if (frame >= composition.durationInFrames) throw fail('FRAME_OUT_OF_RANGE', `frame ${frame} is out of range`);
      if (props._frameMs) await sleep(props._frameMs);
      if (props._jsError) throw fail('PROJECT_ERROR', 'the composition threw');
      const showing = (frame >= 10 && frame < 30) || (frame >= 50 && frame < 60);
      const layers = [{ id: 'bg', type: 'shape' }];
      if (showing) layers.push({ id: '$0', type: 'group', children: [{ id: '$0.0', type: 'shape' }] });
      return {
        sceneJson: JSON.stringify({ layers, props, frame }),
        frame,
        baseDir: dirname(entry),
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        sequences:
          comp === 'Short'
            ? []
            : [
                { key: '/intro@10+20', name: `intro-${nonce}`, from: 10, durationInFrames: 20, parent: null, layer: frame >= 10 && frame < 30 ? '$0' : null },
                { key: '/intro@10+20/inner@12+5', name: 'inner', from: 12, durationInFrames: 5, parent: '/intro@10+20', layer: frame >= 12 && frame < 17 ? '$0' : null },
                { key: '/outro@50+10', name: 'outro', from: 50, durationInFrames: 10, parent: null, layer: frame >= 50 && frame < 60 ? '$0' : null },
              ],
        constant: false,
        jsMs: 0,
      };
    },

    async preview(scene, { scale, format }) {
      const { props, frame } = JSON.parse(scene.sceneJson);
      if (props._previewMs) await sleep(props._previewMs);
      if (props._gpuError) throw fail('RENDER', 'the GPU is gone');
      return {
        width: Math.max(1, Math.round(scene.width * scale)),
        height: Math.max(1, Math.round(scene.height * scale)),
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        data: new TextEncoder().encode(JSON.stringify({ frame, scale, format, props })),
      };
    },

    async inspect(scene) {
      const { layers, frame } = JSON.parse(scene.sceneJson);
      return {
        width: scene.width,
        height: scene.height,
        fps: scene.fps,
        durationInFrames: scene.durationInFrames,
        frame,
        margin: 0,
        camera: null,
        layers: layers.map((l) => ({ id: l.id, type: l.type })),
      };
    },

    async render(spec, hooks) {
      const total = spec.range[1] - spec.range[0] + 1;
      for (let i = 0; i < total; i++) {
        if (hooks.shouldCancel()) throw fail('CANCELLED', 'the render was cancelled');
        await sleep(spec.props._renderFrameMs ?? 2);
        if (spec.props._renderFail && i === 2) throw fail('ENCODE', 'the encoder said no');
        hooks.onFrame(i + 1, total);
      }
      mkdirSync(dirname(spec.output), { recursive: true });
      writeFileSync(spec.output, `stub video ${spec.comp} ${spec.range.join('..')}${spec.draft ? ' draft' : ''}`);
      return { output: spec.output, frames: total, first: spec.range[0], last: spec.range[1], encoder: spec.encoder ?? 'stub' };
    },

    dispose() {},
  };
}
