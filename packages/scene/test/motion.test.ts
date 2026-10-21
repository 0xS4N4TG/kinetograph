import { describe, expect, it } from 'vitest';
import {
  attachMotionChanges,
  attachMotionFrames,
  collectMotionTimes,
  evalNum,
  motionTimes,
  type GroupLayer,
  type LayerJson,
  type ShapeLayer,
} from '../src/index.js';

const rect = (id: string, extra: Partial<ShapeLayer> = {}): ShapeLayer => ({
  id,
  type: 'shape',
  shape: { kind: 'rect', width: 10, height: 10 },
  ...extra,
});
const group = (id: string, children: LayerJson[], extra: Partial<GroupLayer> = {}): GroupLayer => ({
  id,
  type: 'group',
  children,
  ...extra,
});

describe('evalNum', () => {
  it('follows the keyframe rules of SCENE.md', () => {
    expect(evalNum(5, 100)).toBe(5);
    const keys = [
      { frame: 10, value: 0 },
      { frame: 20, value: 100 },
    ];
    expect(evalNum(keys, 0)).toBe(0);
    expect(evalNum(keys, 15)).toBe(50);
    expect(evalNum(keys, 99)).toBe(100);
    expect(evalNum([{ frame: 0, value: 0, easing: 'easeIn' }, { frame: 4, value: 1 }], 1)).toBeCloseTo(0.015625, 12);
    expect(evalNum([{ frame: 0, value: 0, easing: 'easeOut' }, { frame: 4, value: 1 }], 1)).toBeCloseTo(0.578125, 12);
    expect(evalNum([{ frame: 0, value: 0, easing: 'easeInOut' }, { frame: 4, value: 1 }], 1)).toBeCloseTo(0.0625, 12);
  });

  it('makes a step of two keyframes on one frame', () => {
    const step = [
      { frame: 5, value: 0 },
      { frame: 5, value: 1 },
    ];
    expect(evalNum(step, 4.9)).toBe(0);
    expect(evalNum(step, 5)).toBe(1);
  });
});

describe('motionTimes', () => {
  it("uses SCENE.md's t_i = frame + shutter * ((i + 0.5) / samples - 0.5)", () => {
    expect(motionTimes(10, 4, 0.5)).toEqual([9.8125, 9.9375, 10.0625, 10.1875]);
    expect(motionTimes(0, 2, 1)).toEqual([-0.25, 0.25]);
    const times = motionTimes(30, 8, 1);
    expect(times).toHaveLength(8);
    times.forEach((t, i) => expect(t).toBe(30 + 1 * ((i + 0.5) / 8 - 0.5)));
  });

  it('puts the samples in the middle of equal slots, centred on the frame', () => {
    const times = motionTimes(20, 8, 2);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    expect(mean).toBeCloseTo(20, 12);
    expect(times[0]).toBeCloseTo(19 + 1 / 8, 12);
    expect(times[7]).toBeCloseTo(21 - 1 / 8, 12);
  });

  it('clamps the shutter to 0..2', () => {
    expect(motionTimes(10, 4, 5)).toEqual(motionTimes(10, 4, 2));
    expect(motionTimes(10, 4, -1)).toEqual([10, 10, 10, 10]);
    expect(motionTimes(10, 4, 0)).toEqual([10, 10, 10, 10]);
  });

  it('wants a whole number of samples from 2 to 64', () => {
    expect(() => motionTimes(0, 1, 0.5)).toThrow(RangeError);
    expect(() => motionTimes(0, 65, 0.5)).toThrow(RangeError);
    expect(() => motionTimes(0, 2.5, 0.5)).toThrow(RangeError);
    expect(motionTimes(0, 64, 0.5)).toHaveLength(64);
  });
});

describe('collectMotionTimes', () => {
  it('is empty without motion blur', () => {
    expect(collectMotionTimes([rect('a'), group('g', [rect('b')])], 5)).toEqual([]);
  });

  it('uses 8 samples and a 0.5 shutter by default', () => {
    expect(collectMotionTimes([rect('a', { motionBlur: {} })], 10)).toEqual(motionTimes(10, 8, 0.5));
  });

  it('merges the times of several layers, distinct and sorted', () => {
    const times = collectMotionTimes(
      [
        rect('a', { motionBlur: { samples: 4, shutter: 1 } }),
        rect('b', { motionBlur: { samples: 4, shutter: 1 } }),
        rect('c', { motionBlur: { samples: 2, shutter: 1 } }),
      ],
      10,
    );
    expect(times).toEqual([9.625, 9.75, 9.875, 10.125, 10.25, 10.375]);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(new Set(times).size).toBe(times.length);
  });

  it('finds blurred layers inside groups', () => {
    const times = collectMotionTimes([group('g', [group('h', [rect('a', { motionBlur: { samples: 2 } })])])], 3);
    expect(times).toEqual(motionTimes(3, 2, 0.5));
  });

  it('counts only the outermost: a motionBlur inside a blurred layer asks for nothing', () => {
    const outer = group('outer', [rect('inner', { motionBlur: { samples: 5, shutter: 2 } })], {
      motionBlur: { samples: 2, shutter: 1 },
    });
    expect(collectMotionTimes([outer], 10)).toEqual(motionTimes(10, 2, 1));
  });

  it("does not let a parent whose shutter is 0 stop its children's", () => {
    const parent = group('parent', [rect('inner', { motionBlur: { samples: 2, shutter: 1 } })], {
      motionBlur: { samples: 4, shutter: 0 },
    });
    expect(collectMotionTimes([parent], 10)).toEqual(motionTimes(10, 2, 1));
    expect(collectMotionTimes([rect('only', { motionBlur: { shutter: 0 } })], 10)).toEqual([]);
  });

  it('evaluates an animated shutter at the frame', () => {
    const shutter = [
      { frame: 0, value: 0 },
      { frame: 10, value: 1 },
    ];
    const layer = rect('a', { motionBlur: { samples: 2, shutter } });
    expect(collectMotionTimes([layer], 0)).toEqual([]);
    expect(collectMotionTimes([layer], 10)).toEqual(motionTimes(10, 2, 1));
    expect(collectMotionTimes([layer], 5)).toEqual(motionTimes(5, 2, 0.5));
  });

  it('names the layer when its samples are out of range', () => {
    expect(() => collectMotionTimes([rect('bad', { motionBlur: { samples: 1 } })], 0)).toThrow(/layer "bad".*samples/);
  });
});

describe('attachMotionFrames', () => {
  const at = (frame: number, layers: LayerJson[], samples = 2, shutter = 1) =>
    new Map(motionTimes(frame, samples, shutter).map((t, i) => [t, layers.map((l) => ({ ...l, i }))]));

  it('fills motionBlur.frames from the trees rendered at the sub-frame times, in time order', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 }, transform: { x: 10 } });
    const [t0, t1] = motionTimes(10, 2, 1) as [number, number];
    const trees = new Map<number, LayerJson[]>([
      [t0, [rect('a', { transform: { x: 9.75 } })]],
      [t1, [rect('a', { transform: { x: 10.25 } })]],
    ]);
    const [out] = attachMotionFrames([blurred], 10, trees);
    expect(out).toEqual({
      ...blurred,
      motionBlur: {
        samples: 2,
        shutter: 1,
        frames: [rect('a', { transform: { x: 9.75 } }), rect('a', { transform: { x: 10.25 } })],
      },
    });
  });

  it('matches by id wherever the layer sits in the sub-frame tree', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 } });
    const [t0, t1] = motionTimes(10, 2, 1) as [number, number];
    const moved = (x: number) => [group('wrapper', [rect('a', { transform: { x } })])];
    const [out] = attachMotionFrames([blurred], 10, new Map([[t0, moved(1)], [t1, moved(2)]])) as [ShapeLayer];
    expect(out.motionBlur?.frames?.map((f) => f.transform?.x)).toEqual([1, 2]);
  });

  it('turns a missing layer into an opacity-0 copy of itself', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 }, opacity: 0.8, transform: { x: 4 } });
    const [t0, t1] = motionTimes(10, 2, 1) as [number, number];
    const trees = new Map<number, LayerJson[]>([
      [t0, [rect('other')]],
      [t1, [rect('a', { opacity: 0.5 })]],
    ]);
    const [out] = attachMotionFrames([blurred], 10, trees) as [ShapeLayer];
    expect(out.motionBlur?.frames?.[0]).toEqual(rect('a', { opacity: 0, transform: { x: 4 } }));
    expect(out.motionBlur?.frames?.[1]).toEqual(rect('a', { opacity: 0.5 }));
  });

  it('treats a layer of another type as missing', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 } });
    const [t0, t1] = motionTimes(10, 2, 1) as [number, number];
    const asGroup = group('a', []);
    const trees = new Map<number, LayerJson[]>([
      [t0, [asGroup]],
      [t1, [rect('a')]],
    ]);
    const [out] = attachMotionFrames([blurred], 10, trees) as [ShapeLayer];
    expect(out.motionBlur?.frames?.[0]).toEqual(rect('a', { opacity: 0 }));
    expect(out.motionBlur?.frames?.[1]).toEqual(rect('a'));
  });

  it('blurs a group with its subtree, and strips nested motionBlur from the copies', () => {
    const tree = (x: number): LayerJson[] => [
      group('g', [rect('inner', { transform: { x }, motionBlur: { samples: 3 } })], { motionBlur: { samples: 2, shutter: 1 } }),
    ];
    const times = motionTimes(10, 2, 1);
    const [out] = attachMotionFrames(tree(10), 10, new Map([[times[0]!, tree(9.5)], [times[1]!, tree(10.5)]])) as [GroupLayer];
    const frames = out.motionBlur?.frames as GroupLayer[];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(group('g', [rect('inner', { transform: { x: 9.5 } })]));
    expect(frames[1]).toEqual(group('g', [rect('inner', { transform: { x: 10.5 } })]));
    expect('motionBlur' in frames[0]!).toBe(false);
  });

  it('reaches blurred layers inside groups that are not blurred, and shares what it did not change', () => {
    const plain = rect('plain');
    const blurred = rect('b', { motionBlur: { samples: 2, shutter: 1 } });
    const input = [plain, group('g', [blurred, rect('c')]), rect('d')];
    const times = motionTimes(7, 2, 1);
    const trees = new Map(times.map((t) => [t, [blurred]] as [number, LayerJson[]]));
    const out = attachMotionFrames(input, 7, trees);
    expect(out[0]).toBe(plain);
    expect(out[2]).toBe(input[2]);
    const g = out[1] as GroupLayer;
    expect((g.children[0] as ShapeLayer).motionBlur?.frames).toHaveLength(2);
    expect(g.children[1]).toBe((input[1] as GroupLayer).children[1]);
  });

  it('does not change its input', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 } });
    const input = [blurred];
    const before = JSON.stringify(input);
    attachMotionFrames(input, 10, at(10, [rect('a')]));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('returns the same layers when nothing is blurred', () => {
    const input = [rect('a'), group('g', [rect('b')])];
    expect(attachMotionFrames(input, 3, new Map())).toBe(input);
  });

  it('skips a layer whose shutter is closed and fills its blurred children', () => {
    const child = rect('inner', { motionBlur: { samples: 2, shutter: 1 } });
    const parent = group('parent', [child], { motionBlur: { samples: 4, shutter: 0 } });
    const times = motionTimes(5, 2, 1);
    const [out] = attachMotionFrames([parent], 5, new Map(times.map((t) => [t, [child]] as [number, LayerJson[]]))) as [GroupLayer];
    expect(out.motionBlur).toEqual({ samples: 4, shutter: 0 });
    expect((out.children[0] as ShapeLayer).motionBlur?.frames).toHaveLength(2);
  });

  it('gives exactly `samples` frames for the default samples too', () => {
    const blurred = rect('a', { motionBlur: {} });
    const times = motionTimes(2, 8, 0.5);
    const trees = new Map(times.map((t) => [t, [rect('a')]] as [number, LayerJson[]]));
    const [out] = attachMotionFrames([blurred], 2, trees) as [ShapeLayer];
    expect(out.motionBlur?.frames).toHaveLength(8);
  });

  it('fails loudly when the frame loop did not render a needed time', () => {
    const blurred = rect('a', { motionBlur: { samples: 2, shutter: 1 } });
    expect(() => attachMotionFrames([blurred], 10, new Map())).toThrow(/no tree was rendered/);
  });

  it('round-trips with collectMotionTimes', () => {
    const layers = [rect('a', { motionBlur: { samples: 3, shutter: 0.75 } }), rect('b', { motionBlur: { samples: 5 } })];
    const trees = new Map(collectMotionTimes(layers, 12).map((t) => [t, layers.map((l) => ({ ...l, opacity: t }))] as [number, LayerJson[]]));
    const out = attachMotionFrames(layers, 12, trees) as ShapeLayer[];
    expect(out[0]?.motionBlur?.frames).toHaveLength(3);
    expect(out[1]?.motionBlur?.frames).toHaveLength(5);
    expect(out[0]?.motionBlur?.frames?.map((f) => (f as ShapeLayer).opacity)).toEqual(motionTimes(12, 3, 0.75));
  });
});

/** A sub-frame as the renderer makes it from `changes` (SCENE.md, "Sub-frame changes"): each changed layer stands in for
 *  the layer of its id, and one that keeps its children keeps the frame's (each still replaced when changed). */
function applyChanges(layer: LayerJson, list: { layer: LayerJson; keepChildren?: boolean }[]): LayerJson {
  const byId = new Map(list.map((c) => [c.layer.id, c]));
  const put = (original: LayerJson): LayerJson => {
    const change = byId.get(original.id);
    const own = change?.layer ?? original;
    if (own.type !== 'group') return own;
    const children = change?.keepChildren && original.type === 'group' ? original.children : own.children;
    return { ...own, children: children.map(put) };
  };
  return put(layer);
}

/** A tree without any motionBlur: the renderer ignores one inside a blurred layer, and a copy has none of its own. */
function unblurred(layer: LayerJson): LayerJson {
  const { motionBlur: _dropped, ...rest } = layer;
  return rest.type === 'group' ? { ...rest, children: rest.children.map(unblurred) } : rest;
}

describe('attachMotionChanges', () => {
  const blur = { samples: 3, shutter: 1 };
  const times = motionTimes(10, 3, 1);
  const trees = (...samples: LayerJson[][]) => new Map(times.map((t, i) => [t, samples[i]!] as [number, LayerJson[]]));

  /** Checks that the changes say what `attachMotionFrames` says, sub-frame by sub-frame, and returns them. */
  function equivalent(main: LayerJson, samples: LayerJson[][]) {
    const [byChanges] = attachMotionChanges([main], 10, trees(...samples));
    const [byFrames] = attachMotionFrames([main], 10, trees(...samples));
    const changes = byChanges!.motionBlur!.changes!;
    expect(changes).toHaveLength(3);
    expect(byChanges!.motionBlur!.frames).toBeUndefined();
    changes.forEach((list, i) => {
      expect(unblurred(applyChanges(byChanges!, list))).toEqual(unblurred(byFrames!.motionBlur!.frames![i]!));
    });
    return changes;
  }

  it('says nothing for a sub-frame that is the frame itself', () => {
    const main = group('g', [rect('a'), rect('b')], { motionBlur: blur });
    const copy = () => [group('g', [rect('a'), rect('b')])];
    expect(equivalent(main, [copy(), copy(), copy()])).toEqual([[], [], []]);
  });

  it('changes only the layers that differ, and a group of its own fields keeps its children', () => {
    const kids = (x: number) => [rect('a', { transform: { x } }), rect('b'), group('inner', [rect('c')])];
    const main = group('g', kids(0), { motionBlur: blur, transform: { x: 5 } });
    const changes = equivalent(main, [
      [group('g', kids(0), { transform: { x: 4 } })],
      [group('g', kids(1), { transform: { x: 5 } })],
      [group('g', kids(0), { transform: { x: 5 }, opacity: 0.5 })],
    ]);
    expect(changes[0]).toEqual([{ layer: group('g', [], { transform: { x: 4 } }), keepChildren: true }]);
    expect(changes[1]).toEqual([{ layer: rect('a', { transform: { x: 1 } }) }]);
    expect(changes[2]).toEqual([{ layer: group('g', [], { transform: { x: 5 }, opacity: 0.5 }), keepChildren: true }]);
  });

  it('replaces a group whole when its children are other layers, or a child changes type', () => {
    const main = group('g', [rect('a'), rect('b')], { motionBlur: blur });
    const changes = equivalent(main, [
      [group('g', [rect('a')])],
      [group('g', [rect('b'), rect('a')])],
      [group('g', [rect('a'), group('b', [])])],
    ]);
    for (const list of changes) {
      expect(list).toHaveLength(1);
      expect(list[0]!.keepChildren).toBeUndefined();
      expect(list[0]!.layer.id).toBe('g');
    }
  });

  it('makes a missing layer or one of another type transparent at that sub-frame', () => {
    const main = group('g', [rect('a')], { motionBlur: blur, opacity: 0.8 });
    const changes = equivalent(main, [[rect('other')], [rect('g')], [group('g', [rect('a')])]]);
    expect(changes[0]).toEqual([{ layer: group('g', [], { opacity: 0 }), keepChildren: true }]);
    const leaf = rect('a', { motionBlur: blur, opacity: 0.8 });
    const [out] = attachMotionChanges([leaf], 10, trees([], [rect('a')], [rect('a')]));
    expect(out!.motionBlur!.changes![0]).toEqual([{ layer: rect('a', { opacity: 0 }) }]);
    expect(out!.motionBlur!.changes![1]).toEqual([{ layer: rect('a') }]);
  });

  it('compares values, not objects, and ignores motionBlur inside the blurred tree', () => {
    const main = group('g', [rect('a', { transform: { x: 1 }, motionBlur: { samples: 4 } })], { motionBlur: blur });
    const fresh = () => [group('g', [rect('a', { transform: { x: 1 } })], { motionBlur: { samples: 3, shutter: 1 } })];
    expect(equivalent(main, [fresh(), fresh(), fresh()])).toEqual([[], [], []]);
  });

  it('leaves the frame itself as it is', () => {
    const main = group('g', [rect('a')], { motionBlur: blur });
    const [out] = attachMotionChanges([main], 10, trees([group('g', [rect('a', { opacity: 0 })])], [main], [main])) as [GroupLayer];
    expect(out.children).toBe(main.children);
    expect(out.motionBlur).toEqual({ ...blur, changes: [[{ layer: rect('a', { opacity: 0 }) }], [], []] });
  });
});
