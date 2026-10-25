// @kinetographdev/gsap on the real addon and the built CLI: a frame is the same alone, in sequence and at any
// concurrency, the timeline moves, onUpdate runs on a seek, and a tween outside the timeline is warned about.
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

const TIMELINE = `
import { useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { gsap } from 'gsap';
import { useGsapTimeline, GsapTimeline } from '@kinetographdev/gsap';

const Refs = () => {
  const box = useRef<HTMLDivElement>(null);
  useGsapTimeline((tl) => {
    tl.to(box.current, { x: 100, rotation: 90, scale: 1.5, backgroundColor: '#3a86ff', duration: 0.8, ease: 'power2.out' }, 0.1);
    tl.to(box.current, { y: 20, yoyo: true, repeat: 3, duration: 0.1 }, 0.5);
  });
  return (
    <AbsoluteFill style={{ background: '#f7f3e9' }}>
      <div ref={box} style={{ position: 'absolute', left: 10, top: 20, width: 30, height: 30, background: '#ff5a5f' }} />
    </AbsoluteFill>
  );
};

const Scoped = () => {
  const scope = useGsapTimeline((tl) => {
    tl.fromTo('.b', { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.1, ease: 'back.out(1.7)' }, 0.05);
  });
  return (
    <AbsoluteFill style={{ background: '#fbf8f1' }}>
      <div ref={scope}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="b" style={{ position: 'absolute', left: 10 + i * 36, top: 30, width: 28, height: 28, background: '#2a9d8f' }} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Events = () => {
  const bar = useRef<HTMLDivElement>(null);
  return (
    <AbsoluteFill style={{ background: '#fbf8f1' }}>
      <GsapTimeline
        build={(tl) => {
          const o = { v: 0 };
          gsap.set(bar.current, { x: 0 });
          tl.to(o, { v: 100, duration: 1, ease: 'none', onUpdate: () => { if (bar.current) bar.current.style.width = Math.round(o.v) + 'px'; } }, 0);
        }}
      >
        <div ref={bar} style={{ position: 'absolute', left: 10, top: 40, width: 0, height: 20, background: '#264653' }} />
      </GsapTimeline>
    </AbsoluteFill>
  );
};

const common = { width: 160, height: 90, fps: 30, durationInFrames: 30 };
registerRoot(() => (
  <>
    <Composition id="Refs" component={Refs} {...common} />
    <Composition id="Scoped" component={Scoped} {...common} />
    <Composition id="Events" component={Events} {...common} />
  </>
));
`;

const STRAY = `
import { useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { gsap } from 'gsap';
import { useGsapTimeline } from '@kinetographdev/gsap';

const Stray = () => {
  const box = useRef<HTMLDivElement>(null);
  useGsapTimeline((tl) => {
    tl.to(box.current, { x: 50, duration: 0.5 });
    gsap.to(box.current, { y: 30, duration: 0.5 });
  });
  return (
    <AbsoluteFill style={{ background: '#fff' }}>
      <div ref={box} style={{ position: 'absolute', left: 10, top: 20, width: 30, height: 30, background: '#e63946' }} />
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Stray" component={Stray} width={160} height={90} fps={30} durationInFrames={10} />);
`;

// Inside this package's node_modules, which is ignored, so that `gsap` and `@kinetographdev/gsap` resolve from the workspace.
const dir = join(here, '..', 'node_modules', '.cache', 'render-test');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'timeline.tsx'), TIMELINE);
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

describe.skipIf(!ready)('@kinetographdev/gsap', () => {
  for (const comp of ['Refs', 'Scoped', 'Events']) {
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

  it('warns once about a tween that is not on the timeline and not paused', () => {
    const run = render('stray.tsx', 'Stray', 'stray.mp4');
    expect(run.status, run.log).toBe(0);
    const warnings = run.log.split('\n').filter((l) => l.includes('useGsapTimeline: 1 tween'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tl.to(...)');
  });
});
