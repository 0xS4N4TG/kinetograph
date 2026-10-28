// @kinetographdev/motion on the real addon and the built CLI: a frame is the same alone, in sequence and at any
// concurrency, and the animation moves.
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
import { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { animate } from 'motion';
import { motion, useTransform } from 'motion/react';
import { MotionFrame, useAnimateAt, useMotionTime, useSpringAt } from '@kinetographdev/motion';

const box = { position: 'absolute' as const, left: 10, top: 30, width: 30, height: 30, borderRadius: 6 };

const Spring = () => (
  <AbsoluteFill style={{ background: '#f4efe6' }}>
    <MotionFrame>
      <motion.div initial={{ x: 0, rotate: 0 }} animate={{ x: 100, rotate: 180 }} transition={{ type: 'spring', stiffness: 60, damping: 8 }} style={{ ...box, background: '#e76f51' }} />
    </MotionFrame>
  </AbsoluteFill>
);

const Seek = () => {
  const ref = useRef<HTMLDivElement>(null);
  useAnimateAt(() => animate(ref.current!, { x: 100, opacity: [0.3, 1] }, { duration: 0.8, ease: 'easeInOut' }));
  return (
    <AbsoluteFill style={{ background: '#f4efe6' }}>
      <div ref={ref} style={{ ...box, background: '#264653' }} />
    </AbsoluteFill>
  );
};

const Pure = () => {
  const t = useMotionTime();
  const x = useTransform(t, [0, 1000], [0, 100]);
  const y = useSpringAt({ to: 30, stiffness: 60, damping: 8, delay: 5 });
  return (
    <AbsoluteFill style={{ background: '#f4efe6' }}>
      <motion.div style={{ ...box, background: '#e9c46a', x, y }} />
    </AbsoluteFill>
  );
};

// Motion with no MotionFrame: it plays on the Web Animations API (element.animate), which runs on the frame clock.
const Waapi = () => {
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    animate(a.current!, { backgroundColor: ['#ff0000', '#0000ff'], opacity: [0.2, 1], filter: ['blur(0px)', 'blur(4px)'] }, { duration: 0.8 });
    animate(b.current!, { transform: ['translateX(0px) rotate(0deg)', 'translateX(90px) rotate(180deg)'] }, { type: 'spring', stiffness: 80, damping: 10 });
  }, []);
  return (
    <AbsoluteFill style={{ background: '#f4efe6' }}>
      <div ref={a} style={{ ...box, background: '#888' }} />
      <div ref={b} style={{ ...box, top: 60, background: '#2a9d8f' }} />
    </AbsoluteFill>
  );
};

const common = { width: 160, height: 90, fps: 30, durationInFrames: 30 };
registerRoot(() => (
  <>
    <Composition id="Spring" component={Spring} {...common} />
    <Composition id="Seek" component={Seek} {...common} />
    <Composition id="Pure" component={Pure} {...common} />
    <Composition id="Waapi" component={Waapi} {...common} />
  </>
));
`;

// Inside this package's node_modules, which is ignored, so that `motion` and `@kinetographdev/motion` resolve from the workspace.
const dir = join(here, '..', 'node_modules', '.cache', 'render-test');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'index.tsx'), PROJECT);
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

describe.skipIf(!ready)('@kinetographdev/motion', () => {
  for (const comp of ['Spring', 'Seek', 'Pure', 'Waapi']) {
    it(`${comp}: the animation moves, and concurrency 1, 4 and a lone frame decode to the same frames`, () => {
      const one = render('index.tsx', comp, `${comp}-c1.mp4`, ['--concurrency', '1']);
      expect(one.status, one.log).toBe(0);
      const four = render('index.tsx', comp, `${comp}-c4.mp4`, ['--concurrency', '4']);
      expect(four.status, four.log).toBe(0);
      const seq = frames(`${comp}-c1.mp4`);
      expect(seq).toHaveLength(30);
      expect(frames(`${comp}-c4.mp4`)).toEqual(seq);
      expect(new Set(seq).size).toBeGreaterThan(10);
      for (const f of [0, 9, 17, 29]) {
        const alone = render('index.tsx', comp, `${comp}-f${f}.mp4`, ['--range', `${f}..=${f}`]);
        expect(alone.status, alone.log).toBe(0);
        expect(frames(`${comp}-f${f}.mp4`)).toEqual([seq[f]]);
      }
    });
  }
});
