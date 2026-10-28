// `<RemotionRiveCanvas>` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.6) on the addon's Rive runtime and the tiny `volume_bars.riv` (MIT, from
// rive-app/rive-runtime): three dark bars on a 96 x 47 artboard whose heights animate.

import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomEnvironment } from '@kinetographdev/compat/dom';
import { RemotionRiveCanvas, decodeImage, type RemotionRiveCanvasProps, type RiveCanvasRef, type RiveFile } from '../src/rive.js';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { tinted } from './effect-fixtures.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { renderDom } from './dom-harness.js';

beforeEach(() => {
  clearReportedUnsupported();
  setDomEnvironment({ baseDir: join(import.meta.dirname, 'fixtures/media') });
});
afterEach(() => clearReportedUnsupported());

/** The canvas layer's commands for a frame. */
function commandsAt(frame: number, props: Partial<RemotionRiveCanvasProps> = {}): any[] {
  const tree = renderDom(<RemotionRiveCanvas src="volume_bars.riv" {...props} />, frame);
  const layer: any = tree.layers.find((l: any) => l.type === 'canvas');
  return layer.commands;
}

/** The scale of each bar (its height) in the order drawn. */
const heights = (commands: any[]): number[] => commands.filter((c) => c.op === 'fill').map((c) => c.m[3]);

describe('RemotionRiveCanvas', () => {
  it('draws the artboard as canvas commands, fitted to the composition', () => {
    const commands = commandsAt(0);
    expect(commands[0].op).toBe('clip');
    expect(heights(commands)).toHaveLength(3);
    // contain: the 96.7 x 47.2 artboard into the 1280 x 720 composition is limited by its width.
    expect(commands[0].m[0]).toBeCloseTo(1280 / 96.703, 1);
  });

  it('plays the animation to the frame time', () => {
    expect(heights(commandsAt(0))).not.toEqual(heights(commandsAt(10)));
  });

  it('is a function of the frame, not of the frames drawn before it', () => {
    const first = commandsAt(10);
    commandsAt(40);
    commandsAt(3);
    expect(commandsAt(10)).toEqual(first);
  });

  it('places the artboard by fit and alignment', () => {
    const fill = commandsAt(0, { fit: 'fill' })[0].m;
    expect(fill[0]).toBeCloseTo(1280 / 96.703, 1);
    expect(fill[3]).toBeCloseTo(720 / 47.207, 1);
    const left = commandsAt(0, { fit: 'none', alignment: 'top-left' })[0].m;
    expect([left[4], left[5]]).toEqual([0, 0]);
  });

  it('names the artboard or animation it cannot find', () => {
    expect(() => commandsAt(0, { artboard: 'nope' })).toThrow('no artboard "nope"');
    expect(() => commandsAt(0, { animation: 'nope' })).toThrow('no animation "nope"');
    expect(() => commandsAt(0, { stateMachine: 'nope' })).toThrow('no state machine "nope"');
  });

  it('refuses a URL, which cannot be fetched while rendering', () => {
    expect(() => commandsAt(0, { src: 'https://example.com/a.riv' })).toThrow('download the file');
  });

  it('calls onLoad with the file: its artboards, animations and state machines', () => {
    let file: RiveFile | null = null;
    commandsAt(0, { onLoad: (f) => (file = f) });
    expect(file!.artboardCount()).toBe(1);
    const board = file!.defaultArtboard()!;
    expect(board.animationCount()).toBeGreaterThan(0);
    expect(board.animationByIndex(0)!.fps).toBeGreaterThan(0);
    expect(reportedUnsupported()).toEqual([]);
  });

  it('answers the ref getters with the canvas, the artboard and the animation at the frame', () => {
    // Read while the frame is rendered: the harness unmounts it afterwards.
    let seen: { canvas: unknown; width: number; time: number; machine: unknown; renderer: unknown } | null = null;
    const ref = (handle: RiveCanvasRef | null) => {
      if (handle === null || seen !== null) return;
      const instance = handle.getAnimationInstance()!;
      seen = { canvas: handle.getCanvas(), width: handle.getArtboard()!.width, time: instance.time, machine: instance.stateMachine, renderer: handle.getRenderer() };
    };
    renderDom(<RemotionRiveCanvas src="volume_bars.riv" ref={ref} />, 15);
    expect(seen!.canvas).not.toBeNull();
    expect(seen!.width).toBeGreaterThan(90);
    expect(seen!.time).toBeCloseTo(0.5);
    expect(seen!.machine).toBeNull();
    expect(seen!.renderer).toBeNull();
  });

  it('sets state machine inputs from props or as a function of the frame', () => {
    const blend = (inputs: RemotionRiveCanvasProps['stateMachineInputs'], frame = 15) =>
      commandsAt(frame, { src: 'blend_test.riv', stateMachine: 'blend', stateMachineInputs: inputs });
    expect(blend({ verticality: 0 })).not.toEqual(blend({ verticality: 100 }));
    expect(blend({ verticality: 66.627808 })).toEqual(blend(undefined));
    // A function of the frame: the value from frame 10 on is not seen at frame 5.
    const late = (f: number) => ({ verticality: f >= 10 ? 0 : 66.627808 });
    expect(blend(late, 5)).toEqual(blend(undefined, 5));
    expect(blend(late, 15)).not.toEqual(blend(undefined, 15));
    // A trigger fires at the frames it is true.
    const triggers = (fire: boolean) =>
      commandsAt(30, { src: 'state_machine_triggers.riv', stateMachine: 0, stateMachineInputs: (f) => ({ 'Trigger 1': fire && f === 3 }) });
    expect(triggers(true)).not.toEqual(triggers(false));
    expect(() => blend({ nope: 1 })).toThrow('"nope"');
  });

  it('reports a referenced picture it cannot find, and draws one given by assetLoader or found beside the file', () => {
    const images = (commands: any[]) => commands.filter((c) => c.op === 'image').length;
    expect(images(commandsAt(0, { src: 'walle.riv' }))).toBe(0);
    expect(reportedUnsupported().map((u) => u.value)).toEqual(expect.arrayContaining(['walle-370.png', 'eve-317.png']));
    clearReportedUnsupported();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    const given = commandsAt(0, { src: 'walle.riv', assetLoader: (asset) => (asset.uniqueFilename === 'walle-370.png' ? (asset.decode(png), true) : false) });
    expect(images(given)).toBe(1);
    expect(reportedUnsupported().map((u) => u.value)).toEqual(['eve-317.png']);
    // Beside the file, by the name the Rive editor exports it under.
    const dir = mkdtempSync(join(tmpdir(), 'kinetograph-rive-'));
    copyFileSync(join(import.meta.dirname, 'fixtures/media/walle.riv'), join(dir, 'walle.riv'));
    // Read once with no pictures beside it: adding them later is seen (the file is read again).
    expect(images(commandsAt(0, { src: join(dir, 'walle.riv') }))).toBe(0);
    writeFileSync(join(dir, 'walle-370.png'), png);
    writeFileSync(join(dir, 'eve-317.png'), png);
    clearReportedUnsupported();
    expect(images(commandsAt(0, { src: join(dir, 'walle.riv') }))).toBeGreaterThan(images(given));
    expect(reportedUnsupported()).toEqual([]);
  });

  it('runs effects over the canvas', () => {
    const tree = renderDom(<RemotionRiveCanvas src="volume_bars.riv" effects={[tinted({ color: '#ff0' })]} />, 0);
    const canvases: any[] = [];
    const walk = (layers: any[]) => {
      for (const layer of layers) {
        // The rive canvas is a canvas layer; each effect's is a group's canvas.
        if (layer.type === 'canvas') canvases.push(layer);
        if (layer.canvas) canvases.push(layer.canvas);
        if (layer.children) walk(layer.children);
      }
    };
    walk(tree.layers);
    expect(canvases.some((c) => c.commands.some((op: any) => op.op === 'clip'))).toBe(true);
    expect(canvases.some((c) => c.commands.some((op: any) => op.op === 'image'))).toBe(true);
    expect(reportedUnsupported()).toEqual([]);
  });
});

describe('RemotionRiveCanvas in the frame loop', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

  beforeEach(() => {
    resetCompositions();
    resetRenderState();
    resetVirtualClock();
    installDeterminism();
  });
  afterEach(() => {
    uninstallDeterminism();
    resetRenderState();
  });

  it('holds the frame for a loader that decodes later, as Rive documents it, and draws what it decoded', async () => {
    let calls = 0;
    // An inline arrow, a new function every render: the file and the loader's code key what it gave.
    function Clip() {
      return (
        <RemotionRiveCanvas
          src="walle.riv"
          assetLoader={(asset) => {
            calls += 1;
            if (!asset.isImage) return false;
            void Promise.resolve()
              .then(() => decodeImage(PNG))
              .then((image) => asset.setRenderImage(image));
            return true;
          }}
        />
      );
    }
    registerRoot(() => <Composition id="R" component={Clip} width={64} height={64} fps={30} durationInFrames={10} />);
    setDomEnvironment({ baseDir: join(import.meta.dirname, 'fixtures/media') });
    const r = createFrameRenderer('R');
    const images = (layers: any[]): number =>
      layers.reduce((n, l) => n + (l.commands ?? []).filter((c: any) => c.op === 'image').length + images(l.children ?? []), 0);
    const first = await r.renderFrame(0);
    expect(images(first.scene.layers)).toBeGreaterThan(0);
    const second = await r.renderFrame(1);
    expect(images(second.scene.layers)).toBe(images(first.scene.layers));
    // Both pictures of the file were asked for once, not again on the next frame.
    expect(calls).toBe(2);
  });
});
