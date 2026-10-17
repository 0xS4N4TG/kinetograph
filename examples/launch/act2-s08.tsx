// Shot 8: "drop-in, 98% of the Remotion API". A virtual camera starts tight on `from 'remotion'`, pulls out past the whole
// file onto a wall of Remotion's exports, each ticked, and the number counts up over the wall. Two planes (the code
// card near, the wall far) with their own parallax, a focus pull between them (blur on the plane out of focus) and
// motion blur on the pull.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';
import { Layer, blur } from '@kinetograph/core';
import { CLAMP, H, LEN, MONO, OUT, SANS, W } from './common.js';

const BG = '#0d1117';
const SYN: Record<string, string> = { k: '#ff7b72', f: '#d2a8ff', s: '#a5d6ff', p: '#c9d1d9' };
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

// The code card in its own world coordinates: centred on (960, 540).
const FONT = 26;
const CW = FONT * 0.6;
const LH = 46;
const PAD = 52;
const CARD_W = 1420;
const CARD_H = CODE.length * LH + PAD * 2 - 8;
const CARD_X = 960 - CARD_W / 2;
const CARD_Y = 540 - CARD_H / 2;
const line0 = CODE[0]!.map(([, t]) => t).join('');
const FROM_COL = line0.indexOf('from');
const FROM_LEN = line0.indexOf(';') - FROM_COL;
const FROM_X = CARD_X + PAD + FROM_COL * CW;
const FROM_Y = CARD_Y + PAD + LH / 2 - 4;
const FROM_CX = FROM_X + (FROM_LEN * CW) / 2;

// Remotion's real exports (the `remotion` package, then its sibling packages).
const NAMES = [
  'AbsoluteFill', 'AnimatedImage', 'Artifact', 'Audio', 'Composition', 'Config', 'Easing', 'Experimental', 'Folder', 'Freeze',
  'Html5Audio', 'Html5Video', 'IFrame', 'Img', 'Interactive', 'Loop', 'OffthreadVideo', 'Sequence', 'Series', 'Still', 'Video',
  'cancelRender', 'continueRender', 'delayRender', 'getInputProps', 'getRemotionEnvironment', 'getStaticFiles', 'interpolate',
  'interpolateColors', 'measureSpring', 'prefetch', 'random', 'registerRoot', 'spring', 'staticFile', 'useCurrentFrame',
  'useCurrentScale', 'useDelayRender', 'usePixelDensity', 'useVideoConfig', 'watchStaticFile', 'useBufferState',
  'TransitionSeries', 'linearTiming', 'springTiming', 'fade', 'slide', 'wipe', 'flip', 'clockWipe', 'iris',
  'evolvePath', 'getLength', 'getPointAtLength', 'getTangentAtLength', 'interpolatePath', 'parsePath', 'reversePath',
  'scalePath', 'translatePath', 'warpPath', 'getBoundingBox', 'normalizePath', 'resetPath',
  'makeCircle', 'makeRect', 'makeStar', 'makeTriangle', 'makePolygon', 'makePie', 'makeEllipse',
  'Circle', 'Star', 'Triangle', 'Polygon', 'Pie', 'Ellipse',
  'noise2D', 'noise3D', 'noise4D', 'getAudioData', 'visualizeAudio', 'getVideoMetadata', 'useAudioData', 'getWaveformPortion',
  'measureText', 'fitText', 'fillTextBox', 'CameraMotionBlur', 'Trail', 'Gif', 'getGifDurationInSeconds', 'preloadGif',
  'Lottie', 'createTikTokStyleCaptions', 'parseSrt', 'serializeSrt', 'loadFont', 'Solid', 'CanvasImage', 'HtmlInCanvas',
  'Internals', 'useIsInsideNonPremountFreeze', 'MediaPlaybackError', 'Track', 'createEffect', 'extendViewBox',
];

// The wall in its own world coordinates, packed greedily into rows and spread to the row width.
const PILL_FONT = 48;
const PILL_H = 100;
const ROW_GAP = 24;
const PILL_GAP = 26;
const ROW_W = 3100;
const pillWidth = (n: string) => 112 + n.length * PILL_FONT * 0.6;
type Pill = { name: string; x: number; y: number; w: number; order: number };
const WALL: Pill[] = [];
const WALL_H = (() => {
  const rows: string[][] = [[]];
  let used = 0;
  for (const n of NAMES) {
    const w = pillWidth(n);
    if (used + w > ROW_W && rows[rows.length - 1]!.length) { rows.push([]); used = 0; }
    rows[rows.length - 1]!.push(n);
    used += w + PILL_GAP;
  }
  rows.forEach((row, r) => {
    const total = row.reduce((s, n) => s + pillWidth(n), 0);
    const gap = row.length > 1 ? (ROW_W - total) / (row.length - 1) : 0;
    let x = 0;
    row.forEach((name) => {
      WALL.push({ name, x, y: r * (PILL_H + ROW_GAP), w: pillWidth(name), order: WALL.length });
      x += pillWidth(name) + Math.min(gap, 90);
    });
  });
  return rows.length * (PILL_H + ROW_GAP);
})();
const WALL_CX = ROW_W / 2;
const WALL_CY = WALL_H / 2;

const Tick: React.FC<{ t: number }> = ({ t }) => (
  <svg width={38} height={38} viewBox="0 0 38 38" style={{ flex: 'none', transform: `scale(${t})` }}>
    <circle cx={19} cy={19} r={18} fill="#3fb950" />
    <path d="M10.5 19.5 L16.5 25.5 L27.5 13" fill="none" stroke="#0d1117" strokeWidth={4.2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Frames the camera holds tight on `from 'remotion'` (the VO's "Already using Remotion? Kinetograph runs your existing
 *  projects as they are."); the pull-out and the count then run on, so "98%" lands on the VO's "ninety-eight". */
export const S08_HOLD = 80;

export const S08: React.FC = () => {
  const real = useCurrentFrame();
  const frame = real < S08_HOLD ? (real * 22) / S08_HOLD : real - (S08_HOLD - 22);
  const pull = interpolate(frame, [22, 84], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const creep = interpolate(frame, [0, 22], [0, 1], CLAMP); // the push before the pull, so the camera is never still
  const settle = interpolate(frame, [84, LEN.s08 - (S08_HOLD - 22)], [0, 1], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const zoom = 3.3 + creep * 0.18 + pull * (0.46 - 3.48) + settle * 0.05;
  const pan = interpolate(pull, [0, 0.8], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const fx = FROM_CX + (960 - FROM_CX) * pan;
  const fy = FROM_Y + (540 - FROM_Y) * pan;

  // Near plane: the code card. Far plane: the wall, which scales and pans less with the camera (parallax).
  const sCode = zoom;
  const sWall = 0.853 * Math.pow(zoom, 0.4);
  const wallFocusX = WALL_CX + (fx - 960) * 0.3;
  const wallFocusY = WALL_CY + (fy - 540) * 0.3;
  const codeT = `translate(${960 - fx * sCode}px, ${540 - fy * sCode}px) scale(${sCode})`;
  const wallT = `translate(${960 - wallFocusX * sWall}px, ${540 - wallFocusY * sWall}px) scale(${sWall})`;

  // Focus pull: sharp code and a bokeh wall at the start, a sharp wall and a soft code at the end.
  const focus = interpolate(frame, [46, 80], [0, 1], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  const codeBlur = focus * 14;
  const wallBlur = (1 - focus) * 22 + interpolate(frame, [96, 112], [0, 3], CLAMP);
  const codeAlpha = interpolate(frame, [62, 90], [1, 0], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const wallAlpha = interpolate(frame, [4, 34], [0.55, 1], CLAMP) * interpolate(frame, [96, 112], [1, 0.72], CLAMP);
  const moving = frame >= 18 && frame <= 90;
  const blurFx = moving ? { samples: 10, shutter: 0.35 } : undefined;

  const hl = interpolate(real, [16, 30], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) }); // on "Remotion"
  const count = Math.round(interpolate(frame, [80, 112], [0, 98], { ...CLAMP, easing: OUT }));
  const numIn = interpolate(frame, [78, 88], [0, 1], { ...CLAMP, easing: OUT });
  const subIn = interpolate(frame, [108, 118], [0, 1], { ...CLAMP, easing: OUT });
  const noteIn = interpolate(frame, [122, 132], [0, 1], { ...CLAMP, easing: OUT });
  const pop = interpolate(frame, [112, 116, 124], [1, 1.035, 1], CLAMP);

  return (
    <AbsoluteFill style={{ background: BG }}>
      <Layer id="wall" opacity={wallAlpha} effects={wallBlur > 0.3 ? [blur(wallBlur)] : []} motionBlur={blurFx}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transformOrigin: '0 0', transform: wallT }}>
          {WALL.map((p) => {
            // Ticks run along the wall from the camera's way in: row by row, with a short staggered pop each.
            const at = 38 + p.order * 0.4 + (p.y / (PILL_H + ROW_GAP)) * 0.9;
            const t = interpolate(frame, [at, at + 7], [0, 1], { ...CLAMP, easing: Easing.bezier(0.2, 1.6, 0.4, 1) });
            return (
              <div key={p.name} style={{
                position: 'absolute', left: p.x, top: p.y, width: p.w, height: PILL_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 16,
                padding: '0 28px', borderRadius: 22, background: '#161b22', border: `2px solid ${t > 0.5 ? '#2c5a3a' : '#30363d'}`,
                fontFamily: MONO, fontSize: PILL_FONT, color: t > 0.5 ? '#e6edf3' : '#6e7681', whiteSpace: 'nowrap',
              }}>
                <Tick t={Math.max(0, t)} />
                <span>{p.name}</span>
              </div>
            );
          })}
        </div>
      </Layer>
      <Layer id="code" opacity={codeAlpha} effects={codeBlur > 0.3 ? [blur(codeBlur)] : []} motionBlur={blurFx}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transformOrigin: '0 0', transform: codeT }}>
          <div style={{
            position: 'absolute', left: CARD_X, top: CARD_Y, width: CARD_W, height: CARD_H, boxSizing: 'border-box', padding: PAD, borderRadius: 26,
            background: BG, border: '2px solid #30363d', boxShadow: '0 60px 160px rgba(0,0,0,0.7)', fontFamily: MONO, fontSize: FONT, lineHeight: `${LH}px`,
          }}>
            <div style={{ position: 'absolute', left: FROM_X - CARD_X - 8, top: PAD - 2, height: LH - 4, width: (FROM_LEN * CW + 16) * hl, borderRadius: 6, background: 'rgba(224,38,27,0.38)' }} />
            {CODE.map((line, j) => (
              <div key={j} style={{ whiteSpace: 'pre', height: LH, position: 'relative' }}>
                {line.map(([c, t], k) => <span key={k} style={{ color: SYN[c] }}>{t}</span>)}
              </div>
            ))}
          </div>
        </div>
      </Layer>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 75% 70% at 50% 50%, rgba(13,17,23,${0.5 * numIn}) 20%, rgba(13,17,23,${0.35 + 0.45 * numIn}) 100%)` }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 310, textAlign: 'center', color: '#f0f6fc', fontFamily: SANS }}>
        <div style={{ fontWeight: 700, fontSize: 330, lineHeight: 1, letterSpacing: '-0.04em', paddingRight: 40, opacity: numIn, transform: `scale(${pop})`, filter: `blur(${(1 - numIn) * 10}px)` }}>{count}%</div>
        <div style={{ fontSize: 50, marginTop: 18, color: '#c9d1d9', opacity: subIn, transform: `translateY(${(1 - subIn) * 14}px)` }}>of the remotion api. <span style={{ color: '#fff', fontWeight: 500 }}>a drop-in replacement.</span></div>
        <div style={{ fontFamily: MONO, fontSize: 24, marginTop: 30, color: '#8b949e', opacity: noteIn }}>168 of 170 public exports · remotion 4.0.536 + 12 packages</div>
      </div>
    </AbsoluteFill>
  );
};
