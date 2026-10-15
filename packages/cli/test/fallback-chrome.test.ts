// Launches a real Chrome on the CPU against a tiny composition. Gated on KINETOGRAPH_CHROME (the cloud sets it to the
// pre-installed Chromium); nothing here opens a GPU device.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { native } from '../src/native.js';
import { openChromeRenderer, type ChromeFrame, type ChromeRenderer } from '../src/fallback/index.js';
import type { Source } from '../src/source.js';

const chrome = process.env.KINETOGRAPH_CHROME;
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const FONT = join(repo, 'assets/fonts/DMSans-Medium.ttf');
const CLIP = join(repo, 'crates/core/tests/scenes/media/clip.mp4');
const GIF = join(repo, 'crates/core/tests/scenes/media/spinner.gif');

const PROJECT = `
import { measureText } from '@remotion/layout-utils';
import { AbsoluteFill, Composition, Gif, Layer, Rect, Sequence, Text, Video, getInputProps, registerRoot, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

const Main = () => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const { word } = getInputProps();
  return (
    <AbsoluteFill style={{ backgroundColor: '#0000ff' }}>
      {/* DOM: a red box that moves with the frame. */}
      <div style={{ position: 'absolute', left: frame * 10, top: 20, width: 40, height: 30, background: '#ff0000' }} />
      {/* Native: a green rect, a white word, a clipped layer, a video and a GIF. AbsoluteFill stacks its children in a
          column, as CSS does; a plain group places them by their own x and y. */}
      <Layer>
      <Rect x={200} y={100} width={30} height={30} fill="#00ff00" />
      <Text font="DM Sans" size={40} color="#ffffff" x={10} y={110}>{word ?? 'Hello'}</Text>
      <Layer x={100} y={60} rotation={90}>
        <Rect width={40} height={20} fill="#ffff00" clip={{ kind: 'inset', right: 20 }} />
      </Layer>
      <Video src="clip.mp4" x={width - 64} y={0} width={64} height={36} />
      <Gif src="spinner.gif" x={250} y={60} width={32} height={24} />
      </Layer>
    </AbsoluteFill>
  );
};

const Clear = () => <div style={{ position: 'absolute', left: 10, top: 10, width: 20, height: 20, background: '#ff0000' }} />;

// measureText is synchronous: the page asks the driver, which asks the addon's text engine.
const Measured = () => {
  const { width } = measureText({ text: 'Hello', fontFamily: 'DM Sans', fontSize: 40 });
  return <div style={{ position: 'absolute', left: 0, top: 0, width: Math.round(width), height: 10, background: '#ff0000' }} />;
};

const Root = () => (
  <>
    <Composition id="Measured" component={Measured} width={200} height={20} fps={30} durationInFrames={1} />
    <Composition id="Main" component={Main} width={320} height={180} fps={30} durationInFrames={20} background="#101010" />
    <Composition id="Clear" component={Clear} width={64} height={36} fps={30} durationInFrames={5} />
  </>
);
registerRoot(Root);
`;

function pixel(frame: ChromeFrame, x: number, y: number): number[] {
  const i = (y * frame.width + x) * 4;
  return [...frame.data.subarray(i, i + 4)];
}

function near(actual: number[], expected: number[], tolerance = 2): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
}

describe.skipIf(!chrome)('the Chrome driver, against a real Chrome on the CPU', () => {
  let dir: string;
  const open: ChromeRenderer[] = [];
  const messages: string[] = [];

  const source = (composition: string, width: number, height: number, durationInFrames: number, inputProps = {}): Source => ({
    kind: 'project',
    entry: join(dir, 'index.tsx'),
    baseDir: dir,
    composition: { id: composition, width, height, fps: 30, durationInFrames, defaultProps: {} },
    async frame() {
      throw new Error('the driver does not draw natively');
    },
    inputProps,
    fonts: () => ({ 'DM Sans': FONT }),
    publicDir: join(dir, 'public'),
    dispose() {},
  });
  const start = async (...args: Parameters<typeof source>): Promise<ChromeRenderer> => {
    const renderer = await openChromeRenderer(source(...args), { progress: (m) => messages.push(m) });
    open.push(renderer);
    return renderer;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kinetograph-chrome-'));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'index.tsx'), PROJECT);
    copyFileSync(CLIP, join(dir, 'clip.mp4'));
    copyFileSync(GIF, join(dir, 'spinner.gif'));
  });
  afterAll(async () => {
    await Promise.all(open.map((r) => r.close()));
  });

  it('draws DOM and native elements as straight-alpha RGBA at the composition\'s size', async () => {
    const renderer = await start('Main', 320, 180, 20);
    const first = await renderer.frame(0);
    expect([first.width, first.height, first.data.length]).toEqual([320, 180, 320 * 180 * 4]);
    // The DOM box at frame 0 is at x 0..40, y 20..50: red over the AbsoluteFill's blue.
    near(pixel(first, 5, 30), [255, 0, 0, 255]);
    near(pixel(first, 100, 30), [0, 0, 255, 255]);
    // The native rect.
    near(pixel(first, 215, 115), [0, 255, 0, 255]);

    // The clock moved: ten pixels a frame. Frames may come in any order.
    const third = await renderer.frame(3);
    near(pixel(third, 5, 30), [0, 0, 255, 255]);
    near(pixel(third, 50, 30), [255, 0, 0, 255]);
    const again = await renderer.frame(0);
    near(pixel(again, 5, 30), [255, 0, 0, 255]);
    expect(again.data.equals(first.data)).toBe(true);
  }, 120_000);

  it('rotates and clips a native layer as the engine does', async () => {
    const renderer = await start('Main', 320, 180, 20);
    const frame = await renderer.frame(0);
    // A 40x20 yellow rect, cut to its left 20 pixels, in a layer at (100, 60) turned 90 degrees clockwise about its
    // top-left corner: it covers x 80..100, y 60..80. The cut-off half would have covered y 80..100.
    near(pixel(frame, 90, 70), [255, 255, 0, 255]);
    near(pixel(frame, 90, 90), [0, 0, 255, 255]);
    near(pixel(frame, 110, 70), [0, 0, 255, 255]);
  }, 120_000);

  it('sets text in the registered font', async () => {
    const renderer = await start('Main', 320, 180, 20, { word: 'Hello' });
    const frame = await renderer.frame(0);
    let white = 0;
    for (let y = 110; y < 160; y++) {
      // Anything that is not the blue behind it: the glyphs, anti-aliased.
      for (let x = 10; x < 140; x++) if (pixel(frame, x, y)[0]! > 128) white++;
    }
    expect(white).toBeGreaterThan(150);
    // Input props reach the page: another word draws other pixels.
    const other = await (await start('Main', 320, 180, 20, { word: 'W' })).frame(0);
    expect(other.data.equals(frame.data)).toBe(false);
  }, 120_000);

  it('shows the pictures of a video and a GIF that the addon decodes', async () => {
    const renderer = await start('Main', 320, 180, 20);
    const frame = await renderer.frame(0);
    const clip = native().videoFrame(join(dir, 'clip.mp4'), 0);
    // The video at (256, 0), drawn at its own size.
    near(pixel(frame, 256, 0), [clip.data[0]!, clip.data[1]!, clip.data[2]!, 255], 3);
    near(pixel(frame, 256 + 40, 20), [...clip.data.subarray((20 * 64 + 40) * 4, (20 * 64 + 40) * 4 + 4)], 3);
    // Later frames show other pictures of the clip.
    const later = await renderer.frame(12);
    expect(pixel(later, 256 + 10, 10)).not.toEqual(pixel(frame, 256 + 10, 10));
    const spinner = native().videoFrame(join(dir, 'spinner.gif'), 0);
    near(pixel(frame, 255, 65), [...spinner.data.subarray((5 * 32 + 5) * 4, (5 * 32 + 5) * 4 + 4)], 3);
  }, 120_000);

  it('omits the background of a transparent composition', async () => {
    const renderer = await start('Clear', 64, 36, 5);
    const frame = await renderer.frame(0);
    expect(pixel(frame, 50, 30)[3]).toBe(0);
    near(pixel(frame, 15, 15), [255, 0, 0, 255]);
  }, 120_000);

  it('lets the project measure text with the engine\'s own text engine', async () => {
    const renderer = await start('Measured', 200, 20, 1);
    const frame = await renderer.frame(0);
    const expected = Math.round(
      native().layoutText({ text: 'Hello', font: 'DM Sans', size: 40, fonts: { 'DM Sans': FONT } }).width,
    );
    expect(expected).toBeGreaterThan(50);
    near(pixel(frame, expected - 2, 5), [255, 0, 0, 255]);
    expect(pixel(frame, expected + 2, 5)[3]).toBe(0);
  }, 120_000);

  it('draws at a fraction of the size for a draft', async () => {
    const renderer = await openChromeRenderer(source('Main', 320, 180, 20), { scale: 0.5 });
    open.push(renderer);
    const frame = await renderer.frame(0);
    expect([frame.width, frame.height]).toEqual([160, 90]);
    near(pixel(frame, 2, 15), [255, 0, 0, 255]);
  }, 120_000);

  it('says which frame failed and why', async () => {
    const renderer = await start('Main', 320, 180, 20);
    await expect(renderer.frame(99)).rejects.toMatchObject({
      code: 'CHROME_FRAME_FAILED',
      message: expect.stringMatching(/frame 99.*outside composition/s),
    });
    // The page survives a bad frame.
    near(pixel(await renderer.frame(0), 5, 30), [255, 0, 0, 255]);
  }, 120_000);

  it('refuses a .json scene, and a composition that does not exist', async () => {
    await expect(openChromeRenderer({ ...source('Main', 320, 180, 20), kind: 'scene' })).rejects.toMatchObject({ code: 'INVALID_ARG' });
    await expect(openChromeRenderer(source('Nope', 64, 36, 1))).rejects.toMatchObject({
      code: 'CHROME_FAILED',
      message: expect.stringContaining('No composition with the id "Nope"'),
    });
  }, 120_000);
});
