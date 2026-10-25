// @kinetographdev/anime on the real addon and the built CLI: a frame is the same alone, in sequence and at any
// concurrency, the timeline moves, and an animation outside the timeline is warned about.
// Needs the built addon, `npm run build` (the CLI's and this package's dist), a GPU and ffmpeg; skipped where one is missing.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', '..', '..', 'cli', 'dist', 'cli.js');
const addon = (() => {
  try {
    createRequire(import.meta.url)('@kinetographdev/native');
    return true;
  } catch {
    return false;
  }
})();
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = addon && haveFfmpeg && existsSync(cli) && existsSync(join(here, '..', 'dist', 'index.js'));

const PROJECT = `
import { useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { animate } from 'animejs';
import { useAnimeTimeline, AnimeTimeline } from '@kinetographdev/anime';

const box = { position: 'absolute' as const, width: 30, height: 30, borderRadius: 6 };

const Scoped = () => {
  const scope = useAnimeTimeline((tl) => {
    tl.add('.a', { translateX: [0, 100], rotate: 180, backgroundColor: '#e76f51', ease: 'outExpo', duration: 600 }, 0)
      .add('.b', { translateY: [0, 30], scale: [1, 1.5], ease: 'inOutSine', duration: 700 }, 200);
  });
  return (
    <AbsoluteFill style={{ background: '#f4efe6' }}>
      <div ref={scope}>
        <div className="a" style={{ ...box, left: 10, top: 10, background: '#1d4e89' }} />
        <div className="b" style={{ ...box, left: 10, top: 50, background: '#2a9d8f' }} />
      </div>
    </AbsoluteFill>
  );
};

const Component = () => {
  const bar = useRef<HTMLDivElement>(null);
  return (
    <AbsoluteFill style={{ background: '#fbf8f1' }}>
      <AnimeTimeline build={(tl) => {
        tl.add(bar.current!, { width: [10, 100], opacity: [0.2, 1], ease: 'linear', duration: 900 }, 0);
      }}>
        <div ref={bar} style={{ position: 'absolute', left: 10, top: 40, width: 10, height: 20, background: '#264653' }} />
      </AnimeTimeline>
    </AbsoluteFill>
  );
};

const common = { width: 160, height: 90, fps: 30, durationInFrames: 30 };
registerRoot(() => (
  <>
    <Composition id="Scoped" component={Scoped} {...common} />
    <Composition id="Component" component={Component} {...common} />
  </>
));
`;

const STRAY = `
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { animate } from 'animejs';
import { useAnimeTimeline } from '@kinetographdev/anime';

const Stray = () => {
  const scope = useAnimeTimeline((tl) => {
    tl.add('.a', { translateX: [0, 50], duration: 500 }, 0);
    animate('.a', { translateY: [0, 30], duration: 500 });
  });
  return (
    <AbsoluteFill style={{ background: '#fff' }}>
      <div ref={scope}><div className="a" style={{ position: 'absolute', left: 10, top: 20, width: 30, height: 30, background: '#e63946' }} /></div>
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Stray" component={Stray} width={160} height={90} fps={30} durationInFrames={10} />);
`;

// Inside this package's node_modules, which is ignored, so that `animejs` and `@kinetographdev/anime` resolve from the workspace.
const dir = join(here, '..', 'node_modules', '.cache', 'render-test');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, "timeline.tsx"), PROJECT);
  writeFileSync(join(dir, 'stray.tsx'), STRAY);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const lossless = ['--encoder', 'libx264', '--crf', '0', '--pixel-format', 'yuv444p'];

function render(entry: string, comp: string, output: string, extra: string[] = []) {
  const run = spawnSync('node', [cli, 'render', join(dir, entry), '--comp', comp, '-o', join(dir, output), ...lossless, ...extra], { encoding: 'utf8' });
  return { status: run.status, log: run.stderr + run.stdout };
}

function frames(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, file), '-f', 'framemd5', '-'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l !== '' && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

describe.skipIf(!ready)('@kinetographdev/anime', () => {
  for (const comp of ['Scoped', 'Component']) {
    it(`${comp}: the timeline moves, and concurrency 1, 4 and a lone frame decode to the same frames`, () => {
      const one = render('timeline.tsx', comp, `${comp}-c1.mp4`, ['--concurrency', '1']);
      expect(one.status, one.log).toBe(0);
      expect(one.log).not.toMatch(/warn|Invalid scope/i);
      const four = render('timeline.tsx', comp, `${comp}-c4.mp4`, ['--concurrency', '4']);
      expect(four.status, four.log).toBe(0);
      const seq = frames(`${comp}-c1.mp4`);
      expect(seq).toHaveLength(30);
      expect(frames(`${comp}-c4.mp4`)).toEqual(seq);
      // Moves: the first and the last frame differ, and the frames in between are not all alike.
      expect(seq[0]).not.toBe(seq[29]);
      expect(new Set(seq).size).toBeGreaterThan(10);
      // A frame alone is the frame in sequence.
      for (const f of [0, 9, 17, 29]) {
        const alone = render('timeline.tsx', comp, `${comp}-f${f}.mp4`, ['--range', `${f}..=${f}`]);
        expect(alone.status, alone.log).toBe(0);
        expect(frames(`${comp}-f${f}.mp4`)).toEqual([seq[f]]);
      }
    });
  }

  it('warns once about an animation that is not on the timeline', () => {
    const run = render('stray.tsx', 'Stray', 'stray.mp4');
    expect(run.status, run.log).toBe(0);
    const warnings = run.log.split('\n').filter((l) => l.includes('useAnimeTimeline: 1 animation'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tl.add(...)');
  });
});
