// @kinetographdev/gsap on the real addon and the built CLI: a frame is the same alone, in sequence and at any
// concurrency, the timeline moves, onUpdate runs on a seek, and a tween outside the timeline plays on the frame's clock.
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

// Tweens that play by themselves, with no paused timeline: GSAP's root clock follows the frame (packages/core/src/gsap-clock.ts).
// `Auto` makes one from the mount and one from an effect that runs at frame 30; `Seeked` is the same animation as a paused
// timeline seeked to the frame, the second tween placed at 1 s. Both start at the same instant, so they are the same frames.
const AUTO = `
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { gsap } from 'gsap';

const boxes = (a: React.Ref<HTMLDivElement>, b: React.Ref<HTMLDivElement>) => (
  <AbsoluteFill style={{ background: '#fff' }}>
    <div ref={a} style={{ position: 'absolute', left: 10, top: 10, width: 30, height: 30, background: '#2238c4' }} />
    <div ref={b} style={{ position: 'absolute', left: 10, top: 50, width: 30, height: 30, background: '#2a9d8f' }} />
  </AbsoluteFill>
);

const Auto = () => {
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  const frame = useCurrentFrame();
  useEffect(() => {
    const tween = gsap.to(a.current, { x: 100, rotation: 45, duration: 1, ease: 'power2.out' });
    return () => { tween.kill(); };
  }, []);
  const late = frame >= 30;
  useEffect(() => {
    if (!late) return;
    const tween = gsap.to(b.current, { x: 100, duration: 1, ease: 'none' });
    return () => { tween.kill(); };
  }, [late]);
  return boxes(a, b);
};

const Seeked = () => {
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  useLayoutEffect(() => {
    const t = gsap.timeline({ paused: true });
    t.to(a.current, { x: 100, rotation: 45, duration: 1, ease: 'power2.out' }, 0);
    t.to(b.current, { x: 100, duration: 1, ease: 'none' }, 30 / fps);
    tl.current = t;
    return () => { t.kill(); };
  }, [fps]);
  useLayoutEffect(() => { tl.current?.seek(frame / fps, false); }, [frame, fps]);
  return boxes(a, b);
};

// Staggers, repeat/yoyo, a delayedCall that builds a timeline in its callback, an onComplete that starts a tween, and a
// sequence that mounts at frame 20 and starts its tween there.
const Busy = () => {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from('.c', { y: 20, opacity: 0, duration: 0.4, stagger: { each: 0.05, from: 'center' }, ease: 'back.out(1.7)' });
      gsap.to('.c:nth-child(2n)', { rotation: 90, backgroundColor: '#ffbe0b', duration: 0.2, repeat: 5, yoyo: true, delay: 0.3 });
      gsap.delayedCall(0.5, () => {
        gsap.timeline({ onComplete: () => { gsap.to('.c:nth-child(3n)', { x: 12, duration: 0.4 }); } })
          .to('.c:nth-child(3n+1)', { borderRadius: 10, duration: 0.3 })
          .to('.c:nth-child(4n)', { y: -8, duration: 0.2, stagger: 0.03 });
      });
    }, root);
    return () => ctx.revert();
  }, []);
  return (
    <AbsoluteFill style={{ background: '#fff' }}>
      <div ref={root} style={{ position: 'absolute', left: 6, top: 6, width: 150, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {Array.from({ length: 12 }, (_, i) => <div key={i} className="c" style={{ width: 20, height: 20, background: i % 2 ? '#2238c4' : '#e0261b' }} />)}
      </div>
      <Sequence from={20}><Late /></Sequence>
    </AbsoluteFill>
  );
};
const Late = () => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = gsap.to(box.current, { x: 60, rotation: 45, duration: 0.8, ease: 'power2.out', repeat: 1, yoyo: true });
    return () => { t.kill(); };
  }, []);
  return <div ref={box} style={{ position: 'absolute', left: 10, top: 62, width: 20, height: 20, background: '#2a9d8f' }} />;
};

const common = { width: 160, height: 90, fps: 30, durationInFrames: 60 };
registerRoot(() => (
  <>
    <Composition id="Auto" component={Auto} {...common} />
    <Composition id="Seeked" component={Seeked} {...common} />
    <Composition id="Busy" component={Busy} {...common} />
  </>
));
`;

// Flip on a paused timeline seeked to the frame (getState, change the layout, Flip.from), checked against Chrome by hand:
// mean difference 0 at frames 0, 15, 30, 45 and 59 of a 900x420 version.
const FLIP = `
import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame, useVideoConfig } from 'remotion';
import gsap from 'gsap';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(Flip);

// Flip on a paused timeline seeked to the frame: getState, change the layout, Flip.from.
const F: React.FC = () => {
  const root = useRef<HTMLDivElement>(null);
  const tl = useRef<gsap.core.Timeline | null>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  useLayoutEffect(() => {
    const items = gsap.utils.toArray<HTMLElement>('.item', root.current!);
    const state = Flip.getState(items);
    // The change: a row of small boxes becomes a column of bigger ones, in another order.
    root.current!.style.flexDirection = 'column';
    root.current!.style.alignItems = 'flex-end';
    items.forEach((el, i) => {
      el.style.width = (60 + i * 20) + 'px';
      el.style.height = '30px';
    });
    items.reverse().forEach((el) => root.current!.appendChild(el));
    const t = Flip.from(state, { duration: 1, ease: 'none', absolute: false });
    t.pause(0);
    tl.current = t;
    return () => {
      t.kill();
    };
  }, []);
  useLayoutEffect(() => {
    tl.current?.seek(frame / fps, false);
  }, [frame, fps]);
  const box = (c: string, w: number) => <div className="item" style={{ width: w, height: 40, background: c, marginRight: 6 }} />;
  return (
    <AbsoluteFill style={{ background: 'white' }}>
      <div ref={root} style={{ position: 'absolute', left: 10, top: 10, width: 280, display: 'flex', flexDirection: 'row', gap: 10 }}>
        {box('#e0261b', 40)}
        {box('#2238c4', 60)}
        {box('#2a9d8f', 30)}
      </div>
    </AbsoluteFill>
  );
};
registerRoot(() => <Composition id="Flip" component={F} width={320} height={180} fps={30} durationInFrames={30} />);
`;

// Inside this package's node_modules, which is ignored, so that `gsap` and `@kinetographdev/gsap` resolve from the workspace.
const dir = join(here, '..', 'node_modules', '.cache', 'render-test');
beforeAll(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"p","private":true}');
  writeFileSync(join(dir, 'timeline.tsx'), TIMELINE);
  writeFileSync(join(dir, 'auto.tsx'), AUTO);
  writeFileSync(join(dir, 'flip.tsx'), FLIP);
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

  it('Auto: tweens that play by themselves move, and are the same alone, at any concurrency, and as a paused timeline seeked', () => {
    const one = render('auto.tsx', 'Auto', 'Auto-c1.mp4', ['--concurrency', '1']);
    expect(one.status, one.log).toBe(0);
    const four = render('auto.tsx', 'Auto', 'Auto-c4.mp4', ['--concurrency', '4']);
    expect(four.status, four.log).toBe(0);
    const seq = frames('Auto-c1.mp4');
    expect(seq).toHaveLength(60);
    expect(frames('Auto-c4.mp4')).toEqual(seq);
    // The mount tween moves (frames 0..29 differ), the late one starts at 30 and the frame before it has not moved.
    expect(new Set(seq.slice(0, 30)).size).toBeGreaterThan(15);
    expect(new Set(seq.slice(30)).size).toBeGreaterThan(15);
    // A frame alone is the frame in sequence, before, at and after the frame the effect runs at.
    for (const f of [1, 29, 30, 31, 45, 59]) {
      const alone = render('auto.tsx', 'Auto', `Auto-f${f}.mp4`, ['--range', `${f}..=${f}`]);
      expect(alone.status, alone.log).toBe(0);
      expect(frames(`Auto-f${f}.mp4`), `frame ${f}`).toEqual([seq[f]]);
    }
    const seeked = render('auto.tsx', 'Seeked', 'Seeked-c1.mp4', ['--concurrency', '1']);
    expect(seeked.status, seeked.log).toBe(0);
    expect(frames('Seeked-c1.mp4')).toEqual(seq);
  });

  it('Busy: staggers, repeats, callbacks that make timelines and a late mount are the same alone, at any concurrency', () => {
    const one = render('auto.tsx', 'Busy', 'Busy-c1.mp4', ['--concurrency', '1']);
    expect(one.status, one.log).toBe(0);
    // Tweens on the root clock are warned about once.
    expect(one.log.split('\n').filter((l) => l.includes("GSAP's root clock"))).toHaveLength(1);
    const four = render('auto.tsx', 'Busy', 'Busy-c4.mp4', ['--concurrency', '4']);
    expect(four.status, four.log).toBe(0);
    const seq = frames('Busy-c1.mp4');
    expect(seq).toHaveLength(60);
    expect(frames('Busy-c4.mp4')).toEqual(seq);
    expect(new Set(seq).size).toBeGreaterThan(30);
    for (const f of [1, 9, 15, 16, 20, 21, 33, 45, 59]) {
      const alone = render('auto.tsx', 'Busy', `Busy-f${f}.mp4`, ['--range', `${f}..=${f}`]);
      expect(alone.status, alone.log).toBe(0);
      expect(frames(`Busy-f${f}.mp4`), `frame ${f}`).toEqual([seq[f]]);
    }
  });

  it('Flip: a paused timeline from Flip.from moves, and a frame alone or at concurrency 4 is the frame in sequence', () => {
    const one = render('flip.tsx', 'Flip', 'Flip-c1.mp4', ['--concurrency', '1']);
    expect(one.status, one.log).toBe(0);
    const four = render('flip.tsx', 'Flip', 'Flip-c4.mp4', ['--concurrency', '4']);
    expect(four.status, four.log).toBe(0);
    const seq = frames('Flip-c1.mp4');
    expect(seq).toHaveLength(30);
    expect(frames('Flip-c4.mp4')).toEqual(seq);
    expect(new Set(seq).size).toBeGreaterThan(15);
    for (const f of [0, 14, 29]) {
      const alone = render('flip.tsx', 'Flip', `Flip-f${f}.mp4`, ['--range', `${f}..=${f}`]);
      expect(alone.status, alone.log).toBe(0);
      expect(frames(`Flip-f${f}.mp4`)).toEqual([seq[f]]);
    }
  });
});
