import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Audio, Layer, Rect, Text } from '@kinetographdev/react';
import { motionSubFrames, type GroupLayer, type ShapeLayer, type TextLayer } from '@kinetographdev/scene';
import { cancelRender, continueRender, delayRender, resetRenderState } from '../src/assets.js';
import {
  Composition,
  Folder,
  getCompositions,
  getInputProps,
  registerRoot,
  resetCompositions,
  setInputProps,
  Still,
} from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { clearFonts, getFonts, registerFont, trackFontLoad } from '../src/font-registry.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { interpolate } from '../src/interpolate.js';
import { Sequence, useCurrentFrame, useVideoConfig } from '../src/timeline.js';

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  clearFonts();
  resetVirtualClock();
});
afterEach(() => {
  uninstallDeterminism();
  resetRenderState();
});

function Mover() {
  const frame = useCurrentFrame();
  return <Rect id="mover" width={10} height={10} fill="#fff" x={frame * 10} />;
}

function Hello({ label = 'hi' }: { label?: string }) {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  return (
    <>
      <Text id="label" font="Inter" size={40}>
        {`${label} ${frame}`}
      </Text>
      <Rect id="w" width={width} height={1} fill="#000" />
    </>
  );
}

function registerOne(extra: Record<string, unknown> = {}) {
  registerRoot(() => (
    <>
      <Composition id="Main" component={Hello} width={640} height={360} fps={30} durationInFrames={60} defaultProps={{ label: 'hello' }} {...extra} />
      <Folder name="more">
        <Composition id="Mover" component={Mover} width={100} height={50} fps={24} durationInFrames={10} />
        <Still id="Poster" component={Hello} width={200} height={100} />
      </Folder>
    </>
  ));
}

describe('compositions', () => {
  it('finds them by rendering the Root', () => {
    registerOne();
    expect(getCompositions()).toEqual([
      { id: 'Main', width: 640, height: 360, fps: 30, durationInFrames: 60, defaultProps: { label: 'hello' } },
      { id: 'Mover', width: 100, height: 50, fps: 24, durationInFrames: 10, defaultProps: {} },
      { id: 'Poster', width: 200, height: 100, fps: 30, durationInFrames: 1, defaultProps: {} },
    ]);
  });

  it('needs a root', () => {
    expect(() => getCompositions()).toThrow(/registerRoot/);
  });

  it('rejects a duplicate id, a bad id and bad numbers', () => {
    registerRoot(() => (
      <>
        <Composition id="A" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />
        <Composition id="A" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />
      </>
    ));
    expect(() => getCompositions()).toThrow(/Multiple composition with id "A"/);

    registerRoot(() => <Composition id="a b" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />);
    expect(() => getCompositions()).toThrow(/can only contain/);

    registerRoot(() => <Composition id="B" component={Hello} width={10.5} height={10} fps={30} durationInFrames={5} />);
    expect(() => getCompositions()).toThrow(/"width".*positive integer/);

    registerRoot(() => <Composition id="C" component={Hello} width={10} height={10} fps={30} durationInFrames={0} />);
    expect(() => getCompositions()).toThrow(/"durationInFrames"/);
  });

  it('keeps the input props', () => {
    expect(getInputProps()).toEqual({});
    setInputProps({ a: 1 });
    expect(getInputProps()).toEqual({ a: 1 });
  });
});

describe('the frame loop', () => {
  it('renders a composition frame into a complete scene', async () => {
    registerOne();
    registerFont({ family: 'Inter', path: '/f/Inter.ttf' });
    const renderer = createFrameRenderer('Main');
    expect(renderer.config).toMatchObject({ id: 'Main', width: 640, height: 360, fps: 30, durationInFrames: 60 });
    const { scene, audio } = await renderer.renderFrame(7);
    expect(audio).toEqual([]);
    expect(scene).toMatchObject({
      width: 640,
      height: 360,
      fps: 30,
      durationInFrames: 60,
      background: 'transparent',
      fonts: { Inter: '/f/Inter.ttf' },
    });
    expect((scene.layers[0] as TextLayer).text).toBe('hello 7');
    expect((scene.layers[1] as ShapeLayer).shape).toMatchObject({ kind: 'rect', width: 640 });
    expect(scene.camera).toBeUndefined();
    renderer.dispose();
  });

  it('puts the composition\'s margin in every frame\'s scene, and none when it has none', async () => {
    registerRoot(() => (
      <>
        <Composition id="Pinned" component={Mover} width={100} height={50} fps={24} durationInFrames={10} margin={44} />
        <Composition
          id="Lazy"
          lazyComponent={async () => ({ default: Mover })}
          width={100}
          height={50}
          fps={24}
          durationInFrames={10}
          margin={0}
          calculateMetadata={async () => ({ width: 64 })}
        />
        <Composition id="Plain" component={Mover} width={100} height={50} fps={24} durationInFrames={10} />
      </>
    ));
    const pinned = createFrameRenderer('Pinned');
    for (const frame of [0, 7, 3]) {
      const { scene } = await pinned.renderFrame(frame);
      expect(scene.margin).toBe(44);
      // It is the field of the JSON the engine reads, so it survives the trip through a string.
      expect(JSON.parse(JSON.stringify(scene)).margin).toBe(44);
    }
    // A margin of 0 is still sent, and a lazy component with async metadata keeps it.
    expect((await createFrameRenderer('Lazy').renderFrame(1)).scene.margin).toBe(0);
    const { scene } = await createFrameRenderer('Plain').renderFrame(1);
    expect('margin' in scene).toBe(false);
  });

  it('rejects a margin that is not a whole number of pixels', () => {
    for (const margin of [-1, 4.5, Number.NaN, '4']) {
      registerRoot(() => (
        <Composition id="M" component={Mover} width={10} height={10} fps={30} durationInFrames={5} margin={margin as number} />
      ));
      expect(() => getCompositions()).toThrow(/"margin" of composition "M".*whole number/);
    }
  });

  it('takes a margin from calculateMetadata over the prop, worked out from the props', async () => {
    registerRoot(() => (
      <>
        <Composition
          id="FromProps"
          component={Mover}
          width={100}
          height={50}
          fps={24}
          durationInFrames={10}
          margin={44}
          defaultProps={{ shadow: 60 }}
          calculateMetadata={({ props }) => ({ margin: props.shadow as number })}
        />
        <Composition
          id="Async"
          component={Mover}
          width={100}
          height={50}
          fps={24}
          durationInFrames={10}
          calculateMetadata={async () => ({ margin: 12 })}
        />
        <Composition
          id="Bad"
          component={Mover}
          width={100}
          height={50}
          fps={24}
          durationInFrames={10}
          calculateMetadata={async () => ({ margin: 4.5 })}
        />
      </>
    ));
    const fromProps = createFrameRenderer('FromProps');
    for (const frame of [0, 7, 3]) expect((await fromProps.renderFrame(frame)).scene.margin).toBe(60);
    expect((await createFrameRenderer('FromProps', { inputProps: { shadow: 30 } }).renderFrame(1)).scene.margin).toBe(30);
    expect((await createFrameRenderer('Async').renderFrame(1)).scene.margin).toBe(12);
    await expect(createFrameRenderer('Bad').renderFrame(0)).rejects.toThrow(/"margin" of composition "Bad".*whole number/);
    // The margin is a render setting, not part of the compositions listing.
    expect(getCompositions().find((c) => c.id === 'FromProps')).not.toHaveProperty('margin');
  });

  it('puts the composition\'s background in every frame\'s scene, transparent when it has none', async () => {
    registerRoot(() => (
      <>
        <Composition id="Dark" component={Mover} width={100} height={50} fps={24} durationInFrames={10} background="#14161c" />
        <Composition
          id="Lazy"
          lazyComponent={async () => ({ default: Mover })}
          width={100}
          height={50}
          fps={24}
          durationInFrames={10}
          background="white"
          calculateMetadata={async () => ({ width: 64 })}
        />
        <Composition id="Plain" component={Mover} width={100} height={50} fps={24} durationInFrames={10} />
      </>
    ));
    const dark = createFrameRenderer('Dark');
    for (const frame of [0, 7, 3]) {
      const { scene } = await dark.renderFrame(frame);
      expect(scene.background).toBe('#14161c');
      expect(JSON.parse(JSON.stringify(scene)).background).toBe('#14161c');
    }
    expect((await createFrameRenderer('Lazy').renderFrame(1)).scene.background).toBe('white');
    expect((await createFrameRenderer('Plain').renderFrame(1)).scene.background).toBe('transparent');
  });

  it('rejects a background that is not a colour string', () => {
    for (const background of ['', 0x14161c, null]) {
      registerRoot(() => (
        <Composition id="B" component={Mover} width={10} height={10} fps={30} durationInFrames={5} background={background as string} />
      ));
      expect(() => getCompositions()).toThrow(/"background" of composition "B".*colour string/);
    }
  });

  it('passes input props over the defaults', async () => {
    registerOne();
    const renderer = createFrameRenderer('Main', { inputProps: { label: 'override' } });
    const { scene } = await renderer.renderFrame(0);
    expect((scene.layers[0] as TextLayer).text).toBe('override 0');
    expect(renderer.config.props).toEqual({ label: 'override' });
    expect(renderer.config.defaultProps).toEqual({ label: 'hello' });
  });

  it('renders frames in any order, starting over when it goes back', async () => {
    registerOne();
    const renderer = createFrameRenderer('Main');
    const texts = [];
    for (const f of [5, 6, 2, 59]) texts.push(((await renderer.renderFrame(f)).scene.layers[0] as TextLayer).text);
    expect(texts).toEqual(['hello 5', 'hello 6', 'hello 2', 'hello 59']);
  });

  it('rejects a frame outside the composition', async () => {
    registerOne();
    const renderer = createFrameRenderer('Main');
    await expect(renderer.renderFrame(60)).rejects.toThrow(/outside composition "Main"/);
    await expect(renderer.renderFrame(-1)).rejects.toThrow(RangeError);
    await expect(renderer.renderFrame(1.5)).rejects.toThrow(RangeError);
  });

  it('names the composition that does not exist', () => {
    registerOne();
    expect(() => createFrameRenderer('Nope')).toThrow(/No composition with the id "Nope".*"Main"/);
  });

  it('resolves calculateMetadata, which may be async, and lazy components', async () => {
    registerRoot(() => (
      <>
        <Composition
          id="Sync"
          component={Hello}
          width={10}
          height={10}
          fps={30}
          durationInFrames={5}
          calculateMetadata={({ props }) => ({ durationInFrames: 20, props: { ...props, label: 'meta' } })}
        />
        <Composition
          id="Async"
          lazyComponent={async () => ({ default: Hello })}
          width={10}
          height={10}
          fps={30}
          durationInFrames={5}
          calculateMetadata={async () => ({ width: 64, fps: 60 })}
        />
      </>
    ));
    const sync = createFrameRenderer('Sync');
    expect(sync.config.durationInFrames).toBe(20);
    expect(((await sync.renderFrame(19)).scene.layers[0] as TextLayer).text).toBe('meta 19');

    const async_ = createFrameRenderer('Async');
    expect(() => async_.config).toThrow(/await renderer.ready/);
    expect(await async_.ready()).toMatchObject({ width: 64, fps: 60, durationInFrames: 5 });
    const { scene } = await async_.renderFrame(2);
    expect(scene).toMatchObject({ width: 64, height: 10, fps: 60 });
  });

  it('shows Sequence timing in the scene', async () => {
    registerRoot(() => (
      <Composition
        id="Seq"
        width={10}
        height={10}
        fps={30}
        durationInFrames={30}
        component={() => (
          <Sequence from={10} durationInFrames={5}>
            <Mover />
          </Sequence>
        )}
      />
    ));
    const renderer = createFrameRenderer('Seq');
    expect((await renderer.renderFrame(5)).scene.layers).toEqual([]);
    const layers = (await renderer.renderFrame(12)).scene.layers as GroupLayer[];
    expect(layers[0]!.type).toBe('group');
    expect((layers[0]!.children[0] as ShapeLayer).transform?.x).toBe(20);
  });

  it('returns the Sequences of the frame, showing or not', async () => {
    registerRoot(() => (
      <Composition
        id="Seq"
        width={10}
        height={10}
        fps={30}
        durationInFrames={30}
        component={() => (
          <Sequence name="pop" from={10} durationInFrames={5}>
            <Mover />
          </Sequence>
        )}
      />
    ));
    const renderer = createFrameRenderer('Seq');
    const entry = { key: '/pop@10+5', name: 'pop', from: 10, durationInFrames: 5, parent: null };
    expect((await renderer.renderFrame(5)).sequences).toEqual([{ ...entry, layer: null }]);
    expect((await renderer.renderFrame(12)).sequences).toEqual([{ ...entry, layer: '$0' }]);
  });

  it('carries camera and audio from the tree', async () => {
    registerRoot(() => (
      <Composition
        id="Av"
        width={10}
        height={10}
        fps={30}
        durationInFrames={30}
        component={() => (
          <Layer>
            <Audio src="/a.wav" id="music" />
          </Layer>
        )}
      />
    ));
    const { audio } = await createFrameRenderer('Av').renderFrame(3);
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ id: 'music', src: '/a.wav', from: 0 });
  });
});

describe('waiting', () => {
  it('waits for delayRender handles and renders again from the state they set', async () => {
    function Loader() {
      const [name, setName] = useState('loading');
      useEffect(() => {
        const handle = delayRender('load name');
        void Promise.resolve().then(async () => {
          await new Promise((r) => setImmediate(r));
          setName('loaded');
          continueRender(handle);
        });
      }, []);
      return <Text id="t" font="Inter" size={10}>{name}</Text>;
    }
    registerRoot(() => <Composition id="L" component={Loader} width={10} height={10} fps={30} durationInFrames={5} />);
    const { scene } = await createFrameRenderer('L').renderFrame(0);
    expect((scene.layers[0] as TextLayer).text).toBe('loaded');
  });

  it('fails the frame when a handle is never continued', async () => {
    function Stuck() {
      useEffect(() => {
        delayRender('forever', { timeoutInMilliseconds: 40 });
      }, []);
      return null;
    }
    registerRoot(() => <Composition id="S" component={Stuck} width={10} height={10} fps={30} durationInFrames={5} />);
    await expect(createFrameRenderer('S').renderFrame(0)).rejects.toThrow(/"forever" was called but not cleared after 40ms/);
  });

  it('fails with the error given to cancelRender', async () => {
    function Bad() {
      useEffect(() => {
        cancelRender(new Error('the data is gone'));
      }, []);
      return null;
    }
    registerRoot(() => <Composition id="B" component={Bad} width={10} height={10} fps={30} durationInFrames={5} />);
    await expect(createFrameRenderer('B').renderFrame(0)).rejects.toThrow('the data is gone');
  });

  it('reports cancelRender rather than the crash that followed it', async () => {
    function Bad(): null {
      cancelRender('no data');
      throw new Error('cannot read properties of undefined');
    }
    registerRoot(() => <Composition id="B" component={Bad} width={10} height={10} fps={30} durationInFrames={5} />);
    await expect(createFrameRenderer('B').renderFrame(0)).rejects.toThrow('no data');
  });

  it('waits for font downloads before the first frame', async () => {
    let release!: () => void;
    const download = new Promise<void>((resolve) => {
      release = () => {
        registerFont({ family: 'Late', path: '/late.ttf' });
        resolve();
      };
    });
    trackFontLoad(download);
    registerRoot(() => <Composition id="F" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />);
    const rendering = createFrameRenderer('F').renderFrame(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(getFonts()).toEqual({});
    release();
    const { scene } = await rendering;
    expect(scene.fonts).toEqual({ Late: '/late.ttf' });
  });

  it('fails when a font download failed', async () => {
    trackFontLoad(Promise.reject(new Error('font offline')));
    registerRoot(() => <Composition id="F" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />);
    await expect(createFrameRenderer('F').renderFrame(0)).rejects.toThrow('font offline');
  });
});

describe('the determinism shim in a render', () => {
  it('drives Date, Math.random and timers from the frame', async () => {
    installDeterminism();
    function Clock() {
      const [ticks, setTicks] = useState(0);
      useEffect(() => {
        const id = setInterval(() => setTicks((t) => t + 1), 100);
        return () => clearInterval(id);
      }, []);
      return (
        <Text id="c" font="Inter" size={10}>
          {`${new Date().toISOString().slice(11, 23)} ${ticks} ${Math.random().toFixed(6)}`}
        </Text>
      );
    }
    registerRoot(() => <Composition id="C" component={Clock} width={10} height={10} fps={30} durationInFrames={90} />);
    const textAt = async (r: ReturnType<typeof createFrameRenderer>, f: number) =>
      ((await r.renderFrame(f)).scene.layers[0] as TextLayer).text;

    const a = createFrameRenderer('C');
    const first = [await textAt(a, 0), await textAt(a, 15), await textAt(a, 30), await textAt(a, 45)];
    expect(first.map((t) => t.split(' ')[0])).toEqual(['00:00:00.000', '00:00:00.500', '00:00:01.000', '00:00:01.500']);
    // 100 ms interval: the state a frame shows is what the interval had counted by then.
    expect(first.map((t) => t.split(' ')[1])).toEqual(['0', '5', '10', '15']);

    // Rendering the same frames again, even after going back, gives the same text.
    const b = createFrameRenderer('C');
    const second = [await textAt(b, 45), await textAt(b, 15)];
    expect(second[0]!.split(' ')[0]).toBe('00:00:01.500');
    expect(second[0]!.split(' ')[2]).toBe(first[3]!.split(' ')[2]);
    expect(second[1]).toBe(first[1]);
  });
});

describe('motion blur', () => {
  function Blurred() {
    const frame = useCurrentFrame();
    const x = interpolate(frame, [0, 10], [0, 100]);
    return (
      <Layer id="blurred" motionBlur={{ samples: 4, shutter: 1 }}>
        <Rect id="box" width={10} height={10} fill="#fff" x={x} />
      </Layer>
    );
  }

  it('renders the composition at each sub-frame time and attaches the trees', async () => {
    registerRoot(() => <Composition id="MB" component={Blurred} width={50} height={50} fps={30} durationInFrames={20} />);
    const renderer = createFrameRenderer('MB');
    const { scene } = await renderer.renderFrame(5);
    const layer = scene.layers[0] as GroupLayer;
    expect(layer.motionBlur?.samples).toBe(4);
    const frames = motionSubFrames(layer) as GroupLayer[];
    expect(frames).toHaveLength(4);
    // t_i = 5 + 1 * ((i + 0.5) / 4 - 0.5)  ->  4.625, 4.875, 5.125, 5.375; x = 10 * t
    const xs = frames.map((f) => (f.children[0] as ShapeLayer).transform!.x as number);
    expect(xs.map((x) => Math.round(x * 1000) / 1000)).toEqual([46.25, 48.75, 51.25, 53.75]);
    // The layer itself is the frame's own state.
    expect(((layer.children[0] as ShapeLayer).transform!.x as number)).toBeCloseTo(50, 9);
  });

  it('leaves frames without motion blur alone and keeps the main tree after sub-frames', async () => {
    registerRoot(() => <Composition id="MB" component={Blurred} width={50} height={50} fps={30} durationInFrames={20} />);
    const renderer = createFrameRenderer('MB');
    const a = await renderer.renderFrame(0);
    const b = await renderer.renderFrame(1);
    expect(((b.scene.layers[0] as GroupLayer).children[0] as ShapeLayer).transform!.x).toBeCloseTo(10, 9);
    expect(a.scene.layers).toHaveLength(1);
  });

  it('keeps Math.random() on the frame while the clock sits on a sub-frame', async () => {
    installDeterminism();
    const draws: number[] = [];
    function Jitter() {
      draws.push(Math.random());
      return (
        <Layer id="j" motionBlur={{ samples: 2, shutter: 1 }}>
          <Rect id="r" width={1} height={1} fill="#fff" />
        </Layer>
      );
    }
    registerRoot(() => <Composition id="J" component={Jitter} width={5} height={5} fps={30} durationInFrames={10} />);
    await createFrameRenderer('J').renderFrame(4);
    // The first render is the frame-0 priming render; then the frame itself and its two sub-frames.
    const [, main, ...sub] = draws;
    expect(sub).toHaveLength(2);
    expect(sub).toEqual([main, main]);
  });
});
