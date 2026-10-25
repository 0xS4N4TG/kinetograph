import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaInfo } from '@kinetographdev/native';
import { Layer, Video } from '@kinetographdev/react';
import { motionSubFrames, type GifLayer, type GroupLayer, type VideoLayer } from '@kinetographdev/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { resetVirtualClock } from '../src/determinism.js';
import '../src/datamosh.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { Gif, getGifDurationInSeconds } from '../src/gif.js';
import { getVideoMetadata, setMediaProbe } from '../src/media-utils.js';
import { clearReportedUnsupported, reportedUnsupported } from '../src/unsupported.js';
import { Freeze, Sequence } from '../src/timeline.js';
import { renderAt } from './scene-harness.js';

const info = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  kind: 'video',
  width: 1920,
  height: 1080,
  durationInSeconds: 12.5,
  fps: 25,
  frames: 312,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  ...over,
});

/** A probe that serves `files` and records how it was called. */
function probe(files: Record<string, MediaInfo>) {
  const calls: { path: string; baseDir: string | undefined }[] = [];
  setMediaProbe((path, baseDir) => {
    calls.push({ path, baseDir });
    const found = files[path];
    if (!found) throw new Error(`IO: no such file ${path}`);
    return found;
  });
  return calls;
}

beforeEach(() => {
  resetCompositions();
  resetRenderState();
  resetVirtualClock();
});
afterEach(() => setMediaProbe(null));

describe('@kinetographdev/core/media-utils', () => {
  it('getVideoMetadata reads the header through the probe', async () => {
    const calls = probe({ '/clips/city.mp4': info() });
    await expect(getVideoMetadata('/clips/city.mp4')).resolves.toEqual({
      durationInSeconds: 12.5,
      width: 1920,
      height: 1080,
      aspectRatio: 1920 / 1080,
      isRemote: false,
      fps: 25,
    });
    expect(calls).toEqual([{ path: '/clips/city.mp4', baseDir: undefined }]);
  });

  it('reports fps as null when the file has no frame rate', async () => {
    const { fps: _fps, ...noRate } = info({ kind: 'gif', width: 100, height: 50 });
    probe({ 'a.gif': noRate });
    await expect(getVideoMetadata('a.gif')).resolves.toMatchObject({ fps: null, aspectRatio: 2 });
  });

  it('rejects when the probe fails, with its message', async () => {
    probe({});
    await expect(getVideoMetadata('missing.mp4')).rejects.toThrow('IO: no such file missing.mp4');
  });

  it('rejects remote files and empty sources without asking the probe', async () => {
    const calls = probe({});
    await expect(getVideoMetadata('https://example.com/a.mp4')).rejects.toThrow(/remote files are not supported/);
    await expect(getVideoMetadata('')).rejects.toThrow(/src must be a file path/);
    expect(calls).toEqual([]);
  });

  it('setMediaProbe(null) goes back to looking the addon up', async () => {
    const calls = probe({ 'a.mp4': info() });
    setMediaProbe(null);
    // Whatever answers now (the addon, or an error that it could not be loaded), it is not the stand-in.
    await getVideoMetadata('a.mp4').catch(() => undefined);
    expect(calls).toEqual([]);
  });
});

describe('@kinetographdev/core/gif', () => {
  it('getGifDurationInSeconds is the probe\'s duration, for a GIF', async () => {
    probe({ 'spin.gif': info({ kind: 'gif', durationInSeconds: 1.2, hasAudio: false, videoCodec: 'gif' }) });
    await expect(getGifDurationInSeconds('spin.gif')).resolves.toBe(1.2);
  });

  it('getGifDurationInSeconds refuses a file that is not a GIF', async () => {
    probe({ 'a.mp4': info() });
    await expect(getGifDurationInSeconds('a.mp4')).rejects.toThrow(/a\.mp4 is not a GIF/);
  });

  it('<Gif> is the native element for loop and pause-after-finish, and never probes', () => {
    const calls = probe({});
    const loop = renderAt(<Gif id="g" src="spin.gif" />, 15).layers[0] as GifLayer;
    expect(loop).toEqual({ id: 'g', type: 'gif', src: 'spin.gif', time: 0.5, loop: true });
    const paused = renderAt(<Gif id="g" src="spin.gif" loopBehavior="pause-after-finish" />, 15).layers[0] as GifLayer;
    expect(paused).toMatchObject({ loop: false });
    expect(calls).toEqual([]);
  });

  it('<Gif loopBehavior="unmount-after-finish"> disappears once the file\'s duration has passed', () => {
    const calls = probe({ 'spin.gif': info({ kind: 'gif', durationInSeconds: 1, hasAudio: false }) });
    const gif = <Gif id="g" src="spin.gif" loopBehavior="unmount-after-finish" />;
    expect(renderAt(gif, 29).layers).toEqual([{ id: 'g', type: 'gif', src: 'spin.gif', time: 29 / 30, loop: false }]);
    expect(renderAt(gif, 30).layers).toEqual([]);
    expect(calls.every((c) => c.path === 'spin.gif')).toBe(true);
    // The duration is read once, not on every frame.
    expect(calls).toHaveLength(1);
  });

  it('<Gif> inside a Sequence starts at the Sequence\'s frame 0 and is gone before it starts', () => {
    const gif = (
      <Sequence from={30} durationInFrames={60}>
        <Gif id="g" src="spin.gif" />
      </Sequence>
    );
    expect(renderAt(gif, 29).layers).toEqual([]);
    const at45 = (renderAt(gif, 45).layers[0] as GroupLayer).children[0] as GifLayer;
    expect(at45.time).toBe(0.5);
  });
});

describe('<Video datamosh> on a codec without motion vectors', () => {
  it('is reported as unsupported, and only for that codec', () => {
    probe({ 'a.mp4': info(), 'b.webm': info({ videoCodec: 'vp9' }) });
    clearReportedUnsupported();
    renderAt(<Video id="v" src="a.mp4" datamosh={{ from: 0, to: 10 }} />, 3);
    expect(reportedUnsupported()).toEqual([]);
    renderAt(<Video id="v" src="b.webm" datamosh={{ from: 0, to: 10 }} />, 3);
    expect(reportedUnsupported()).toMatchObject([{ element: 'Video', property: 'datamosh', value: 'vp9' }]);
    // A video without a datamosh is not asked.
    clearReportedUnsupported();
    renderAt(<Video id="v" src="b.webm" />, 3);
    expect(reportedUnsupported()).toEqual([]);
  });
});

describe('<Video> in the Remotion components', () => {
  it('a Sequence gives it its start, trims and all, and its sound the same one', () => {
    const tree = renderAt(
      <Sequence from={30} durationInFrames={60}>
        <Video id="v" src="a.mp4" trimBefore={15} playbackRate={2} volume={(f) => f / 10} />
      </Sequence>,
      34,
    );
    const layer = (tree.layers[0] as GroupLayer).children[0] as VideoLayer;
    expect(layer).toEqual({ id: 'v', type: 'video', src: 'a.mp4', from: 30, trimBefore: 15, playbackRate: 2 });
    expect(tree.audio).toEqual([
      {
        id: 'v', src: 'a.mp4', from: 30, trimBefore: 15, trimAfter: null, playbackRate: 2,
        volume: 0.4, loop: false, muted: false, video: true,
      },
    ]);
  });

  it('is not there before its Sequence starts or after it ends, and neither is its sound', () => {
    const tree = (frame: number) =>
      renderAt(
        <Sequence from={30} durationInFrames={20}>
          <Video id="v" src="a.mp4" />
        </Sequence>,
        frame,
      );
    expect(tree(29).audio).toEqual([]);
    expect(tree(30).audio).toHaveLength(1);
    expect(tree(49).audio).toHaveLength(1);
    expect(tree(50).audio).toEqual([]);
    expect(tree(50).layers).toEqual([]);
  });

  it('a Freeze holds the picture and silences the sound', () => {
    const frozen = (frame: number) =>
      renderAt(
        <Sequence from={30}>
          <Freeze frame={5}>
            <Video id="v" src="a.mp4" />
          </Freeze>
        </Sequence>,
        frame,
      );
    for (const frame of [40, 41, 60]) {
      const tree = frozen(frame);
      const layer = (tree.layers[0] as GroupLayer).children[0] as VideoLayer;
      // The clip's frame, frame - from, is the frozen 5 whatever the composition's frame is.
      expect(layer.frame).toBe(frame);
      expect((layer.frame as number) - (layer.from as number)).toBe(5);
      expect(tree.audio[0]).toMatchObject({ muted: true, video: true });
    }
  });

  it('an inactive Freeze plays on', () => {
    const tree = renderAt(
      <Freeze frame={5} active={(frame) => frame >= 20}>
        <Video id="v" src="a.mp4" />
      </Freeze>,
      10,
    );
    expect(tree.layers[0]).not.toHaveProperty('frame');
    expect(tree.audio[0]).toMatchObject({ muted: false });
  });
});

describe('motion blur sub-frames', () => {
  function Scene() {
    return (
      <>
        <Video id="v" src="a.mp4" trimBefore={10} motionBlur={{ samples: 3, shutter: 1 }} />
        <Gif id="g" src="spin.gif" motionBlur={{ samples: 3, shutter: 1 }} />
        <Layer id="group" motionBlur={{ samples: 2, shutter: 1 }}>
          <Sequence from={4}>
            <Video id="inner" src="b.mp4" />
          </Sequence>
        </Layer>
      </>
    );
  }
  const compose = () => {
    registerRoot(() => <Composition id="MB" component={Scene} width={64} height={64} fps={30} durationInFrames={30} />);
    return createFrameRenderer('MB');
  };

  it('puts a copy per sub-frame on a video and a gif, each with the same start and its own time', async () => {
    const { scene } = await compose().renderFrame(10);
    const [video, gif] = scene.layers as [VideoLayer, GifLayer, GroupLayer];
    // t_i = 10 + ((i + 0.5) / 3 - 0.5) for a shutter of 1.
    const times = [10 - 1 / 3, 10, 10 + 1 / 3];
    const videoCopies = motionSubFrames(video) as VideoLayer[];
    expect(videoCopies).toHaveLength(3);
    for (const copy of videoCopies) {
      expect(copy).toMatchObject({ id: 'v', type: 'video', src: 'a.mp4', from: 0, trimBefore: 10 });
      // The renderer reads the sub-frame's own time, so a copy must not pin `frame`.
      expect(copy).not.toHaveProperty('frame');
    }
    const gifCopies = motionSubFrames(gif) as GifLayer[];
    expect(gifCopies.map((copy) => copy.time as number)).toEqual(times.map((t) => t / 30));
    expect(gifCopies.every((copy) => copy.loop === true)).toBe(true);
    // The layer itself is the frame's own state.
    expect(gif.time).toBeCloseTo(10 / 30, 12);
  });

  it('keeps `from` whole in a Sequence even though the sub-frame times are fractional', async () => {
    const { scene } = await compose().renderFrame(10);
    const group = scene.layers[2] as GroupLayer;
    const copies = motionSubFrames(group) as GroupLayer[];
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      const inner = copy.children[0] as GroupLayer;
      expect((inner.children[0] as VideoLayer).from).toBe(4);
    }
  });

  it('makes the sound from the frame itself, once, not from the sub-frames', async () => {
    const { audio } = await compose().renderFrame(10);
    expect(audio.map((clip) => clip.id).sort()).toEqual(['inner', 'v']);
    expect(audio.every((clip) => clip.video === true && Number.isInteger(clip.from))).toBe(true);
  });

  it('a frozen video inside motion blur keeps the frozen picture on every copy', async () => {
    function Held() {
      return (
        <Layer id="g" motionBlur={{ samples: 2, shutter: 1 }}>
          <Freeze frame={3}>
            <Video id="held" src="a.mp4" />
          </Freeze>
        </Layer>
      );
    }
    registerRoot(() => <Composition id="H" component={Held} width={64} height={64} fps={30} durationInFrames={30} />);
    const { scene } = await createFrameRenderer('H').renderFrame(10);
    const group = scene.layers[0] as GroupLayer;
    for (const copy of motionSubFrames(group) as GroupLayer[]) {
      const video = copy.children[0] as VideoLayer;
      expect((video.frame as number) - (video.from as number)).toBeCloseTo(3, 9);
    }
  });
});
