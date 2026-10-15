// COMPAT.md §4.6, §2: img, video, native elements inside DOM, and flex layout of boxes.

import { describe, expect, it } from 'vitest';
import type { LayerJson } from '@kinetograph/scene';
import { div, el, find, hasAddon, nativeNode, pct, px, rgb, run } from './helpers.js';

describe.skipIf(!hasAddon)('img and video', () => {
  it('is a box whose content is an image layer in its content box', () => {
    const { root, unsupported } = run(
      div({ display: 'flex', width: px(400), height: px(300) }, [
        el('img', { width: px(120), height: px(80), objectFit: 'cover', padding: [px(5), px(5), px(5), px(5)] }, [], { src: '/a.png' }),
      ]),
    );
    expect(unsupported).toEqual([]);
    expect(find(root, '$0.0.img')).toEqual({
      id: '$0.0.img',
      type: 'image',
      src: '/a.png',
      width: 120,
      height: 80,
      fit: 'cover',
      transform: { x: 5, y: 5 },
    });
  });

  it('takes its size from the width and height attributes, and scales with one style side', () => {
    const attrs = run(div({}, [el('img', {}, [], { src: '/a.png', width: 40, height: 20 })]));
    expect(find(attrs.root, '$0.0.img')).toMatchObject({ width: 40, height: 20 });
    const scaled = run(div({}, [el('img', { width: px(100) }, [], { src: '/a.png', width: 40, height: 20 })]));
    expect(find(scaled.root, '$0.0.img')).toMatchObject({ width: 100, height: 50 });
  });

  it('reports an image whose natural size would be needed, and an object-position that is not centred', () => {
    const noSize = run(div({}, [el('img', { width: px(100) }, [], { src: '/a.png' })]));
    expect(noSize.unsupported).toEqual([expect.objectContaining({ element: 'img', reason: expect.stringContaining('natural size') })]);
    const position = run(div({}, [el('img', { width: px(10), height: px(10), objectPosition: [px(0), px(0)] }, [], { src: '/a.png' })]));
    expect(position.unsupported).toEqual([expect.objectContaining({ property: 'objectPosition' })]);
    const none = run(div({}, [el('img', { width: px(10), height: px(10), objectFit: 'none' }, [], { src: '/a.png' })]));
    expect(none.unsupported).toEqual([expect.objectContaining({ property: 'objectFit' })]);
  });

  it('rounds the picture with the box radius', () => {
    const { root } = run(
      div({}, [
        el(
          'img',
          { width: px(100), height: px(100), borderRadius: [[px(50), px(50)], [px(50), px(50)], [px(50), px(50)], [px(50), px(50)]] },
          [],
          { src: '/a.png' },
        ),
      ]),
    );
    expect(find(root, '$0.0.img').clip.kind).toBe('path');
  });

  it('is a video layer for <video>, with the src of a <source>', () => {
    const { root } = run(
      div({}, [el('video', { width: px(160), height: px(90) }, [el('source', {}, [], { src: '/clip.mp4' })])]),
    );
    expect(find(root, '$0.0.video')).toEqual({ id: '$0.0.video', type: 'video', src: '/clip.mp4', width: 160, height: 90 });
  });
});

describe.skipIf(!hasAddon)('native elements in a DOM element', () => {
  const rect = (id: string, width: number, height: number, extra: Record<string, unknown> = {}): LayerJson =>
    ({ id, type: 'shape', shape: { kind: 'rect', width, height }, fill: '#fff', ...extra }) as LayerJson;

  it('is a box of the layer size, placed by CSS and drawn as it is', () => {
    const calls: string[] = [];
    const { root, unsupported } = run(
      div({ display: 'flex', width: px(400), height: px(200), justifyContent: 'center', alignItems: 'center' }, [
        { kind: 'native', node: nativeNode('kg-rect'), path: '' },
      ]),
      {
        emitNative: (node, path) => {
          calls.push(`${(node as { type: string }).type}@${path}`);
          return rect(path, 100, 60);
        },
      },
    );
    expect(unsupported).toEqual([]);
    expect(calls).toEqual(['kg-rect@$0.0']);
    // Centred in the 400 x 200 box.
    expect(find(root, '$0.0')).toMatchObject({ id: '$0.0', type: 'shape', transform: { x: 150, y: 70 } });
  });

  it('keeps the layer own offset and adds the anchor, as the scene layout does', () => {
    const { root } = run(
      div({ padding: [px(10), px(0), px(0), px(30)] }, [{ kind: 'native', node: nativeNode('kg-rect'), path: '' }]),
      { emitNative: (_n, path) => rect(path, 50, 20, { transform: { x: 5, anchorX: 25, anchorY: 10, rotation: 10 } }) },
    );
    expect(find(root, '$0.0').transform).toEqual({ x: 5 + 30 + 25, y: 10 + 10, anchorX: 25, anchorY: 10, rotation: 10 });
  });

  it('measures a native text layer, and takes a group size from its layout', () => {
    const { root } = run(
      div({}, [
        { kind: 'native', node: nativeNode('kg-text'), path: '' },
        { kind: 'native', node: nativeNode('kg-layer'), path: '' },
        { kind: 'native', node: nativeNode('kg-rect'), path: '' },
      ]),
      {
        emitNative: (node, path) => {
          if ((node as { type: string }).type === 'kg-text') return { id: path, type: 'text', text: 'hello', font: 'DM Sans', size: 40, color: '#fff' };
          if ((node as { type: string }).type === 'kg-layer') return { id: path, type: 'group', layout: { width: 300, height: 25 }, children: [] };
          return rect(path, 10, 10);
        },
      },
    );
    expect(find(root, '$0.0').transform).toBeUndefined();
    // The text is a line tall (40 px font), then the 25 px group, then the rect.
    expect(find(root, '$0.1').transform.y).toBeGreaterThan(40);
    expect(find(root, '$0.2').transform.y - find(root, '$0.1').transform.y).toBe(25);
  });

  it('reports a native element whose size the layout cannot know', () => {
    const { unsupported } = run(div({}, [{ kind: 'native', node: nativeNode('kg-image'), path: '' }]), {
      emitNative: (_n, path) => ({ id: path, type: 'image', src: '/x.png' }),
    });
    expect(unsupported).toEqual([expect.objectContaining({ path: '$0.0 <kg-image>', property: 'width' })]);
  });

  it('leaves out an element that is a camera or sound (no layer)', () => {
    const { root } = run(div({ width: px(10), height: px(10), backgroundColor: rgb(0, 0, 0) }, [{ kind: 'native', node: nativeNode('kg-camera'), path: '' }]), {
      emitNative: () => null,
    });
    expect(root.children.map((c: any) => c.id)).toEqual(['$0.bg']);
  });
});

describe.skipIf(!hasAddon)('flex layout', () => {
  it('lays boxes out with CSS flexbox, in the composition box', () => {
    const item = (extra = {}) => div({ height: px(50), backgroundColor: rgb(0, 0, 0), ...extra });
    const { root } = run(
      div({ display: 'flex', flexDirection: 'row', columnGap: px(10), width: pct(100), boxSizing: 'border-box', padding: [px(20), px(20), px(20), px(20)] }, [
        item({ width: px(100) }),
        item({ flexGrow: 1 }),
        item({ width: px(100) }),
      ]),
    );
    expect(find(root, '$0.0').transform).toEqual({ x: 20, y: 20 });
    expect(find(root, '$0.1').transform).toEqual({ x: 130, y: 20 });
    expect(find(root, '$0.1.bg').shape.width).toBe(1000 - 40 - 200 - 20);
    expect(find(root, '$0.2').transform.x).toBe(1000 - 20 - 100);
  });

  it('fills the composition for an absolute root with inset 0, as AbsoluteFill does', () => {
    const { root } = run(
      div({ position: 'absolute', inset: [px(0), px(0), px(0), px(0)], display: 'flex', flexDirection: 'column', backgroundColor: rgb(0, 0, 0) }),
    );
    expect(find(root, '$0.bg').shape).toEqual({ kind: 'rect', width: 1000, height: 800 });
  });
});
