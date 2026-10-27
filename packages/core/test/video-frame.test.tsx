// `onVideoFrame` of `<Video>`, `<OffthreadVideo>` and `<Html5Video>` (AUTHORING.md §7.1): the frame a project is handed
// can be drawn on a canvas and read back with `getImageData`, from the frame the video shows at that composition frame.
// These run the real addon on the committed clips of crates/core/tests/scenes/media (a stand-in cannot decode).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Video } from '@kinetographdev/react';
import { VideoFramePicture, videoClipTime } from '@kinetographdev/scene';
import { resetRenderState } from '../src/assets.js';
import { Composition, registerRoot, resetCompositions } from '../src/compositions.js';
import { installDeterminism, resetVirtualClock, uninstallDeterminism } from '../src/determinism.js';
import '../src/video-frame.js';
import { OffthreadVideo, Html5Video } from '../src/index.js';
import { createFrameRenderer } from '../src/frame-loop.js';
import { Sequence, useCurrentFrame } from '../src/timeline.js';

const media = (file: string) => fileURLToPath(new URL(`../../../crates/core/tests/scenes/media/${file}`, import.meta.url));
const CLIP = media('clip.mp4'); // 64 x 36, 24 fps, 2 s
const MATTE = media('matte-4444.mkv'); // 64 x 36, 12 fps, ProRes 4444 with an alpha disc

const native = (() => {
  try {
    const addon = createRequire(import.meta.url)('@kinetographdev/native') as Record<string, unknown>;
    return typeof addon.readCanvasPicture === 'function' ? (addon as any) : null;
  } catch {
    return null;
  }
})();

describe('videoClipTime (the rules of SCENE.md "video", as Clip::source_time in crates/core/src/video.rs)', () => {
  const clip = (over: Partial<Parameters<typeof videoClipTime>[0]> = {}) => ({
    frame: 15, fps: 30, start: 0, trimBefore: 0, trimAfter: null, playbackRate: 1, loop: false, ...over,
  });
  it('follows the frame, the start and the rate', () => {
    expect(videoClipTime(clip(), 2)).toEqual({ time: 0.5, end: 2 });
    expect(videoClipTime(clip({ start: 10, frame: 25 }), 2).time).toBe(0.5);
    expect(videoClipTime(clip({ start: 10, frame: 3 }), 2).time).toBe(0); // held before it starts
    expect(videoClipTime(clip({ playbackRate: 2 }), 4).time).toBe(1);
    expect(videoClipTime(clip({ playbackRate: 0.5 }), 4).time).toBe(0.25);
    expect(videoClipTime(clip({ frame: 14.75 }), 2).time).toBe(14.75 / 30);
  });
  it('skips trimBefore, ends at trimAfter or the stream, and wraps in a loop', () => {
    expect(videoClipTime(clip({ frame: 0, trimBefore: 15 }), 2).time).toBe(0.5);
    expect(videoClipTime(clip({ frame: 90, trimBefore: 15 }), 2).time).toBe(2);
    expect(videoClipTime(clip({ frame: 1000, trimBefore: 15, trimAfter: 45 }), 2)).toEqual({ time: 1.5, end: 1.5 });
    // A loop of 30 frames after trimBefore 15 starts again at trimBefore.
    const looped = clip({ trimBefore: 15, trimAfter: 45, loop: true });
    expect(videoClipTime({ ...looped, frame: 30 }, 2).time).toBe(0.5);
    expect(videoClipTime({ ...looped, frame: 31 }, 2).time).toBe(16 / 30);
  });
});

describe('VideoFramePicture', () => {
  it('is a picture drawImage reads: the file, the instant and the size', async () => {
    const { pictureOf, VIDEO_FRAME } = await import('@kinetographdev/scene');
    const frame = new VideoFramePicture('/p/clip.mp4', 0.5, 64, 36, 2);
    expect(pictureOf(frame)).toEqual({ source: { kind: 'video', src: '/p/clip.mp4', time: 0.5, end: 2 }, width: 64, height: 36 });
    expect((frame as any)[VIDEO_FRAME]()).toEqual({ src: '/p/clip.mp4', time: 0.5, width: 64, height: 36 });
    expect([frame.width, frame.displayHeight, frame.videoWidth, frame.timestamp]).toEqual([64, 36, 64, 500000]);
    expect(() => frame.close()).not.toThrow();
  });
});

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

const sha = (bytes: Uint8ClampedArray) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

describe.skipIf(native === null)('onVideoFrame with a canvas', () => {
  interface Seen {
    frame: number;
    width: number;
    height: number;
    rgba: Uint8ClampedArray;
    commands: any[];
  }

  /** A composition that grays each frame of `src` on a canvas, as a Remotion project does with `onVideoFrame`. */
  function register(Component: typeof Video, props: Record<string, unknown>, seen: Seen[], quarter = false) {
    function Gray() {
      const frame = useCurrentFrame();
      const canvas = useRef<any>(null);
      return (
        <>
          <Component
            src={CLIP}
            width={64}
            height={36}
            {...props}
            onVideoFrame={(picture: VideoFramePicture) => {
              const ctx = canvas.current.getContext('2d', { willReadFrequently: true });
              const [w, h] = quarter ? [16, 9] : [64, 36];
              ctx.drawImage(picture, 0, 0, w, h);
              const image = ctx.getImageData(0, 0, w, h);
              const data = image.data;
              for (let i = 0; i < data.length; i += 4) {
                const luma = Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!);
                data[i] = data[i + 1] = data[i + 2] = luma;
              }
              ctx.putImageData(image, 0, 0);
              seen.push({ frame, width: picture.width, height: picture.height, rgba: data, commands: [...ctx.commands] });
            }}
          />
          <canvas ref={canvas} width={64} height={36} />
        </>
      );
    }
    registerRoot(() => <Composition id="Gray" component={Gray} width={64} height={36} fps={24} durationInFrames={48} />);
  }

  /** What the handler saw at composition frame `frame` (a render that starts past frame 0 plays frame 0 first, as a project's mount does). */
  const at = (seen: Seen[], frame: number): Seen => seen.filter((s) => s.frame === frame).at(-1)!;

  async function run(frames: number[]) {
    const renderer = createFrameRenderer('Gray');
    const unsupported: unknown[] = [];
    for (const frame of frames) unsupported.push(...(await renderer.renderFrame(frame)).unsupported);
    renderer.dispose();
    return unsupported;
  }

  it('hands each shown frame over once, at the size of the file, and the canvas gets its gray picture', async () => {
    const seen: Seen[] = [];
    register(Video, {}, seen);
    const unsupported = await run([0, 1, 2, 12]);
    expect(unsupported).toEqual([]);
    // Each frame once, though a frame renders more than once before it settles.
    expect(seen.map((s) => s.frame)).toEqual([0, 1, 2, 12]);
    expect(seen.every((s) => s.width === 64 && s.height === 36)).toBe(true);
    for (const s of seen) {
      // Gray: all three channels equal; opaque; and a picture (the clip is not black).
      for (let i = 0; i < s.rgba.length; i += 4) {
        expect(s.rgba[i]).toBe(s.rgba[i + 1]);
        expect(s.rgba[i + 1]).toBe(s.rgba[i + 2]);
        expect(s.rgba[i + 3]).toBe(255);
      }
      expect(s.rgba.some((v, i) => i % 4 === 0 && v > 0)).toBe(true);
    }
    // Different composition frames are different pictures of the clip (the first two are the same picture of this clip).
    expect(new Set(seen.map((s) => sha(s.rgba))).size).toBeGreaterThanOrEqual(3);
  });

  it('reads the frame the video shows: the gray of the decoder\'s picture, within a level of the GPU draw', async () => {
    const seen: Seen[] = [];
    register(Video, {}, seen);
    await run([12]);
    // Frame 12 of 24 fps is 0.5 s into the clip. The canvas first held `drawImage(frame)`: draw that on the GPU.
    const draw = at(seen, 12).commands.find((c) => c.op === 'image' && c.source.kind === 'video');
    expect(draw).toMatchObject({ source: { kind: 'video', src: CLIP, time: 0.5 } });
    const request = { width: 64, height: 36, commands: [draw], fonts: {}, baseDir: '', format: 'rgba' };
    const gpu = new Uint8ClampedArray(native.renderCanvas(JSON.stringify(request)));
    for (let i = 0; i < gpu.length; i += 4) {
      const luma = Math.round(0.2126 * gpu[i]! + 0.7152 * gpu[i + 1]! + 0.0722 * gpu[i + 2]!);
      expect(Math.abs(at(seen, 12).rgba[i]! - luma)).toBeLessThanOrEqual(1);
    }
  });

  it('is byte-stable: two runs, and a frame rendered alone, give the same bytes', async () => {
    const first: Seen[] = [];
    register(Video, {}, first);
    await run([0, 5, 6, 30]);
    resetVirtualClock();
    resetCompositions();
    const second: Seen[] = [];
    register(Video, {}, second);
    await run([0, 5, 6, 30]);
    expect(second.map((s) => sha(s.rgba))).toEqual(first.map((s) => sha(s.rgba)));
    resetVirtualClock();
    resetCompositions();
    const alone: Seen[] = [];
    register(Video, {}, alone);
    await run([30]);
    expect(sha(at(alone, 30).rgba)).toBe(sha(at(first, 30).rgba));
  });

  it('works for OffthreadVideo and Html5Video, and at a quarter of the size', async () => {
    for (const Component of [OffthreadVideo, Html5Video] as unknown as (typeof Video)[]) {
      resetCompositions();
      const seen: Seen[] = [];
      register(Component, {}, seen, true);
      await run([3]);
      expect(at(seen, 3).rgba).toHaveLength(16 * 9 * 4);
    }
  });

  it('follows the clip: trimBefore, playbackRate and a Sequence move the frame it hands over', async () => {
    const times = async (props: Record<string, unknown>, frames: number[]) => {
      resetCompositions();
      resetVirtualClock();
      const seen: Seen[] = [];
      register(Video, props, seen);
      await run(frames);
      return frames.filter((f) => seen.some((s) => s.frame === f)).map((f) => at(seen, f).commands.find((c) => c.op === 'image').source.time);
    };
    expect(await times({}, [0, 12, 24])).toEqual([0, 0.5, 1]);
    expect(await times({ trimBefore: 12 }, [0, 12])).toEqual([0.5, 1]);
    expect(await times({ playbackRate: 2 }, [0, 12])).toEqual([0, 1]);
    // `from` delays the clip: nothing is handed over before it, then frame 0 falls on it.
    expect(await times({ from: 6 }, [0, 5, 6, 18])).toEqual([0, 0.5]);
  });

  it('is not called for a frame the video is not shown in, nor again by a re-render of the same frame', async () => {
    const seen: Seen[] = [];
    function Late() {
      return (
        <Sequence from={10}>
          <Video src={CLIP} width={64} height={36} onVideoFrame={(f: VideoFramePicture) => seen.push({ frame: f.timestamp } as any)} />
        </Sequence>
      );
    }
    registerRoot(() => <Composition id="Gray" component={Late} width={64} height={36} fps={24} durationInFrames={48} />);
    await run([0, 9, 10, 11]);
    expect(seen.map((s) => s.frame)).toEqual([0, Math.round((1 / 24) * 1e6)]);
  });

  it('reads the alpha of a matte video per frame', async () => {
    const alphas: number[][] = [];
    function Matte() {
      const canvas = useRef<any>(null);
      return (
        <>
          <Video
            src={MATTE}
            width={64}
            height={36}
            onVideoFrame={(picture: VideoFramePicture) => {
              const ctx = canvas.current.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(picture, 0, 0);
              const { data } = ctx.getImageData(0, 0, 64, 36);
              // The disc's alpha along the row y = 18.
              alphas.push(Array.from({ length: 64 }, (_, x) => data[(18 * 64 + x) * 4 + 3]!));
            }}
          />
          <canvas ref={canvas} width={64} height={36} />
        </>
      );
    }
    registerRoot(() => <Composition id="Gray" component={Matte} width={64} height={36} fps={12} durationInFrames={12} />);
    await run([0, 5]);
    const covered = (row: number[]) => row.map((a, x) => (a === 255 ? x : -1)).filter((x) => x >= 0);
    // The disc has radius 10 around x = 8 + 4n.
    expect([Math.min(...covered(alphas[0]!)), Math.max(...covered(alphas[0]!))]).toEqual([0, 17]);
    expect([Math.min(...covered(alphas[1]!)), Math.max(...covered(alphas[1]!))]).toEqual([19, 37]);
  });
});
