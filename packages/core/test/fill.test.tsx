import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text, useTimeline } from '@kinetograph/react';
import { AbsoluteFill, Img, resetStyleWarnings } from '../src/fill.js';
import { Freeze } from '../src/timeline.js';
import { renderAt } from './scene-harness.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetStyleWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('AbsoluteFill', () => {
  it('is a full-size column layer that sits out of its parent flow', () => {
    const [fill] = renderAt(<AbsoluteFill />).layers;
    expect(fill).toMatchObject({
      type: 'group',
      layout: { flexDirection: 'column', width: 1280, height: 720 },
      layoutItem: { position: 'absolute' },
    });
  });

  it('maps the supported style keys', () => {
    const [fill] = renderAt(
      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          gap: 12,
          padding: '10px 20px',
          opacity: 0.5,
        }}
      />,
    ).layers as any[];
    expect(fill.layout).toEqual({
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'flex-end',
      flexWrap: 'wrap',
      gap: 12,
      padding: [10, 20, 10, 20],
      width: 1280,
      height: 720,
    });
    expect(fill.opacity).toBe(0.5);
    expect(warn).not.toHaveBeenCalled();
  });

  it('draws backgroundColor as a full-size rect first, out of the flow', () => {
    const [fill] = renderAt(
      <AbsoluteFill style={{ backgroundColor: '#112233' }}>
        <Text font="Inter" size={40}>
          hi
        </Text>
      </AbsoluteFill>,
    ).layers as any[];
    expect(fill.children).toHaveLength(2);
    expect(fill.children[0]).toMatchObject({
      type: 'shape',
      shape: { kind: 'rect', width: 1280, height: 720 },
      fill: '#112233',
      layoutItem: { position: 'absolute' },
    });
    expect(fill.children[1].type).toBe('text');
  });

  it('takes `background` as a colour too and draws nothing for a transparent one', () => {
    const [a] = renderAt(<AbsoluteFill style={{ background: 'red' }} />).layers as any[];
    expect(a.children[0].fill).toBe('red');
    const [b] = renderAt(<AbsoluteFill style={{ backgroundColor: 'transparent' }} />).layers as any[];
    expect(b.children ?? []).toHaveLength(0);
  });

  it('warns once about a value it cannot map, however often it renders', () => {
    renderAt(<AbsoluteFill style={{ gap: '2em' }} />);
    renderAt(<AbsoluteFill style={{ gap: '3em' }} />);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('style.gap');
  });

  it('warns about a background that is not a colour, and about display values it cannot do', () => {
    renderAt(<AbsoluteFill style={{ background: 'linear-gradient(red, blue)', display: 'block' }} />);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('renders nothing for display: none', () => {
    expect(renderAt(<AbsoluteFill style={{ display: 'none' }} />).layers).toEqual([]);
  });

  it('follows the composition size', () => {
    const [fill] = renderAt(<AbsoluteFill />, 0, {
      config: { id: 'S', width: 1080, height: 1920, fps: 30, durationInFrames: 90, defaultProps: {}, props: {} },
    }).layers as any[];
    expect(fill.layout).toMatchObject({ width: 1080, height: 1920 });
  });
});

describe('Img', () => {
  it('maps width, height and objectFit from style', () => {
    const [img] = renderAt(<Img src="/a.png" style={{ width: 300, height: '200px', objectFit: 'cover' }} />).layers;
    expect(img).toMatchObject({ type: 'image', src: '/a.png', width: 300, height: 200, fit: 'cover' });
  });

  it('takes width and height props when style has none, and leaves the rest to the engine', () => {
    const [img] = renderAt(<Img src="/a.png" width={64} />).layers as any[];
    expect(img.width).toBe(64);
    expect(img.height).toBeUndefined();
    expect(img.fit).toBeUndefined();
  });

  it('warns about an object fit it cannot do', () => {
    renderAt(<Img src="/a.png" style={{ objectFit: 'none' }} />);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('Freeze', () => {
  it('marks the timeline frozen for what is inside', () => {
    const seen: boolean[] = [];
    function Reader() {
      seen.push(useTimeline().frozen);
      return null;
    }
    renderAt(
      <>
        <Freeze frame={4}>
          <Reader />
        </Freeze>
        <Freeze frame={4} active={false}>
          <Reader />
        </Freeze>
        <Reader />
      </>,
    );
    expect(seen).toEqual([true, false, false]);
  });
});
