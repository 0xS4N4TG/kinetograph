import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedImage } from '../src/index.js';
import { clearAnimatedImages, pictureStart } from '../src/animated-image.js';
import { isGif, nearestPicture, readApngTimeline, readGifTimeline, readWebpTimeline } from '../src/gif-timeline.js';
import { resetWarnings } from '../src/warn.js';
import { makeApng, makeGif, makeWebp, pngChunk } from './gif-fixture.js';
import { renderDom, sent, useFakeDom } from './dom-harness.js';
import { renderAt } from './scene-harness.js';

useFakeDom();

describe('readGifTimeline', () => {
  it('reads the size and each picture\'s start, with a delay of 10 ms or less shown for 100 ms', () => {
    // 0 and 1 hundredths of a second are 100 ms each, as in browsers and the gif layer; 11 and 25 are as stored.
    const timeline = readGifTimeline(makeGif([0, 1, 11, 25], 40, 30));
    expect(timeline).toEqual({ width: 40, height: 30, startsUs: [0, 100000, 200000, 310000], durationUs: 560000 });
  });

  it('refuses a file that is not a GIF, and a GIF without pictures', () => {
    expect(isGif(makeGif([5]))).toBe(true);
    expect(isGif(Uint8Array.from([137, 80, 78, 71, 13, 10]))).toBe(false);
    expect(() => readGifTimeline(Uint8Array.from([1, 2, 3]))).toThrow(/not a GIF/);
    expect(() => readGifTimeline(makeGif([]))).toThrow(/no pictures/);
  });

  it('agrees with the engine on the files in the repository', () => {
    let native: { probeMedia(path: string): { durationInSeconds: number; frames?: number; width: number; height: number } };
    try {
      native = createRequire(import.meta.url)('@kinetograph/native');
    } catch {
      return; // the addon is not built here
    }
    for (const path of ['../../../examples/video-overlay/public/badge.gif', '../../../crates/core/tests/scenes/media/spinner.gif']) {
      const file = new URL(path, import.meta.url).pathname;
      const timeline = readGifTimeline(readFileSync(file));
      const info = native.probeMedia(file);
      expect(timeline.startsUs.length, path).toBe(info.frames);
      expect(timeline.durationUs / 1e6, path).toBeCloseTo(info.durationInSeconds, 9);
      expect([timeline.width, timeline.height], path).toEqual([info.width, info.height]);
    }
  });
});

describe('readApngTimeline and readWebpTimeline', () => {
  it('reads an APNG\'s size and picture starts, skipping a default IDAT and turning <= 10 ms into 100 ms', () => {
    expect(readApngTimeline(makeApng([[1, 10], [5, 100]], 40, 30))).toEqual({
      width: 40,
      height: 30,
      startsUs: [0, 100000],
      durationUs: 150000,
    });
    expect(readApngTimeline(makeApng([[0, 0]], 16, 12, true))).toEqual({
      width: 16,
      height: 12,
      startsUs: [0],
      durationUs: 100000,
    });
  });

  it('refuses a non-PNG, a still PNG, or an APNG without pictures', () => {
    expect(() => readApngTimeline(Uint8Array.from([1, 2, 3]))).toThrow(/not a PNG/);
    const still = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', new Array(13).fill(0)), ...pngChunk('IDAT', [0])]);
    expect(() => readApngTimeline(still)).toThrow(/it is not animated/);
    expect(() => readApngTimeline(makeApng([]))).toThrow(/it has no pictures/);
  });

  it('reads an animated WebP\'s size and picture starts, turning <= 10 ms into 100 ms', () => {
    expect(readWebpTimeline(makeWebp([40, 5], 50, 20))).toEqual({
      width: 50,
      height: 20,
      startsUs: [0, 40000],
      durationUs: 140000,
    });
  });

  it('refuses a non-WebP, a still WebP, or an animated WebP without pictures', () => {
    expect(() => readWebpTimeline(Uint8Array.from([1, 2, 3]))).toThrow(/not a WebP/);
    const still = Uint8Array.from([...Buffer.from('RIFF'), 22, 0, 0, 0, ...Buffer.from('WEBP'), ...Buffer.from('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => readWebpTimeline(still)).toThrow(/it is not animated/);
    expect(() => readWebpTimeline(makeWebp([]))).toThrow(/it has no pictures/);
  });
});

describe('nearestPicture', () => {
  // Three pictures of 100 ms, starting at 0, 0.1 and 0.2 s.
  const timeline = readGifTimeline(makeGif([10, 10, 10]));
  // Never the picture showing at the time: the one whose start is nearer, the next one on a tie.
  it.each([
    [-1, 0],
    [0, 0],
    [0.0333, 0],
    [0.0499, 0],
    [0.05, 1],
    [0.0667, 1],
    [0.1, 1],
    [0.1499, 1],
    [0.15, 1], // 0.15 - 0.1 is 0.04999999999999999 in floating point, as it is in Remotion's comparison
    [0.1501, 2],
    [0.2, 2],
    [0.29, 2],
    [9, 2],
  ])('at %f s is picture %i', (seconds, index) => {
    expect(nearestPicture(timeline, seconds)).toBe(index);
  });

  it('weighs unequal pictures by where they start', () => {
    // starts 0, 0.1 and 0.5 s: the midpoint between the last two is 0.3 s
    const uneven = readGifTimeline(makeGif([10, 40, 10]));
    expect(nearestPicture(uneven, 0.29)).toBe(1);
    expect(nearestPicture(uneven, 0.31)).toBe(2);
  });
});

describe('pictureStart', () => {
  const timeline = readGifTimeline(makeGif([10, 10, 10])); // 0.3 s
  it('wraps round when looping', () => {
    expect(pictureStart(timeline, 0.31, 'loop')).toBe(0);
    expect(pictureStart(timeline, 0.4, 'loop')).toBe(0.1);
    expect(pictureStart(timeline, 0.3, 'loop')).toBe(0);
  });

  it('holds the last picture after the end, or with clear-after-finish shows nothing once past it', () => {
    expect(pictureStart(timeline, 5, 'pause-after-finish')).toBe(0.2);
    expect(pictureStart(timeline, 0.3, 'clear-after-finish')).toBe(0.2);
    expect(pictureStart(timeline, 0.3001, 'clear-after-finish')).toBeNull();
  });
});

describe('<AnimatedImage>', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kg-animated-'));
    clearAnimatedImages();
    resetWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const gif = (name: string, delays: number[]) => {
    const path = join(dir, name);
    writeFileSync(path, makeGif(delays, 40, 30));
    return path;
  };
  // The timeline of renderAt is 30 fps.
  const layerAt = (node: React.ReactNode, frame: number) => renderAt(node, frame).layers[0] as any;

  it('shows, as a gif layer, the picture Remotion\'s decoder gives that frame', () => {
    const path = gif('three.gif', [10, 10, 10]); // 10 fps pictures at 30 fps frames
    const image = <AnimatedImage src={path} />;
    const seen = [0, 1, 2, 3, 4, 5, 6, 8].map((frame) => Math.round(layerAt(image, frame).time * 10));
    // Frames 0 and 1 are nearer picture 0 (starts 0 s), 2 to 4 picture 1 (0.1 s), 5, 6 and 8 picture 2 (0.2 s): the
    // pictures change half a picture early, which is how Remotion's decoder picks.
    expect(seen).toEqual([0, 0, 1, 1, 1, 2, 2, 2]);
    expect(layerAt(image, 2)).toMatchObject({ type: 'gif', src: path, loop: false });
    // Half a millisecond into the picture, so the layer's own lookup lands on it
    expect(layerAt(image, 3).time).toBeCloseTo(0.1005, 9);
  });

  it('takes the size and fit, and defaults to the file\'s size and fill', () => {
    const path = gif('a.gif', [10, 10]);
    expect(layerAt(<AnimatedImage src={path} />, 0)).toMatchObject({ fit: 'fill' });
    expect(layerAt(<AnimatedImage src={path} />, 0).width).toBeUndefined();
    expect(layerAt(<AnimatedImage src={path} width={80} height={60} fit="contain" />, 0)).toMatchObject({ width: 80, height: 60, fit: 'contain' });
  });

  it('loops by default, holds with pause-after-finish, and draws nothing after clear-after-finish', () => {
    const path = gif('two.gif', [10, 10]); // 0.2 s: 6 frames
    const at = (loopBehavior: any, frame: number) => layerAt(<AnimatedImage src={path} loopBehavior={loopBehavior} />, frame);
    expect(at(undefined, 7).time).toBeCloseTo(0.0005, 9); // 7/30 = 0.2333 -> 0.0333 -> picture 0
    expect(at('pause-after-finish', 30).time).toBeCloseTo(0.1005, 9);
    expect(at('clear-after-finish', 6)).toMatchObject({ type: 'gif' }); // 0.2 s is the end, not past it
    expect(renderAt(<AnimatedImage src={path} loopBehavior="clear-after-finish" />, 7).layers).toEqual([]);
  });

  it('runs at playbackRate, and a sequence loop over the whole file is the same as looping', () => {
    const path = gif('rate.gif', [10, 10, 10, 10]); // 0.4 s
    // 2x: frame 6 is 0.4 s of the file, which wraps to its start
    expect(layerAt(<AnimatedImage src={path} playbackRate={2} />, 6).time).toBeCloseTo(0.0005, 9);
    expect(layerAt(<AnimatedImage src={path} playbackRate={2} />, 3).time).toBeCloseTo(0.2005, 9);
    expect(layerAt(<AnimatedImage src={path} loop loopBehavior="pause-after-finish" />, 16).time).toBeCloseTo(0.1005, 9);
    expect(warn).not.toHaveBeenCalled();
  });

  it('starts at `from` and ends after durationInFrames (shortened by playbackRate)', () => {
    const path = gif('seq.gif', [10, 10, 10]);
    const image = <AnimatedImage src={path} from={10} durationInFrames={6} playbackRate={2} />;
    expect(renderAt(image, 9).layers).toEqual([]);
    expect(layerAt(image, 10).time).toBeCloseTo(0.0005, 9);
    expect(layerAt(image, 12).time).toBeCloseTo(0.1005, 9); // 2 frames x 2 / 30 s
    expect(renderAt(image, 13).layers).toEqual([]); // 6 / 2 = 3 frames long
  });

  it('is a div around the layer when it has CSS, sized to the file by default', () => {
    const path = gif('css.gif', [10, 10]);
    renderDom(<AnimatedImage src={path} className="pic" id="x" cropLeft={0.5} style={{ opacity: 0.5 }} />);
    const div = sent[0].root;
    expect(div).toMatchObject({ tag: 'div', attrs: { id: 'x', class: 'pic' } });
    expect(div.style).toBe('width: 40px; height: 30px; opacity: 0.5; clip-path: inset(0% 0% 0% 50%)');
    expect(div.children).toHaveLength(1);
    expect(div.children[0]).toMatchObject({ kind: 'native' });
  });

  it('reads a still image as one picture, and plays an animated PNG or WebP with the gif layer without warning', () => {
    const still = join(dir, 'still.png');
    writeFileSync(still, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...new Array(13 + 4).fill(0), 0, 0, 0, 0, 73, 68, 65, 84]));
    expect(layerAt(<AnimatedImage src={still} />, 0)).toMatchObject({ type: 'image', src: still });
    const apng = join(dir, 'anim.png');
    writeFileSync(apng, makeApng([[1, 10], [1, 10]], 40, 30));
    expect(layerAt(<AnimatedImage src={apng} />, 0)).toMatchObject({ type: 'gif', src: apng, loop: false });
    expect(layerAt(<AnimatedImage src={apng} />, 3).time).toBeCloseTo(0.1005, 9);
    const webp = join(dir, 'anim.webp');
    writeFileSync(webp, makeWebp([100, 100], 40, 30));
    expect(layerAt(<AnimatedImage src={webp} />, 0)).toMatchObject({ type: 'gif', src: webp, loop: false });
    expect(layerAt(<AnimatedImage src={webp} />, 3).time).toBeCloseTo(0.1005, 9);
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails for a missing file or a remote URL, or hands the error to onError and draws nothing', () => {
    expect(() => renderAt(<AnimatedImage src={join(dir, 'missing.gif')} />)).toThrow(/Could not read <AnimatedImage src=.*missing\.gif/);
    expect(() => renderAt(<AnimatedImage src="https://example.com/a.gif" />)).toThrow(/remote URLs are not available/);
    const onError = vi.fn();
    expect(renderAt(<AnimatedImage src={join(dir, 'missing.gif')} onError={onError} />).layers).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
