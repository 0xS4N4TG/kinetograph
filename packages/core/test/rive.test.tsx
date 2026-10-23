// `<RemotionRiveCanvas>` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.6) on the addon's Rive runtime and the tiny `volume_bars.riv` (MIT, from
// rive-app/rive-runtime): three dark bars on a 96 x 47 artboard whose heights animate.

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDomEnvironment } from '@kinetographdev/compat/dom';
import { RemotionRiveCanvas } from '../src/rive.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { renderDom } from './dom-harness.js';

beforeEach(() => {
  clearReportedUnsupported();
  setDomEnvironment({ baseDir: join(import.meta.dirname, 'fixtures/media') });
});
afterEach(() => clearReportedUnsupported());

/** The canvas layer's commands for a frame. */
function commandsAt(frame: number, props: Partial<Parameters<typeof RemotionRiveCanvas>[0]> = {}): any[] {
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

  it('reports the props it does not draw', () => {
    commandsAt(0, { onLoad: () => undefined, effects: [] as never });
    const items = reportedUnsupported().map((u) => u.property);
    expect(items).toEqual(expect.arrayContaining(['onLoad', 'effects']));
  });
});
