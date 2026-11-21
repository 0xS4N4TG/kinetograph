import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Audio, Layer, Rect, Text } from '@kinetographdev/react';
import { motionSubFrames, type GroupLayer, type ShapeLayer, type TextLayer } from '@kinetographdev/scene';
import { cancelRender, continueRender, delayRender, resetRenderState } from '../src/assets.js';
import {
  Composition,
  Folder,
  getCompositions,
  getInputProps,
  isRemotionPage,
  registerRoot,
  resetCompositions,
  setRemotionPage,
  setInputProps,
  Still,
} from '../src/compositions.js';
import { importedStylesheets, setDomAddon } from '@kinetographdev/compat/dom';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import { clearFonts, getFonts, registerFont, trackFontLoad } from '../src/font-registry.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { GSAP_REGISTRY } from '../src/gsap-clock.js';
import { makeGoogleFont } from '../src/google-fonts.js';
import { measureText, setLayoutText } from '../src/layout-utils.js';
import { AbsoluteFill } from '../src/fill.js';
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

  it('blends in sRGB unless the composition asks for linear light', async () => {
    registerRoot(() => (
      <>
        <Composition id="Default" component={Mover} width={100} height={50} fps={24} durationInFrames={10} />
        <Composition id="Srgb" component={Mover} width={100} height={50} fps={24} durationInFrames={10} blendSpace="srgb" />
        <Composition id="Linear" component={Mover} width={100} height={50} fps={24} durationInFrames={10} blendSpace="linear" />
      </>
    ));
    // The engine's default is sRGB, so the scene says nothing unless it asks for linear.
    expect('blendSpace' in (await createFrameRenderer('Default').renderFrame(1)).scene).toBe(false);
    expect('blendSpace' in (await createFrameRenderer('Srgb').renderFrame(1)).scene).toBe(false);
    expect((await createFrameRenderer('Linear').renderFrame(1)).scene.blendSpace).toBe('linear');
    registerRoot(() => <Composition id="Bad" component={Mover} width={10} height={10} fps={30} durationInFrames={5} blendSpace={'p3' as 'srgb'} />);
    expect(() => getCompositions()).toThrow(/"blendSpace" of composition "Bad"/);
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

  it('leaves a frame with no background and a plain AbsoluteFill with nothing opaque to composite (alpha output)', async () => {
    registerRoot(() => (
      <Composition
        id="Overlay"
        component={() => (
          <AbsoluteFill>
            <Rect id="lower-third" width={40} height={10} fill="#fff" />
          </AbsoluteFill>
        )}
        width={100}
        height={50}
        fps={24}
        durationInFrames={10}
      />
    ));
    const { scene } = await createFrameRenderer('Overlay').renderFrame(2);
    // The scene says "transparent" (the engine draws it as no colour), as it is JSON, so a worker sees the same.
    expect(JSON.parse(JSON.stringify(scene)).background).toBe('transparent');
    // The AbsoluteFill is one group holding only the author's layer: no full-size rect painted under it.
    const [fill, ...rest] = scene.layers as GroupLayer[];
    expect(rest).toEqual([]);
    expect(fill!.type).toBe('group');
    expect((fill!.children ?? []).map((c) => (c as ShapeLayer).id)).toEqual(['lower-third']);
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

  it('lets calculateMetadata supply fps and durationInFrames', async () => {
    registerRoot(() => (
      <>
        <Composition
          id="Late"
          component={Hello}
          width={10}
          height={10}
          calculateMetadata={async () => ({ fps: 25, durationInFrames: 50 })}
        />
        <Composition id="Half" component={Hello} width={10} height={10} fps={24} calculateMetadata={() => ({ durationInFrames: 8 })} />
        <Composition id="None" component={Hello} width={10} height={10} calculateMetadata={() => ({ fps: 30 })} />
      </>
    ));
    expect(await createFrameRenderer('Late').ready()).toMatchObject({ fps: 25, durationInFrames: 50 });
    expect(await createFrameRenderer('Half').ready()).toMatchObject({ fps: 24, durationInFrames: 8 });
    expect(() => createFrameRenderer('None')).toThrow(/"durationInFrames" of composition "None".*calculateMetadata/);
  });

  it('marks a composition whose fps or length is left to calculateMetadata as pending', () => {
    registerRoot(() => (
      <>
        <Composition id="Late" component={Hello} width={10} height={10} calculateMetadata={() => ({ fps: 25, durationInFrames: 50 })} />
        <Composition id="Plain" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />
      </>
    ));
    const [late, plain] = getCompositions();
    expect(late!.metadataPending).toBe(true);
    expect(plain).not.toHaveProperty('metadataPending');
  });

  it('still rejects a missing fps or durationInFrames when nothing calculates them', () => {
    registerRoot(() => <Composition id="NoFps" component={Hello} width={10} height={10} durationInFrames={5} />);
    expect(() => getCompositions()).toThrow(/"fps" of composition "NoFps"/);
    registerRoot(() => <Composition id="NoDur" component={Hello} width={10} height={10} fps={30} />);
    expect(() => getCompositions()).toThrow(/"durationInFrames" of composition "NoDur"/);
  });

  it('holds the frame for loadFont().waitUntilDone() in a delayRender, then measures a weight that was not loaded', async () => {
    const faces = (weights: number[]) =>
      weights
        .map((w) => `@font-face { font-family: 'IBM Plex Sans'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/plex-${w}.ttf) format('truetype'); }`)
        .join('\n');
    const fetch = async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => faces([500, 600]),
      arrayBuffer: async () => new Uint8Array([1, 2, 3, url.length]).buffer,
    });
    const font = makeGoogleFont('IBMPlexSans', { fetch, cacheDir: mkdtempSync(join(tmpdir(), 'kg-plex-')) });
    setLayoutText((request) => ({ width: request.text.length * request.size, height: request.size, lines: [], glyphs: [] }));
    function WaitForFonts({ children }: { children: React.ReactNode }) {
      const [ready, setReady] = useState(false);
      const [handle] = useState(() => delayRender('fonts'));
      useEffect(() => {
        font.loadFont('normal', { weights: ['500', '600'] }).waitUntilDone().then(() => setReady(true), cancelRender);
      }, []);
      useEffect(() => {
        if (ready) continueRender(handle);
      }, [ready, handle]);
      return ready ? <>{children}</> : null;
    }
    const Measured = () => <Rect id="m" width={measureText({ text: 'abcd', fontFamily: 'IBM Plex Sans', fontWeight: 400, fontSize: 10 }).width} height={1} fill="#fff" />;
    registerRoot(() => (
      <Composition id="Gate" width={100} height={20} fps={30} durationInFrames={2} component={() => <WaitForFonts><Measured /></WaitForFonts>} />
    ));
    try {
      const { scene } = await createFrameRenderer('Gate').renderFrame(0);
      expect(scene.layers).toHaveLength(1);
      expect(JSON.stringify(scene.layers[0])).toContain('"width":40');
    } finally {
      setLayoutText(null);
    }
  });

  it('fails the frame at once when a component throws after the delayRender it holds, instead of waiting for its timeout', async () => {
    function Late() {
      const [ready, setReady] = useState(false);
      const [handle] = useState(() => delayRender('late'));
      useEffect(() => {
        void Promise.resolve().then(() => setReady(true));
      }, []);
      if (ready) throw new Error('boom after the effect');
      return <Rect id="r" width={1} height={1} fill="#fff" />;
    }
    registerRoot(() => <Composition id="Late" width={10} height={10} fps={30} durationInFrames={2} component={Late} />);
    await expect(createFrameRenderer('Late').renderFrame(0)).rejects.toThrow(/boom after the effect/);
  });

  it('lays Remotion\'s default CSS (box-sizing: border-box on every element) under a project\'s styles', async () => {
    registerOne();
    await createFrameRenderer('Main').renderFrame(0);
    expect(importedStylesheets()[0]).toBe('* { box-sizing: border-box; }');
  });

  it('sends the default CSS whether a render starts at frame 0 or part way, so a range and a full render agree', async () => {
    const sent: { stylesheets: string[]; path: string }[] = [];
    setDomAddon({
      renderDomIsland(json: string) {
        const request = JSON.parse(json);
        sent.push({ stylesheets: request.stylesheets, path: request.path });
        return JSON.stringify({ layers: [{ id: request.path, type: 'group', children: [] }], unsupported: [], camera: null });
      },
    });
    try {
      registerRoot(() => (
        <Composition id="Box" width={100} height={50} fps={30} durationInFrames={20} component={() => <div style={{ width: '100%', padding: 8 }}>box</div>} />
      ));
      const lastSheets = async (frames: number[]) => {
        sent.length = 0;
        const renderer = createFrameRenderer('Box');
        for (const frame of frames) await renderer.renderFrame(frame);
        renderer.dispose();
        return sent.map((request) => request.stylesheets);
      };
      const full = await lastSheets([0, 1, 2, 3, 4, 5]);
      const part = await lastSheets([5]);
      const defaultCss = '* { box-sizing: border-box; }';
      expect(full.length).toBeGreaterThan(0);
      expect(part.length).toBeGreaterThan(0);
      for (const sheets of [...full, ...part]) expect(sheets).toEqual([defaultCss]);
    } finally {
      setDomAddon(null);
    }
  });

  it('leaves a page that is not a Remotion composition (HyperFrames, plain HTML) in the browser\'s content-box', async () => {
    registerOne();
    setRemotionPage(false);
    try {
      await createFrameRenderer('Main').renderFrame(0);
      expect(importedStylesheets()).not.toContain('* { box-sizing: border-box; }');
    } finally {
      setRemotionPage(true);
    }
  });

  it('starts every entry as a Remotion page, so a Remotion project loaded after a HyperFrames one gets border-box again', () => {
    setRemotionPage(false);
    registerRoot(() => <Composition id="A" component={Hello} width={10} height={10} fps={30} durationInFrames={5} />);
    expect(isRemotionPage()).toBe(true);
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

  it('holds frame 0 for a handle opened before any frame, as at module scope', async () => {
    let ready = false;
    const handle = delayRender('init');
    setTimeout(() => {
      ready = true;
      continueRender(handle);
    }, 5);
    // A plain variable, not state: nothing renders again when it changes, so the first render has to come after it.
    function Wasm() {
      return <Text id="t" font="Inter" size={10}>{ready ? 'ready' : 'empty'}</Text>;
    }
    registerRoot(() => <Composition id="W" component={Wasm} width={10} height={10} fps={30} durationInFrames={5} />);
    const { scene } = await createFrameRenderer('W').renderFrame(0);
    expect((scene.layers[0] as TextLayer).text).toBe('ready');
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

  it('runs requestAnimationFrame callbacks after the frame renders, so what they set is in that frame', async () => {
    installDeterminism();
    let drawn = '';
    function Raf() {
      const frame = useCurrentFrame();
      useEffect(() => {
        (globalThis as any).requestAnimationFrame((t: number) => {
          drawn = `${frame}@${Math.round(t)}`;
        });
      });
      return <Text id="c" font="Inter" size={10}>{`f${frame}`}</Text>;
    }
    registerRoot(() => <Composition id="R" component={Raf} width={10} height={10} fps={30} durationInFrames={90} />);
    const r = createFrameRenderer('R');
    await r.renderFrame(3);
    // Not at the start of frame 4, and in a frame rendered alone as well as in a sequence.
    expect(drawn).toBe('3@100');
    await r.renderFrame(4);
    expect(drawn).toBe('4@133');
  });

  it('gives a loop in requestAnimationFrame the frames a jump skips, so a frame is the same alone and in sequence', async () => {
    installDeterminism();
    let seen: number[] = [];
    function Loop() {
      useEffect(() => {
        const g = globalThis as any;
        let id = 0;
        const tick = (t: number) => {
          seen.push(Math.round(t));
          id = g.requestAnimationFrame(tick);
        };
        id = g.requestAnimationFrame(tick);
        // A loop that cleans up when it unmounts, as a loop should: starting a scene over does not carry it along.
        return () => g.cancelAnimationFrame(id);
      }, []);
      return <Text id="c" font="Inter" size={10}>x</Text>;
    }
    registerRoot(() => <Composition id="J" component={Loop} width={10} height={10} fps={30} durationInFrames={90} />);
    const sequence = createFrameRenderer('J');
    for (let f = 0; f <= 5; f++) await sequence.renderFrame(f);
    const inSequence = seen;
    seen = [];
    sequence.dispose();
    await createFrameRenderer('J').renderFrame(5);
    expect(seen).toEqual(inSequence);
    expect(seen).toEqual([0, 33, 67, 100, 133, 167]);
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

// A WebGL canvas that holds render targets: a target a frame reads before it overwrites is what the frames before it
// drew (packages/scene/src/webgl-carry.ts), so frame N has to be the same alone, after the frames before it, and as the
// first of a chunk that starts after frame 0.
const VERT = 'attribute vec2 p; varying vec2 v; uniform vec4 box; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(box.xy + p * box.zw, 0.0, 1.0); }';
const FRAG = 'precision mediump float; varying vec2 v; uniform float t; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, v) * 0.5 + vec4(t * 0.1, v, 1.0) * 0.5; }';

/** A program, a quad, and a 4 by 4 texture with a framebuffer, made once for a canvas. */
function glSetup(gl: any) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const set = (name: string, ...v: number[]) => (v.length === 1 ? gl.uniform1f(gl.getUniformLocation(program, name), v[0]) : gl.uniform4f(gl.getUniformLocation(program, name), v[0], v[1], v[2], v[3]));
  return { framebuffer, texture, set };
}

/** Adds a sprite to the target (blended over what it holds), at a place that moves with `t`. */
function glSprite(gl: any, g: ReturnType<typeof glSetup>, t: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, g.framebuffer);
  gl.viewport(0, 0, 4, 4);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  g.set('t', t);
  g.set('box', -0.5 + (t % 4) * 0.25, 0, 0.25, 0.25);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/** Draws the target over the canvas. */
function glShow(gl: any, g: ReturnType<typeof glSetup>) {
  gl.viewport(0, 0, 64, 64);
  gl.bindTexture(gl.TEXTURE_2D, g.texture);
  g.set('t', 0);
  g.set('box', 0, 0, 1, 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/** The frames the components below rendered (a frame is added when its component renders). */
const rendered = new Set<number>();

/** A target that every frame adds a sprite to (a trail), and shows. */
function GlTrail() {
  const frame = useCurrentFrame();
  rendered.add(frame);
  const ref = useRef<any>(null);
  const state = useRef<ReturnType<typeof glSetup> | null>(null);
  useEffect(() => {
    const gl = ref.current.getContext('webgl');
    state.current ??= glSetup(gl);
    glSprite(gl, state.current, frame);
    glShow(gl, state.current);
  }, [frame]);
  return <canvas ref={ref} width={64} height={64} />;
}

/** A trail on a page with a CSS transition, whose frames that do not follow the one before are drawn from a replay of the transition window. */
function GlTrailFade() {
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 4, height: 4, background: '#f00', transition: 'opacity 1s linear' }} />
      <GlTrail />
    </>
  );
}

const VERT_FULL = 'attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';

/** Two targets, and a program that draws over the clip square (a pass that covers its target). */
function glPair(gl: any) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT_FULL], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  const target = () => {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer };
  };
  return { program, targets: [target(), target()] };
}

/** A pair of targets that swap roles each frame (a ping-pong, as GPUComputationRenderer does): the frame draws one from the other, and shows it. */
function GlParity() {
  const frame = useCurrentFrame();
  rendered.add(frame);
  const ref = useRef<any>(null);
  const state = useRef<ReturnType<typeof glPair> | null>(null);
  useEffect(() => {
    const gl = ref.current.getContext('webgl');
    state.current ??= glPair(gl);
    const { program, targets } = state.current;
    const [from, to] = frame % 2 === 0 ? [targets[0]!, targets[1]!] : [targets[1]!, targets[0]!];
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.framebuffer);
    gl.viewport(0, 0, 4, 4);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1f(gl.getUniformLocation(program, 't'), frame);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, 64, 64);
    gl.bindTexture(gl.TEXTURE_2D, to.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }, [frame]);
  return <canvas ref={ref} width={64} height={64} />;
}

/** The trail, in a layer that is motion blurred: its sub-frames render the canvas again at their own times. */
function GlTrailBlurred() {
  return (
    <Layer id="blurred" motionBlur={{ samples: 2, shutter: 1 }}>
      <GlTrail />
    </Layer>
  );
}

/** A target that the first frame adds more sprites to than a target keeps draws for, and every frame shows. */
function GlHeavy() {
  const frame = useCurrentFrame();
  const ref = useRef<any>(null);
  const state = useRef<ReturnType<typeof glSetup> | null>(null);
  useEffect(() => {
    const gl = ref.current.getContext('webgl');
    state.current ??= glSetup(gl);
    if (frame === 0) for (let i = 0; i < 1100; i++) glSprite(gl, state.current, i);
    glShow(gl, state.current);
  }, [frame]);
  return <canvas ref={ref} width={64} height={64} />;
}

/** A target drawn once when the component mounts, and shown by every frame. */
function GlMounted() {
  const frame = useCurrentFrame();
  rendered.add(frame);
  const ref = useRef<any>(null);
  const state = useRef<ReturnType<typeof glSetup> | null>(null);
  useEffect(() => {
    const gl = ref.current.getContext('webgl');
    state.current = glSetup(gl);
    glSprite(gl, state.current, 3);
  }, []);
  useEffect(() => {
    glShow(ref.current.getContext('webgl'), state.current!);
  }, [frame]);
  return <canvas ref={ref} width={64} height={64} />;
}

/** A canvas drawn once when the component mounts and left alone (a page that draws when its controls change). */
function GlOnce() {
  const ref = useRef<any>(null);
  useEffect(() => {
    const gl = ref.current.getContext('webgl');
    const g = glSetup(gl);
    glSprite(gl, g, 3);
    glShow(gl, g);
  }, []);
  return <canvas ref={ref} width={64} height={64} />;
}

/** The glsl layers of a frame, as JSON with the ids a context numbers its textures with counted from 0. */
function glsl(layers: unknown): { json: string; ops: number } {
  const found: any[] = [];
  const walk = (value: any): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') {
      if (value.type === 'glsl') found.push(value);
      Object.values(value).forEach(walk);
    }
  };
  walk(layers);
  const ids = new Map<string, number>();
  const json = JSON.stringify(found).replace(/\bf(\d+)\.(\d+)\b/g, (m) => `f${ids.get(m) ?? ids.set(m, ids.size).get(m)}`);
  return { json, ops: found.reduce((n, l) => n + l.ops.length, 0) };
}

describe('a WebGL canvas that holds render targets', () => {
  const gsapModule = createRequire(import.meta.url)('gsap') as { gsap?: unknown; default?: unknown };
  const registry = globalThis as { [GSAP_REGISTRY]?: unknown };

  beforeEach(() => {
    installDeterminism();
    registerRoot(() => (
      <>
        <Composition id="Trail" component={GlTrail} width={64} height={64} fps={30} durationInFrames={20} />
        <Composition id="TrailFade" component={GlTrailFade} width={64} height={64} fps={30} durationInFrames={90} />
        <Composition id="Parity" component={GlParity} width={64} height={64} fps={30} durationInFrames={20} />
        <Composition id="Blurred" component={GlTrailBlurred} width={64} height={64} fps={30} durationInFrames={20} />
        <Composition id="Heavy" component={GlHeavy} width={64} height={64} fps={30} durationInFrames={20} />
        <Composition id="Mounted" component={GlMounted} width={64} height={64} fps={30} durationInFrames={20} />
        <Composition id="Once" component={GlOnce} width={64} height={64} fps={30} durationInFrames={20} />
      </>
    ));
  });
  afterEach(() => {
    delete registry[GSAP_REGISTRY];
  });

  /** Frame `at` after the frames `before` on one renderer, each list on its own renderer. */
  async function frameAfter(id: string, at: number, ...runs: number[][]): Promise<ReturnType<typeof glsl> & { seen: number[] }> {
    let out!: ReturnType<typeof glsl> & { seen: number[] };
    for (const run of runs) {
      resetVirtualClock();
      rendered.clear();
      const renderer = createFrameRenderer(id);
      for (const frame of run) {
        const result = await renderer.renderFrame(frame);
        if (frame === at) out = { ...glsl(result.scene.layers), seen: [] };
      }
      // The frames whose component rendered in the last run, the ones that were asked for and the ones skipped and rendered.
      if (run.includes(at)) out.seen = [...rendered].sort((a, b) => a - b);
      renderer.dispose();
    }
    return out;
  }
  const sequential = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('draws frame 9 of a trail the same in a render of every frame, a jump, a frame alone, and the second chunk of two', async () => {
    const whole = await frameAfter('Trail', 9, sequential);
    // The trail holds the nine sprites before the frame's own, so the paths are told apart by it.
    expect(whole.ops).toBeGreaterThanOrEqual(10);
    expect((await frameAfter('Trail', 9, [0, 4, 9])).json).toBe(whole.json);
    expect((await frameAfter('Trail', 9, [9])).json).toBe(whole.json);
    expect((await frameAfter('Trail', 9, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9])).json).toBe(whole.json);
    // Frame 9 shows what it does to the trail, so a render that began there starts over and renders the frames before it.
    expect((await frameAfter('Trail', 9, [9])).seen).toEqual(sequential);
  });

  it('shows a canvas drawn once and left alone in every later frame, the same on every path', async () => {
    const first = await frameAfter('Once', 0, [0]);
    expect(first.ops).toBeGreaterThanOrEqual(1);
    const whole = await frameAfter('Once', 9, sequential);
    expect(whole.ops).toBe(first.ops);
    expect((await frameAfter('Once', 9, [9])).json).toBe(whole.json);
    expect((await frameAfter('Once', 9, [0, 4, 9])).json).toBe(whole.json);
    expect((await frameAfter('Once', 9, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9])).json).toBe(whole.json);
  });

  it('draws frame 8 of a ping-pong that swaps its targets each frame the same on every path', async () => {
    // Frame 0 wrote one target and frame 8 reads the other, which frame 7 wrote.
    const upTo8 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const whole = await frameAfter('Parity', 8, upTo8);
    // The frame draws from what the frame before it drew: nine frames of draws.
    expect(whole.ops).toBeGreaterThanOrEqual(9);
    expect((await frameAfter('Parity', 8, [8])).json).toBe(whole.json);
    expect((await frameAfter('Parity', 8, [0, 1, 2, 3], [4, 5, 6, 7, 8])).json).toBe(whole.json);
    expect((await frameAfter('Parity', 8, [0, 4, 8])).json).toBe(whole.json);
    // Frame 7 is rendered, shows that frame 8 reads what it wrote, and the frames before it are then rendered too.
    expect((await frameAfter('Parity', 8, [8])).seen).toEqual(upTo8);
  });

  it('draws frame 9 of a motion-blurred trail the same in a render of every frame, a frame alone, and a chunk', async () => {
    const whole = await frameAfter('Blurred', 9, sequential);
    expect(whole.ops).toBeGreaterThanOrEqual(10);
    expect((await frameAfter('Blurred', 9, [9])).json).toBe(whole.json);
    expect((await frameAfter('Blurred', 9, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9])).json).toBe(whole.json);
  });

  it('draws frame 9 of a trail the same with GSAP loaded (the frames a jump skips are rendered there too)', async () => {
    registry[GSAP_REGISTRY] = gsapModule.gsap ?? gsapModule.default ?? gsapModule;
    const whole = await frameAfter('Trail', 9, sequential);
    expect(whole.ops).toBeGreaterThanOrEqual(10);
    expect((await frameAfter('Trail', 9, [9])).json).toBe(whole.json);
    expect((await frameAfter('Trail', 9, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9])).json).toBe(whole.json);
  });

  it('draws frame 9 of a target drawn at mount the same on every path, rendering of the frames it skips only the one before the frame asked for', async () => {
    const whole = await frameAfter('Mounted', 9, sequential);
    expect(whole.ops).toBeGreaterThanOrEqual(2);
    // A fresh start renders frame 0 (the mount), the frame before the frame asked for (a target the frame reads may be
    // what that frame wrote), and the frame asked for.
    const alone = await frameAfter('Mounted', 9, [9]);
    expect(alone.json).toBe(whole.json);
    expect(alone.seen).toEqual([0, 8, 9]);
    const chunk = await frameAfter('Mounted', 9, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9]);
    expect(chunk.json).toBe(whole.json);
    expect(chunk.seen).toEqual([0, 4, 5, 6, 7, 8, 9]);
    const jump = await frameAfter('Mounted', 9, [0, 4, 9]);
    expect(jump.json).toBe(whole.json);
    expect(jump.seen).toEqual([0, 3, 4, 8, 9]);
  });

  it('reports a target that lost draws to its cap as not drawn right, in every frame that reads it', async () => {
    resetVirtualClock();
    const renderer = createFrameRenderer('Heavy');
    const said = async (frame: number) => (await renderer.renderFrame(frame)).unsupported.filter((u) => u.property === 'webgl');
    expect(await said(0)).toEqual([]);
    for (const frame of [1, 2]) {
      const items = await said(frame);
      expect(items).toHaveLength(1);
      expect(items[0]!.reason).toMatch(/render target .*feedback/);
    }
    renderer.dispose();
  }, 30_000);

  const native = (() => {
    try {
      return createRequire(import.meta.url)('@kinetographdev/native') as { renderDomIsland?: unknown };
    } catch {
      return null;
    }
  })();

  (native?.renderDomIsland ? it : it.skip)('reports a trail on a page with CSS transitions as not drawn right where the frames before the window were not rendered', async () => {
    setDomAddon(native);
    try {
      const said = async (...frames: number[]) => {
        resetVirtualClock();
        const renderer = createFrameRenderer('TrailFade');
        let last: Awaited<ReturnType<typeof renderer.renderFrame>>['unsupported'] = [];
        for (const frame of frames) last = (await renderer.renderFrame(frame)).unsupported;
        renderer.dispose();
        return last.filter((u) => u.property === 'webgl');
      };
      // The transition lasts a second, so the window is 60 frames: frame 80 alone replays 20 to 80, and 1 to 19 are not rendered.
      expect(await said(80)).toHaveLength(1);
      // Every frame rendered, or the window starting at frame 1 or earlier: drawn right.
      expect(await said(0, 1, 2, 3)).toEqual([]);
      expect(await said(45)).toEqual([]);
    } finally {
      setDomAddon(null);
    }
  }, 60_000);
});
