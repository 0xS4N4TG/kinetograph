import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Audio, Camera, createSceneRoot, Layer, Lottie, Rect, useTimeline } from '../src/index.js';
import { at, renderAt, timeline } from './harness.js';

describe('<Lottie>', () => {
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    // The cache lives under the home directory; point it at a scratch one.
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'kg-react-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('takes its time from the timeline: frame / fps * playbackRate', () => {
    const layer = (frame: number, rate?: number) =>
      renderAt(<Lottie id="l" src="anims/confetti.json" width={400} height={400} loop playbackRate={rate} />, frame).layers[0];
    expect(layer(0)).toEqual({ id: 'l', type: 'lottie', src: 'anims/confetti.json', width: 400, height: 400, time: 0, loop: true });
    expect(layer(15)).toMatchObject({ time: 0.5 });
    expect(layer(15, 2)).toMatchObject({ time: 1 });
    expect(layer(45, 0.5)).toMatchObject({ time: 0.75 });
  });

  it('reads the fps and the frame as the component sees them (Sequence-relative, fractional)', () => {
    const state = timeline(0, { frame: 7.5, absoluteFrame: 37.5 });
    expect(renderAt(<Lottie id="l" src="a.json" />, state).layers[0]).toMatchObject({ time: 0.25 });
    const slow = timeline(30);
    slow.config.fps = 60;
    expect(renderAt(<Lottie id="l" src="a.json" />, slow).layers[0]).toMatchObject({ time: 0.5 });
  });

  it('leaves out width, height and loop when not given', () => {
    expect(renderAt(<Lottie id="l" src="a.json" />).layers[0]).toEqual({ id: 'l', type: 'lottie', src: 'a.json', time: 0 });
  });

  it('writes animationData once to a content-addressed file and uses that path', () => {
    const data = { v: '5.7.0', fr: 30, ip: 0, op: 60, w: 100, h: 100, layers: [] };
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const expected = join(home, '.cache', 'kinetograph', 'lottie', `${hash}.json`);

    const first = renderAt(<Lottie id="l" animationData={data} />, 3).layers[0];
    expect(first).toMatchObject({ type: 'lottie', src: expected, time: 0.1 });
    expect(JSON.parse(readFileSync(expected, 'utf8'))).toEqual(data);
    const written = statSync(expected).mtimeMs;

    // The same data again, as the same object and as an equal copy: no second file, no rewrite.
    renderAt(<Lottie id="l" animationData={data} />, 4);
    renderAt(<Lottie id="l" animationData={structuredClone(data)} />, 5);
    expect(readdirSync(join(home, '.cache', 'kinetograph', 'lottie'))).toEqual([`${hash}.json`]);
    expect(statSync(expected).mtimeMs).toBe(written);

    // Different data is a different file.
    const other = renderAt(<Lottie id="l" animationData={{ ...data, w: 200 }} />).layers[0] as { src: string };
    expect(other.src).not.toBe(expected);
    expect(readdirSync(join(home, '.cache', 'kinetograph', 'lottie'))).toHaveLength(2);
  });

  it('writes the file again if it has gone missing', () => {
    const data = { v: '5.7.0', layers: [] };
    const src = (renderAt(<Lottie id="l" animationData={data} />).layers[0] as { src: string }).src;
    rmSync(src);
    expect(existsSync(src)).toBe(false);
    renderAt(<Lottie id="l" animationData={data} />);
    expect(existsSync(src)).toBe(true);
  });

  it('wants src or animationData, not neither and not both', () => {
    expect(() => renderAt(<Lottie id="l" />)).toThrow(/needs src or animationData/);
    expect(() => renderAt(<Lottie id="l" src="a.json" animationData={{}} />)).toThrow(/either src or animationData/);
  });

  it('fails outside a composition, where there is no timeline', () => {
    const root = createSceneRoot();
    expect(() => root.render(<Lottie id="l" src="a.json" />)).toThrow(/No timeline/);
    root.unmount();
  });
});

describe('<Camera>', () => {
  it('is hoisted out of the layers to RenderedTree.camera', () => {
    const tree = renderAt(
      <>
        <Rect id="a" width={1} height={1} />
        <Camera perspective={700} />
      </>,
    );
    expect(tree.camera).toEqual({ perspective: 700 });
    expect(tree.layers.map((l) => l.id)).toEqual(['a']);
  });

  it('takes x and y, and may sit anywhere in the tree', () => {
    const tree = renderAt(
      <Layer id="outer">
        <Layer id="inner">
          <Camera perspective={[{ frame: 0, value: 500 }, { frame: 30, value: 900 }]} x={640} y={360} />
        </Layer>
      </Layer>,
    );
    expect(tree.camera).toEqual({
      perspective: [{ frame: 0, value: 500 }, { frame: 30, value: 900 }],
      x: 640,
      y: 360,
    });
    expect(tree.layers[0]).toMatchObject({ children: [{ id: 'inner', children: [] }] });
  });

  it('is null when there is none', () => {
    expect(renderAt(<Rect id="a" width={1} height={1} />).camera).toBeNull();
    expect(renderAt(null).camera).toBeNull();
  });

  it('may not appear twice', () => {
    expect(() =>
      renderAt(
        <>
          <Camera perspective={700} />
          <Layer id="g">
            <Camera perspective={900} />
          </Layer>
        </>,
      ),
    ).toThrow(/Only one <Camera> is allowed per tree, found 2/);
  });
});

describe('<Audio>', () => {
  it('becomes an AudioClipJson in RenderedTree.audio, not a layer', () => {
    const tree = renderAt(
      <>
        <Rect id="a" width={1} height={1} />
        <Audio id="music" src="/abs/music.mp3" />
      </>,
      12,
    );
    expect(tree.layers.map((l) => l.id)).toEqual(['a']);
    expect(tree.audio).toEqual([
      { id: 'music', src: '/abs/music.mp3', from: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, volume: 1, loop: false, muted: false },
    ]);
  });

  it("starts the clip at absoluteFrame - frame, i.e. where the enclosing Sequence began", () => {
    const state = timeline(0, { frame: 5, absoluteFrame: 35 });
    expect(renderAt(<Audio id="a" src="x.mp3" />, state).audio[0]).toMatchObject({ from: 30 });
  });

  it('snaps the start to a whole frame on a fractional sub-frame', () => {
    const state = timeline(0, { frame: 0.1 + 0.2, absoluteFrame: 10.3 });
    const from = (renderAt(<Audio id="a" src="x.mp3" />, state).audio[0] as { from: number }).from;
    expect(Number.isInteger(from)).toBe(true);
    expect(from).toBe(10);
  });

  it("evaluates a volume callback at the clip's own frame (the Sequence-relative frame)", () => {
    const seen: number[] = [];
    const volume = (f: number) => {
      seen.push(f);
      return Math.min(1, f / 10);
    };
    expect(renderAt(<Audio id="a" src="x.mp3" volume={volume} />, timeline(0, { frame: 4, absoluteFrame: 34 })).audio[0]).toMatchObject({
      volume: 0.4,
      from: 30,
    });
    expect(seen).toEqual([4]);
    expect(renderAt(<Audio id="a" src="x.mp3" volume={0.25} />).audio[0]).toMatchObject({ volume: 0.25 });
  });

  it('is muted by `muted` and inside a Freeze', () => {
    expect(renderAt(<Audio id="a" src="x.mp3" muted />).audio[0]).toMatchObject({ muted: true });
    expect(renderAt(<Audio id="a" src="x.mp3" />, timeline(3, { frozen: true })).audio[0]).toMatchObject({ muted: true, volume: 1 });
    expect(renderAt(<Audio id="a" src="x.mp3" muted={false} />, timeline(3, { frozen: false })).audio[0]).toMatchObject({ muted: false });
  });

  it('takes trims, rate and loop, with the older names as aliases', () => {
    expect(renderAt(<Audio id="a" src="x.mp3" trimBefore={30} trimAfter={90} playbackRate={1.5} loop />).audio[0]).toMatchObject({
      trimBefore: 30,
      trimAfter: 90,
      playbackRate: 1.5,
      loop: true,
    });
    expect(renderAt(<Audio id="a" src="x.mp3" startFrom={10} endAt={50} />).audio[0]).toMatchObject({ trimBefore: 10, trimAfter: 50 });
    expect(renderAt(<Audio id="a" src="x.mp3" trimBefore={1} startFrom={10} />).audio[0]).toMatchObject({ trimBefore: 1 });
  });

  it('gets an automatic id from the host-tree index path, like a layer', () => {
    const tree = renderAt(
      <>
        <Rect width={1} height={1} />
        <Layer>
          <Rect width={1} height={1} />
          <Audio src="x.mp3" />
        </Layer>
        <Audio src="y.mp3" />
      </>,
    );
    expect(tree.audio.map((a) => [a.id, a.src])).toEqual([
      ['$1.1', 'x.mp3'],
      ['$2', 'y.mp3'],
    ]);
  });

  it('lists clips in document order', () => {
    const tree = renderAt(
      <>
        <Audio id="b" src="b.mp3" />
        <Layer id="g">
          <Audio id="a" src="a.mp3" />
        </Layer>
      </>,
    );
    expect(tree.audio.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('rejects a volume that is not a finite number', () => {
    expect(() => renderAt(<Audio id="a" src="x.mp3" volume={() => NaN} />)).toThrow(/volume must be a finite number/);
  });

  it('shares the id namespace with layers', () => {
    expect(() =>
      renderAt(
        <>
          <Rect id="same" width={1} height={1} />
          <Audio id="same" src="x.mp3" />
        </>,
      ),
    ).toThrow(/Duplicate id "same"/);
  });
});

describe('time', () => {
  it('is read from the timeline context by any component', () => {
    function Clock() {
      const { frame, config } = useTimeline();
      return <Rect id="clock" width={frame} height={config.height} />;
    }
    expect(renderAt(<Clock />, 7).layers[0]).toMatchObject({ shape: { width: 7, height: 720 } });
    expect(renderAt(at(<Clock />, 7), 9).layers[0]).toMatchObject({ shape: { width: 7 } });
  });
});
