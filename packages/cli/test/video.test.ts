import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaInfo } from '@kinetographdev/native';
import { setNativeForTests } from '../src/native.js';
import { openSource } from '../src/source.js';
import { fakeNative } from './helpers.js';

afterEach(() => setNativeForTests(undefined));

// A real project, bundled with the real aliases and run through the real core, on a stand-in addon. Its length comes
// from the video's header, as a Remotion project would do it.
const PROJECT = `
import { AbsoluteFill, Composition, registerRoot, Sequence, staticFile, Video, OffthreadVideo } from 'remotion';
import { Gif } from '@remotion/gif';
import { getVideoMetadata } from '@remotion/media-utils';

const Main = () => (
  <AbsoluteFill>
    <Sequence from={10}>
      <Video id="city" src="clips/city.mp4" trimBefore={5} volume={0.5} style={{ width: 64, height: 36, objectFit: 'cover' }} />
      <OffthreadVideo id="other" src={staticFile('b.mp4')} muted />
      <Gif id="spin" src="spin.gif" loopBehavior="unmount-after-finish" />
    </Sequence>
  </AbsoluteFill>
);
registerRoot(() => (
  <Composition
    id="Main" component={Main} width={64} height={36} fps={30} durationInFrames={1}
    calculateMetadata={async () => {
      const { durationInSeconds } = await getVideoMetadata('clips/city.mp4');
      return { durationInFrames: Math.round(durationInSeconds * 30) };
    }}
  />
));
`;

const info = (over: Partial<MediaInfo>): MediaInfo => ({
  kind: 'video', width: 1920, height: 1080, durationInSeconds: 4, fps: 25, frames: 100, hasAudio: true, ...over,
});

describe('a project with <Video> and <Gif>, bundled and run', () => {
  it('reaches the addon through setMediaProbe with the entry directory as base, and renders the layers and sound', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinetograph-cli-video-'));
    writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
    writeFileSync(join(dir, 'index.tsx'), PROJECT);
    const probed: { path: string; baseDir: string | null | undefined }[] = [];
    const { native } = fakeNative({
      probeMedia: (path: string, baseDir?: string | null) => {
        probed.push({ path, baseDir });
        return path.endsWith('.gif') ? info({ kind: 'gif', durationInSeconds: 0.5, fps: undefined, hasAudio: false }) : info({});
      },
    });
    setNativeForTests(native);

    const source = await openSource(join(dir, 'index.tsx'));
    // getVideoMetadata ran in calculateMetadata: 4 s at 30 fps.
    expect(source.composition.durationInFrames).toBe(120);
    expect(probed).toEqual([{ path: 'clips/city.mp4', baseDir: dir }]);

    // Frame 12 is 2 frames into the Sequence: the GIF (0.5 s) is still playing.
    const early = await source.frame(12);
    const scene = JSON.parse(early.sceneJson);
    const inSequence = scene.layers[0].children[0].children;
    expect(inSequence).toEqual([
      expect.objectContaining({ id: 'city', type: 'video', src: 'clips/city.mp4', from: 10, trimBefore: 5, width: 64, height: 36, fit: 'cover' }),
      expect.objectContaining({ id: 'other', type: 'video', src: join(dir, 'public', 'b.mp4'), from: 10 }),
      expect.objectContaining({ id: 'spin', type: 'gif', src: 'spin.gif', loop: false }),
    ]);
    expect(early.audio).toEqual([
      expect.objectContaining({ id: 'city', video: true, from: 10, trimBefore: 5, volume: 0.5, muted: false }),
      expect.objectContaining({ id: 'other', video: true, muted: true }),
    ]);
    expect(probed.at(-1)).toEqual({ path: 'spin.gif', baseDir: dir });

    // 15 frames in is half a second: the GIF is gone, the videos are not.
    const late = JSON.parse((await source.frame(25)).sceneJson);
    expect(late.layers[0].children[0].children.map((l: { id: string }) => l.id)).toEqual(['city', 'other']);
    source.dispose();
  });
});
