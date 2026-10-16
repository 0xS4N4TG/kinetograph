// Style frames for the launch storyboard: each shot as a real composition, rendered by Kinetograph, so the board
// shows what the engine draws rather than sketches of it. The shots animate; the board takes one or two stills each.

import React from 'react';
import { AbsoluteFill, Composition, Img, interpolate, random, registerRoot, staticFile, useCurrentFrame, Easing } from 'remotion';
import { loadFont as loadDMSans } from '@remotion/google-fonts/DMSans';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { Camera3D, DirectionalLight, Image, Layer, Model, Rect, Scene3D, glow, gradientMap, grain } from '@kinetograph/core';
import { LogoFlicker } from '@/components/snap-cn/logo-flicker';

const W = 1920;
const H = 1080;
const FPS = 30;

const SANS = loadDMSans('normal', { weights: ['400', '500', '700'] }).fontFamily;
const MONO = loadMono('normal', { weights: ['400', '500'] }).fontFamily;

const PAPER = '#ECEAE6';
const INK = '#111111';
const RED = '#E0261B';
const MUSTARD = '#D9A621';
const CLAMP = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const OUT = Easing.bezier(0.16, 1, 0.3, 1);

/** Our own renders (showcase, showcase-3d, rajz cards, papercut ep13), the picture pool of the collage and flicker. */
const POOL = [
  '01-showcase-v1', '02-showcase-v1', '03-showcase-v1', '04-showcase-v1', '06-showcase-v1', '07-showcase-v1',
  '08-showcase-v1', '10-showcase-v1', '11-showcase-3d', '12-showcase-3d', '13-showcase-3d', '15-rajz-cards',
  '16-ep13-5s', '17-ep13-5s', '18-ep13-5s', '19-open-v4',
].map((n) => staticFile(`pool/${n}.jpg`));

/** Paper texture and vignette over a paper scene. */
const PaperGround: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: PAPER }} />
    <Img src={staticFile('fx/grunge-06.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'multiply', opacity: 0.22 }} />
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.22) 100%)' }} />
  </>
);

/** Gate dust over an ink scene. */
const InkGround: React.FC = () => (
  <>
    <AbsoluteFill style={{ background: INK }} />
    <Img src={staticFile('fx/grunge-02.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'screen', opacity: 0.5 }} />
  </>
);

/** A line that builds word by word: each word blurs in over 4 frames, `per` frames apart. */
const Build: React.FC<{ words: string[]; start: number; per: number; color: string; size: number; style?: React.CSSProperties }> = ({
  words, start, per, color, size, style,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: size, color, letterSpacing: '-0.01em', display: 'flex', gap: size * 0.26, ...style }}>
      {words.map((w, i) => {
        const t = interpolate(frame, [start + i * per, start + i * per + 4], [0, 1], CLAMP);
        return <span key={i} style={{ opacity: t, filter: `blur(${(1 - t) * 6}px)` }}>{w}</span>;
      })}
    </div>
  );
};

// ---- shot 1: "how" ----
const S01: React.FC = () => (
  <AbsoluteFill style={{ background: MUSTARD, alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 96, borderTop: `6px dashed ${INK}` }} />
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 96, borderTop: `6px dashed ${INK}` }} />
    <div style={{ fontFamily: SANS, fontWeight: 700, fontSize: 560, color: '#2a210f', letterSpacing: '-0.05em', lineHeight: 1, marginTop: -60 }}>how</div>
  </AbsoluteFill>
);

// ---- shot 2: the question, with an ink stroke writing itself ----
const S02: React.FC = () => {
  const frame = useCurrentFrame();
  const words = 'how do you make a video without a browser?'.split(' ');
  const draw = interpolate(frame, [40, 62], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill>
      <PaperGround />
      <Build words={words} start={4} per={4} color={INK} size={58} style={{ position: 'absolute', left: 300, top: 600 }} />
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path
          d="M1268 690 C1320 712 1372 662 1420 694 S1520 732 1580 676 C1606 652 1618 700 1652 692"
          fill="none" stroke={INK} strokeWidth={6} strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw}
        />
        <path d="M1470 740 c18 -36 36 36 54 0 s28 -28 46 8" fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" opacity={0.5} pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw} />
      </svg>
    </AbsoluteFill>
  );
};

/** A browser window drawn in CSS, holding one of our frames: what other tools screenshot. */
const BrowserWindow: React.FC<{ src: string; w: number; style?: React.CSSProperties }> = ({ src, w, style }) => {
  const h = w * 0.62;
  return (
    <div style={{ position: 'absolute', width: w, height: h, borderRadius: 14, overflow: 'hidden', background: '#202124', boxShadow: '0 30px 80px rgba(0,0,0,0.45)', ...style }}>
      <div style={{ height: 44, display: 'flex', alignItems: 'center', gap: 9, padding: '0 16px', background: '#2b2c2f' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}
        <div style={{ marginLeft: 18, flex: 1, height: 26, borderRadius: 13, background: '#3a3b3e', color: '#aaa', fontFamily: MONO, fontSize: 14, display: 'flex', alignItems: 'center', paddingLeft: 14 }}>
          localhost:3000/render?frame=0047
        </div>
      </div>
      <Img src={src} style={{ width: w, height: h - 44, objectFit: 'cover' }} />
    </div>
  );
};

// ---- shot 3: every frame, a screenshot ----
const S03: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.floor(frame / 2);
  return (
    <AbsoluteFill>
      <InkGround />
      {[0, 1, 2].map((k) => (
        <BrowserWindow key={k} src={POOL[(n + k * 5) % POOL.length]} w={980} style={{ left: 420 + k * 54, top: 170 + k * 40, transform: `rotate(${(k - 1) * 3}deg)`, opacity: 0.55 + k * 0.22 }} />
      ))}
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, background: '#fff', opacity: frame % 6 === 0 ? 0.35 : 0 }} />
      <div style={{ position: 'absolute', left: -200, top: 330, width: 2400, height: 22, background: RED, transform: 'rotate(-9deg)', opacity: 0.9 }} />
      <div style={{ position: 'absolute', right: 120, top: 90, fontFamily: MONO, fontSize: 34, color: '#ddd' }}>
        screenshot {String(47 + n).padStart(4, '0')} / 1350
      </div>
      <Build words={['every', 'frame.', 'a', 'screenshot.']} start={0} per={0} color={PAPER} size={56} style={{ position: 'absolute', left: 140, top: 930 }} />
    </AbsoluteFill>
  );
};

// ---- shot 4: the browser drains away in the showcase's pixel melt, onto paper ----
// The melt (from examples/showcase, shot 1): the picture's top edge falls in columns of 40 px, in steps of 24 px,
// leading on the left, with a rim of bright cells; what is behind is left.
const COLS = 48;
const CELL_W = W / COLS;
const CELL_H = 24;
const RIM = ['#ffe9b8', '#f5902a', '#E0261B', '#ECEAE6', '#ffd166'];
const MELT_FRAMES = 34;

function meltTops(frame: number): number[] | null {
  const t = frame / MELT_FRAMES;
  if (t <= 0) return null;
  const base = -420 + (H + 600) * Math.pow(Math.min(1, t), 1.35);
  return Array.from({ length: COLS }, (_, c) => {
    const u = c / (COLS - 1);
    const wave = 95 * Math.sin(u * 7.5 + t * 4.2) + 45 * Math.sin(u * 19 - t * 6.5 + 1.3) + (random(`melt-${c}`) - 0.5) * 40;
    return Math.floor((base + (1 - u) * 380 + wave) / CELL_H) * CELL_H;
  });
}

function meltClip(tops: number[]) {
  const points: [number, number][] = [];
  tops.forEach((y, c) => points.push([c * CELL_W, y], [(c + 1) * CELL_W, y]));
  points.push([W, H + 40], [0, H + 40]);
  return { kind: 'polygon' as const, points };
}

const MeltRim: React.FC<{ tops: number[] }> = ({ tops }) => (
  <>
    {tops.flatMap((y, c) => {
      if (y >= H) return [];
      const below = Math.max(tops[c - 1] ?? y, tops[c + 1] ?? y);
      const rows = Math.min(3, Math.max(1, Math.round((below - y) / CELL_H)));
      return Array.from({ length: rows }, (_, j) => {
        const row = Math.round(y / CELL_H) + j;
        if (random(`rim-${c}-${row}`) > 0.72) return null;
        const color = RIM[Math.floor(random(`rim-c-${c}-${row}`) * RIM.length)]!;
        return <Rect key={`${c}-${j}`} x={c * CELL_W} y={y + j * CELL_H} width={CELL_W} height={CELL_H} fill={color} />;
      });
    })}
  </>
);

const S04: React.FC = () => {
  const frame = useCurrentFrame();
  const tops = meltTops(frame - 4);
  return (
    <>
      <AbsoluteFill>
        <PaperGround />
        <Build words={['you', 'don\u2019t.']} start={26} per={5} color={INK} size={80} style={{ position: 'absolute', left: 0, right: 0, top: 490, justifyContent: 'center' }} />
      </AbsoluteFill>
      <Layer id="melt" clip={tops ? meltClip(tops) : undefined}>
        <Image src={staticFile('stills/s03-frame.png')} width={W} height={H} />
      </Layer>
      {tops ? <MeltRim tops={tops} /> : null}
    </>
  );
};

/** The thermal duotone of the reference reel: shadows to deep red, mids orange, highlights pale gold. */
const THERMAL = gradientMap({
  stops: [
    { offset: 0, color: '#0d0605' },
    { offset: 0.18, color: '#5a0d08' },
    { offset: 0.42, color: '#d42a14' },
    { offset: 0.68, color: '#f5902a' },
    { offset: 1, color: '#ffe9b8' },
  ],
});

// ---- shot 5: the real camera (Poly Haven "Vintage Video Camera", CC0) in the thermal grade ----
const S05: React.FC<{ graded?: boolean }> = ({ graded = true }) => {
  const frame = useCurrentFrame();
  const orbit = interpolate(frame, [6, 40], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <>
      <Rect width={W} height={H} fill={INK} />
      <Scene3D
        id="camera" width={W} height={H}
        environment={{ src: staticFile('hdri/studio_small_08_1k.hdr'), intensity: 0.6 }}
        effects={graded ? [THERMAL, glow({ radius: 40, intensity: 0.5 }), grain(0.05, { seed: 3 })] : []}
      >
        <Camera3D fov={24} position={[0.3, 0.13, 0.36]} target={[-0.045, 0.07, 0.0]} />
        <DirectionalLight direction={[0.7, -0.6, -0.5]} intensity={2.6} castShadow />
        <DirectionalLight direction={[-0.9, -0.1, 0.6]} intensity={1.4} />
        <Model src={staticFile('models/vintage_video_camera/vintage_video_camera_2k.gltf')} rotation={[0, -25 + frame * 0.6, 0]} />
      </Scene3D>
      {graded && (
        <AbsoluteFill>
          <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
            <ellipse cx={1150} cy={560} rx={560} ry={150} transform="rotate(-14 1150 560)" fill="none" stroke={PAPER} strokeWidth={4} pathLength={1} strokeDasharray="1 1" strokeDashoffset={orbit} />
          </svg>
          <Img src={staticFile('fx/hand-film.png')} style={{ position: 'absolute', left: 980, top: 600, width: 860, height: 484, mixBlendMode: 'screen', opacity: 0.95 }} />
          <Build words={['you', 'just', 'render', 'it.']} start={0} per={5} color={PAPER} size={56} style={{ position: 'absolute', left: 140, top: 510 }} />
        </AbsoluteFill>
      )}
    </>
  );
};

// ---- shot 6: 16mm burn over the cut ----
const S06: React.FC = () => (
  <AbsoluteFill style={{ background: INK }}>
    <Img src={staticFile('pool/11-showcase-3d.jpg')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, opacity: 0.6 }} />
    <Img src={staticFile('fx/burn-16mm-01.png')} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, mixBlendMode: 'screen' }} />
  </AbsoluteFill>
);

// ---- shot 7: "Your demo / launch / changelog" collage of our renders, collapsing to "that render for you" ----
/** Card boxes (x, y, w, h, pool index) around the centre line, in the order they arrive; several run off the frame. */
const CARDS: [number, number, number, number, number][] = [
  [1330, 0, 450, 445, 12],
  [-40, 120, 410, 390, 8],
  [0, 570, 545, 440, 1],
  [330, 48, 430, 252, 3],
  [1205, 712, 755, 420, 14],
  [1635, 272, 330, 348, 9],
  [330, 806, 600, 330, 6],
  [760, -60, 380, 240, 15],
];
const WORDS = ['demo', 'launch', 'changelog'];
const S07: React.FC = () => {
  const frame = useCurrentFrame();
  const collapse = interpolate(frame, [96, 120], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const dark = interpolate(frame, [108, 116], [0, 1], CLAMP);
  const word = WORDS[Math.min(WORDS.length - 1, Math.floor(frame / 30))];
  const wordIn = interpolate(frame % 30, [0, 8], [0.35, 1], CLAMP);
  const typed = 'that render for you'.slice(0, Math.max(0, Math.floor((frame - 122) / 1.6)));
  return (
    <AbsoluteFill style={{ background: '#F3EFEC' }}>
      <AbsoluteFill style={{ background: INK, opacity: dark }} />
      {([[120, 70, '#c97a5f'], [560, 88, '#55603f'], [1700, 1010, '#55603f'], [880, 980, '#c97a5f'], [1520, 640, '#55603f']] as [number, number, string][]).map(([x, y, c], i) => (
        <div key={i} style={{ position: 'absolute', left: x, top: y, width: 9, height: 9, background: c, opacity: 1 - collapse }} />
      ))}
      {CARDS.map(([x, y, w, h, p], i) => {
        const at = 6 + i * 9;
        const t = interpolate(frame, [at, at + 10], [0, 1], { ...CLAMP, easing: OUT });
        const tint = interpolate(frame, [at, at + 12], [1, 0], CLAMP);
        if (t <= 0) return null;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const tx = (W / 2 - cx) * collapse * 0.55;
        const ty = (H / 2 - cy) * collapse * 0.55;
        const sepia = Math.max(tint, collapse * 0.8);
        return (
          <div key={i} style={{
            position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden', borderRadius: i % 3 === 0 ? 18 : 4,
            transform: `translate(${tx}px, ${ty + (1 - t) * 30}px) scale(${(0.94 + t * 0.06) * (1 - collapse * 0.45)})`,
            opacity: t * (1 - interpolate(frame, [116, 126], [0, 1], CLAMP)),
            filter: `sepia(${sepia}) hue-rotate(${sepia * 50}deg) saturate(${1 - sepia * 0.4}) blur(${collapse * 6}px)`,
          }}>
            <Img src={POOL[p]} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
        );
      })}
      {frame < 112 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 22, fontFamily: SANS, fontSize: 64, color: INK, opacity: 1 - dark }}>
          <div style={{ display: 'flex', gap: 6 }}><div style={{ width: 14, height: 14, background: '#55603f' }} /><div style={{ width: 14, height: 14, background: '#cfcac4' }} /></div>
          <span>Your <span style={{ opacity: wordIn }}>{word}</span></span>
          <div style={{ display: 'flex', gap: 6 }}><div style={{ width: 14, height: 14, background: '#cfcac4' }} /><div style={{ width: 14, height: 14, background: '#55603f' }} /></div>
        </div>
      )}
      {frame >= 122 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 500, display: 'flex', justifyContent: 'center', alignItems: 'center', fontFamily: SANS, fontSize: 64, color: PAPER }}>
          <span>{typed}</span>
          <div style={{ width: 30, height: 56, background: PAPER, marginLeft: 6, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.15 }} />
        </div>
      )}
    </AbsoluteFill>
  );
};

// ---- shot 8: drop-in, 98% of the Remotion API, with a camera push into the code ----
const CODE: [string, string][][] = [
  [['k', 'import'], ['p', ' { '], ['f', 'AbsoluteFill'], ['p', ', '], ['f', 'Sequence'], ['p', ', '], ['f', 'interpolate'], ['p', ', '], ['f', 'useCurrentFrame'], ['p', ' } '], ['k', 'from'], ['s', " 'remotion'"], ['p', ';']],
  [['k', 'import'], ['p', ' { '], ['f', 'TransitionSeries'], ['p', ' } '], ['k', 'from'], ['s', " '@remotion/transitions'"], ['p', ';']],
  [],
  [['k', 'export const'], ['f', ' Launch'], ['p', ' = () => {']],
  [['p', '  '], ['k', 'const'], ['p', ' frame = '], ['f', 'useCurrentFrame'], ['p', '();']],
  [['p', '  '], ['k', 'const'], ['p', ' y = '], ['f', 'interpolate'], ['p', '(frame, [0, 30], [40, 0]);']],
  [['p', '  '], ['k', 'return'], ['p', ' <'], ['f', 'AbsoluteFill'], ['p', ' style={{ transform: `translateY(${y}px)` }} />;']],
  [['p', '};']],
];
const SYN: Record<string, string> = { k: '#ff7b72', f: '#d2a8ff', s: '#a5d6ff', p: '#c9d1d9' };
const API = [
  'AbsoluteFill', 'Sequence', 'Series', 'Loop', 'Freeze', 'Composition', 'Still', 'Img', 'Audio', 'Video', 'OffthreadVideo',
  'interpolate', 'interpolateColors', 'spring', 'Easing', 'random', 'useCurrentFrame', 'useVideoConfig', 'staticFile',
  'delayRender', 'continueRender', 'registerRoot', 'measureSpring', 'TransitionSeries', 'fade', 'slide', 'wipe', 'flip',
  'clockWipe', 'iris', 'linearTiming', 'springTiming', 'makeCircle', 'makeRect', 'makeStar', 'evolvePath', 'getLength',
  'noise2D', 'noise3D', 'Lottie', 'Gif', 'measureText', 'fitText', 'getAudioData', 'visualizeAudio', 'CameraMotionBlur',
  'Trail', 'createTikTokStyleCaptions', 'loadFont', 'IFrame', 'AnimatedImage', 'prefetch', 'getStaticFiles', 'Html5Audio',
];
const S08: React.FC = () => {
  const frame = useCurrentFrame();
  // Camera: starts close on `from 'remotion'`, pulls out to the whole file, then past it to the API wall.
  const zoom = interpolate(frame, [0, 40, 70], [3.1, 1.25, 0.55], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const focusX = interpolate(frame, [0, 40], [1440, 960], CLAMP);
  const focusY = interpolate(frame, [0, 40], [340, 520], CLAMP);
  const wall = interpolate(frame, [52, 72], [0, 1], CLAMP);
  const hl = interpolate(frame, [4, 18], [0, 1], { ...CLAMP, easing: OUT });
  const count = Math.round(interpolate(frame, [70, 100], [0, 98], { ...CLAMP, easing: OUT }));
  return (
    <AbsoluteFill style={{ background: '#0d1117' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: `translate(${W / 2 - focusX}px, ${H / 2 - focusY}px) scale(${zoom})`, transformOrigin: `${focusX}px ${focusY}px` }}>
        <div style={{ position: 'absolute', left: -1300, top: -900, width: 4520, display: 'flex', flexWrap: 'wrap', gap: 18, opacity: wall, fontFamily: MONO, fontSize: 30 }}>
          {Array.from({ length: 260 }, (_, i) => API[i % API.length]).map((n, i) => (
            <div key={i} style={{ padding: '8px 16px', borderRadius: 8, background: '#161b22', color: '#8b949e', border: '1px solid #30363d', whiteSpace: 'nowrap' }}>
              <span style={{ color: '#3fb950', marginRight: 10 }}>✓</span>{n}
            </div>
          ))}
        </div>
        <div style={{ position: 'absolute', left: 360, top: 280, width: 1200, padding: '40px 48px', borderRadius: 18, background: '#0d1117', border: '1px solid #30363d', boxShadow: '0 40px 120px rgba(0,0,0,0.6)', fontFamily: MONO, fontSize: 24, lineHeight: '40px', opacity: 1 - wall * 0.92 }}>
          {CODE.map((line, j) => (
            <div key={j} style={{ whiteSpace: 'pre', height: 40, position: 'relative' }}>
              {j === 0 && <div style={{ position: 'absolute', left: 920, top: 2, height: 36, width: 220 * hl, background: 'rgba(224,38,27,0.35)', borderRadius: 4 }} />}
              {line.map(([c, t], k) => <span key={k} style={{ color: SYN[c], position: 'relative' }}>{t}</span>)}
            </div>
          ))}
        </div>
      </div>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 65% at 50% 50%, rgba(13,17,23,${frame >= 66 ? 0.72 : 0}) 30%, rgba(13,17,23,0.9) 100%)` }} />
      {frame >= 66 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 330, textAlign: 'center', color: '#f0f6fc', fontFamily: SANS }}>
          <div style={{ fontWeight: 700, fontSize: 300, lineHeight: 1, letterSpacing: '-0.04em' }}>{count}%</div>
          <div style={{ fontSize: 46, marginTop: 20, color: '#c9d1d9' }}>of the remotion api. drop-in.</div>
          <div style={{ fontFamily: MONO, fontSize: 22, marginTop: 26, color: '#6e7681' }}>168 of 170 public exports · remotion 4.0.536 + 12 packages</div>
        </div>
      )}
    </AbsoluteFill>
  );
};

// ---- shot 9: the numbers, bars on one scale ----
const S09: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [6, 66], [0, 8.86], CLAMP); // seconds of render time elapsed, both racing
  const scale = 1280 / 9;
  const bar = (secs: number) => Math.min(t, secs) * scale;
  const done = t >= 1.25;
  const x = Math.min(7.0, 1 + (6 * (t - 1.25)) / (8.86 - 1.25));
  return (
    <AbsoluteFill>
      <InkGround />
      <div style={{ position: 'absolute', left: 220, top: 170, fontFamily: MONO, fontSize: 22, color: '#8a8a8a' }}>same project · same 89 frames · render time</div>
      {[0, 3, 6, 9].map((s) => (
        <div key={s} style={{ position: 'absolute', left: 220 + s * scale, top: 220, height: 330, borderLeft: '1px dashed #3a3a3a' }}>
          <div style={{ position: 'absolute', top: 340, left: -12, fontFamily: MONO, fontSize: 20, color: '#666' }}>{s}s</div>
        </div>
      ))}
      {[{ name: 'remotion', secs: 8.86, c: 'linear-gradient(90deg,#3a3a3a,#5e5e5e)', y: 290 }, { name: 'kinetograph', secs: 1.25, c: `linear-gradient(90deg,#9e1b12,${RED})`, y: 450 }].map((b) => (
        <div key={b.name}>
          <div style={{ position: 'absolute', left: 220, top: b.y - 44, fontFamily: SANS, fontSize: 28, color: '#cfcfcf' }}>{b.name}</div>
          <div style={{ position: 'absolute', left: 220, top: b.y, width: Math.max(2, bar(b.secs)), height: 70, borderRadius: 10, background: b.c }} />
          <div style={{ position: 'absolute', left: 240 + bar(b.secs), top: b.y + 16, fontFamily: MONO, fontSize: 30, color: PAPER }}>
            {Math.min(t, b.secs).toFixed(2)}s
          </div>
        </div>
      ))}
      {done && (
        <div style={{ position: 'absolute', left: 210, top: 650, fontFamily: SANS, fontWeight: 700, fontSize: 300, lineHeight: 1, color: PAPER, letterSpacing: '-0.04em' }}>
          {x.toFixed(1)}x
        </div>
      )}
      {frame > 60 && <Img src={staticFile('fx/hand-impact.png')} style={{ position: 'absolute', left: 900, top: 560, width: 960, height: 540, mixBlendMode: 'screen' }} />}
      <div style={{ position: 'absolute', right: 120, bottom: 60, fontFamily: MONO, fontSize: 20, color: '#666' }}>S04 · M4 · measured 2026-10-15</div>
    </AbsoluteFill>
  );
};

// ---- shot 10: no chrome, no screenshots, just pixels ----
const S10: React.FC = () => {
  const frame = useCurrentFrame();
  const s1 = interpolate(frame, [14, 22], [1, 0], CLAMP);
  const s2 = interpolate(frame, [30, 38], [1, 0], CLAMP);
  const c = interpolate(frame, [46, 60], [1, 0], { ...CLAMP, easing: OUT });
  return (
    <AbsoluteFill>
      <PaperGround />
      <Build words={['no', 'chrome.', 'no', 'screenshots.', 'just', 'pixels.']} start={4} per={7} color={INK} size={72} style={{ position: 'absolute', left: 0, right: 0, top: 480, justifyContent: 'center' }} />
      <svg width={W} height={H} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path d="M296 528 c70 -28 140 28 210 -4 s140 22 214 -8 M306 548 c110 8 230 -16 410 0" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={s1} />
        <path d="M712 530 c120 -26 260 30 380 -6 s100 20 150 -4" stroke={INK} strokeWidth={9} fill="none" strokeLinecap="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={s2} />
        <ellipse cx={1428} cy={522} rx={215} ry={88} transform="rotate(-4 1440 520)" fill="none" stroke={RED} strokeWidth={6} pathLength={1} strokeDasharray="1 1" strokeDashoffset={c} />
      </svg>
    </AbsoluteFill>
  );
};

// ---- shot 11: snapcn's logo-flicker over our own renders ----
const S11: React.FC = () => (
  <LogoFlicker images={POOL} brandName="kinetograph" logoSrc={staticFile('fx/clear.png')} mode="dark" fontFamily={SANS} background={INK} />
);

// ---- shot 12: end card ----
const S12: React.FC = () => (
  <AbsoluteFill>
    <PaperGround />
    <div style={{ position: 'absolute', left: 0, right: 0, top: 330, textAlign: 'center', fontFamily: SANS, color: INK }}>
      <div style={{ fontWeight: 700, fontSize: 210, letterSpacing: '-0.05em', lineHeight: 1 }}>kinetograph<span style={{ color: RED }}>.</span></div>
      <div style={{ fontSize: 50, marginTop: 34 }}>write remotion. render native.</div>
      <div style={{ fontFamily: MONO, fontSize: 36, marginTop: 110 }}>kinetograph.dev</div>
      <div style={{ fontFamily: MONO, fontSize: 22, marginTop: 120, color: '#7a7670' }}>this video was rendered by kinetograph in N s</div>
    </div>
  </AbsoluteFill>
);

const SHOTS: [string, React.FC<any>, number][] = [
  ['s01', S01, 21], ['s02', S02, 70], ['s03', S03, 90], ['s04', S04, 60], ['s05', S05, 90], ['s06', S06, 27],
  ['s07', S07, 160], ['s08', S08, 110], ['s09', S09, 110], ['s10', S10, 90], ['s11', S11, 110], ['s12', S12, 120],
];

const Root: React.FC = () => (
  <>
    {SHOTS.map(([id, c, d]) => <Composition key={id} id={id} component={c} width={W} height={H} fps={FPS} durationInFrames={d} />)}
    <Composition id="s05-raw" component={S05} defaultProps={{ graded: false }} width={W} height={H} fps={FPS} durationInFrames={90} />
  </>
);

registerRoot(Root);
