// getTotalLength, getPointAtLength and getBBox on refs to SVG elements (docs/ENGINE.md §1, "Readback"): the maths is
// the Remotion path functions of `@kinetograph/core/paths`, handed to the shim by `web/install`.

import { useLayoutEffect, useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { createSceneRoot, TimelineContext } from '@kinetograph/react';
import { setDomAddon } from '@kinetograph/compat/dom';
import '../src/web-install.js';

const timeline = {
  frame: 0,
  absoluteFrame: 0,
  durationInFrames: 10,
  config: { id: 'T', width: 100, height: 100, fps: 30, durationInFrames: 10, defaultProps: {}, props: {} },
  frozen: false,
};

describe('SVG element geometry', () => {
  it('measures shapes by their attributes and groups by their children', () => {
    setDomAddon({
      renderDomIsland: () => '{"layers":[],"unsupported":[],"camera":null}',
      domLayoutBoxes: () => '{}',
      domComputedStyle: () => [],
    });
    const seen: Record<string, any> = {};
    function Probe() {
      const line = useRef<any>(null);
      const circle = useRef<any>(null);
      const rect = useRef<any>(null);
      const path = useRef<any>(null);
      const g = useRef<any>(null);
      useLayoutEffect(() => {
        seen.length = line.current.getTotalLength();
        seen.mid = line.current.getPointAtLength(5);
        seen.clamped = line.current.getPointAtLength(99);
        seen.circle = circle.current.getTotalLength();
        seen.rect = rect.current.getTotalLength();
        seen.path = path.current.getBBox().toJSON();
        seen.box = g.current.getBBox().toJSON();
      }, []);
      return (
        <svg width={50} height={50} viewBox="0 0 50 50">
          <g ref={g}>
            <line ref={line} x1={0} y1={0} x2={6} y2={8} />
            <circle ref={circle} cx={30} cy={30} r={10} />
            <rect ref={rect} x={1} y={1} width={4} height={3} />
            <path ref={path} d="M10 10 L20 10 L20 30 Z" />
          </g>
        </svg>
      );
    }
    const root = createSceneRoot({ viewport: { width: 100, height: 100 } });
    root.render(
      <TimelineContext.Provider value={timeline}>
        <Probe />
      </TimelineContext.Provider>,
    );
    root.unmount();
    setDomAddon(null);
    expect(seen.length).toBeCloseTo(10, 6);
    expect(seen.mid).toMatchObject({ x: 3, y: 4 });
    expect(seen.clamped).toMatchObject({ x: 6, y: 8 });
    expect(seen.circle).toBeCloseTo(2 * Math.PI * 10, 3);
    expect(seen.rect).toBeCloseTo(14, 6);
    expect(seen.path).toMatchObject({ x: 10, y: 10, width: 10, height: 20 });
    expect(seen.box).toMatchObject({ x: 0, y: 0, width: 40, height: 40 });
  });
});
