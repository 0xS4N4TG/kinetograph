// The receipts of shot 7 ("...and it renders for you"), in two set-ups. First a close-up: one receipt feeds up out of
// a thermal printer's slot at the printer's steady speed, under a warm key light, the lens pulling focus as it comes.
// The cutter snaps, and the cut is to a wide shot down onto a table: the receipt on a pile of others, the table tilted
// away so the far receipts fall out of focus, while more drop onto it and the camera creeps in.

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Layer, grain } from '@kinetographdev/core';
import { CLAMP, FPS, MONO } from '../common.js';
import { Receipt, receiptHeight, type Line, type PhotoSpec } from './receipt.js';

// The photos: faces and the crowd from the 1927 parade film (public/footage), printed in dots.
const VETERAN: PhotoSpec = { src: 'receipts/face-veteran.png', w: 560, h: 640, mid: 0.42, contrast: 2.4, dot: 3 };
const BEARD: PhotoSpec = { src: 'receipts/face-beard.png', w: 600, h: 760, mid: 0.45, contrast: 2.2, dot: 3 };
const HAT: PhotoSpec = { src: 'receipts/face-hat.png', w: 640, h: 720, mid: 0.48, contrast: 2.4, dot: 3 };
const PAIR: PhotoSpec = { src: 'receipts/face-pair.png', w: 900, h: 506, mid: 0.5, contrast: 2.2, dot: 3 };
const CROWD: PhotoSpec = { src: 'receipts/crowd.png', w: 1440, h: 810, mid: 0.5, contrast: 2.6, dot: 3 };

const R: Record<string, Line[]> = {
  shibuya: [
    ['sp', 6], ['title', 'キネトグラフ'], ['c', 'KINETOGRAPH MART'], ['jp', '渋谷スクランブル店'], ['s', 'Shibuya Scramble Branch'], ['sp', 6],
    ['r', '2026/10/23 (金)', '14:52'], ['r', 'レジ 03', 'No.0018-4472'], ['rule'],
    ['photo', VETERAN, 250],
    ['rule'],
    ['r', 'フレーム描画 x1542', '¥0'], ['r', 'GPU compositor', '¥0'], ['r', 'ブラウザ (不要)', '-¥480'],
    ['r', 'JSON scene file', '¥120'], ['r', '消費税 10%', '¥12'], ['dbl'],
    ['b', '合計 TOTAL', '¥132'], ['r', 'お預り / CASH', '¥200'], ['r', 'お釣り / CHANGE', '¥68'], ['sp', 10],
    ['qr', 'https://kinetograph.dev/r/0018-4472', 150], ['s', 'ご来店ありがとうございます'], ['s', 'THANK YOU, COME AGAIN'], ['sp', 8],
    ['bar', 'a18', 64],
  ],
  browser: [
    ['sp', 6], ['title', 'ブラウザ堂'], ['c', 'BROWSER-DO  CO., LTD.'], ['s', '東京都新宿区 1-2-3'], ['sp', 4], ['rule'],
    ['r', '2026/10/23', '09:07'], ['r', 'TEL 03-0000-1542', ''], ['rule'],
    ['photo', BEARD, 300],
    ['rule'],
    ['r', 'スクリーンショット', '¥30'], ['r', '  x 1,542 枚', '¥46,260'], ['r', 'Chrome タブ', '¥0'], ['r', '  (読み込み中...)', ''],
    ['r', 'headless 起動', '¥980'], ['r', 'メモリ 4GB', '¥1,200'], ['r', 'ファン騒音', '¥300'], ['dbl'],
    ['b', '小計', '¥48,740'], ['b', '合計 TOTAL', '¥53,614'], ['sp', 8],
    ['s', 'レシートは大切に保管してください'], ['bar', 'b21', 56], ['sp', 4],
  ],
  gpu: [
    ['sp', 6], ['title', 'GPU食堂'], ['c', 'GPU SHOKUDO'], ['jp', 'レンダー専門'], ['sp', 4], ['rule'],
    ['r', 'テーブル 7', '2名'], ['r', '2026/10/23', '19:30'], ['rule'],
    ['r', 'レンダー定食', '¥1,200'], ['r', '  Skia + wgpu', ''], ['r', 'シェーダー唐揚げ', '¥680'], ['r', '  GLSL ES 300', ''],
    ['r', '3D アイソメ丼', '¥890'], ['r', 'ガラス屈折プリン', '¥450'], ['r', 'canvas サラダ', '¥390'],
    ['r', '生ビール x2', '¥1,000'], ['rule'],
    ['photo', HAT, 210],
    ['rule'],
    ['b', '合計 TOTAL', '¥4,610'], ['r', '(内税 ¥419)', ''], ['sp', 8],
    ['qr', 'gpu-shokudo/table7/20261023', 130], ['s', 'またのお越しをお待ちしております'], ['sp', 6],
  ],
  lumen: [
    ['sp', 6], ['title', 'ルーメン薬局'], ['c', 'LUMEN PHARMACY'], ['rule'],
    ['r', '2026/10/22', '23:58'], ['r', '処方 No.', '55-0071'], ['rule'],
    ['r', 'frame-sync 錠', '¥320'], ['r', '  1日3回 食後', ''], ['r', 'ノーブラウザ 軟膏', '¥540'], ['r', 'リリースノート', '¥0'],
    ['dbl'], ['b', '合計 TOTAL', '¥860'], ['sp', 8], ['bar', 'c55', 80], ['s', 'お大事に'], ['sp', 4],
  ],
  frame: [
    ['sp', 6], ['title', '週刊フレーム'], ['c', 'WEEKLY FRAME  KIOSK'], ['s', '駅前売店 No.12'], ['rule'],
    ['r', '2026/10/21 (水)', '07:41'], ['rule'],
    ['photo', CROWD, 230],
    ['rule'],
    ['r', '雑誌 Motion Vol.98', '¥980'], ['r', 'ガム ミント', '¥130'], ['r', '缶コーヒー', '¥150'], ['dbl'],
    ['b', '合計 TOTAL', '¥1,260'], ['sp', 10], ['qr', 'https://kinetograph.dev', 140], ['s', 'DROP-IN REPLACEMENT'], ['sp', 4],
    ['bar', 'd12', 60],
  ],
  code: [
    ['sp', 6], ['title', 'コード喫茶'], ['c', 'CODE CAFE'], ['jp', 'ブレンド・トースト'], ['rule'],
    ['r', '2026/10/23', '11:15'], ['r', '席 / SEAT', 'A-04'], ['rule'],
    ['r', 'ドリップ coffee', '¥480'], ['r', 'トースト <Series>', '¥420'], ['r', 'ケーキ spring()', '¥560'], ['dbl'],
    ['b', '合計 TOTAL', '¥1,460'], ['sp', 8], ['photo', HAT, 170], ['bar', 'e40', 52], ['sp', 4],
  ],
  mart: [
    ['sp', 6], ['title', 'ピクセル商店'], ['c', 'PIXEL SHOTEN'], ['rule'],
    ['r', '2026/10/23', '16:20'], ['rule'],
    ['photo', PAIR, 190],
    ['r', 'ドット絵 portrait', '¥100'], ['r', 'film grain', '¥50'], ['dbl'], ['b', '合計', '¥150'], ['sp', 6],
    ['qr', 'pixel-shoten/0023', 120], ['sp', 4],
  ],
};

/** Where each receipt lies on the table (plane pixels), its turn, and the frame of the wide shot it lands. The first
 *  is the one just printed, already down. */
interface Placement { key: string; left: number; top: number; rot: number; at: number; seed: number }
// Painted in this order: later ones lie on top.
const PILE: Placement[] = [
  { key: 'browser', left: 420, top: 120, rot: 7, at: -1, seed: 11 },
  { key: 'gpu', left: 1560, top: 60, rot: -9, at: -1, seed: 5 },
  { key: 'shibuya', left: 980, top: 300, rot: -4, at: -1, seed: 3 },
  { key: 'lumen', left: 1980, top: 420, rot: 12, at: 4, seed: 17 },
  { key: 'frame', left: 140, top: 640, rot: -14, at: 12, seed: 23 },
  { key: 'code', left: 1380, top: 760, rot: 5, at: 20, seed: 29 },
  { key: 'mart', left: 700, top: 900, rot: -6, at: 28, seed: 31 },
];

/** The close-up, then the wide shot, in frames of the receipts. */
export const PRINT_LEN = 44;
/** The paper's speed out of the printer, px a frame (before the close-up's magnification). */
const FEED = 15;
/** The printer starts feeding on this frame of the close-up. */
const FEED_AT = 3;
const DROP = { damping: 15, stiffness: 120, mass: 0.8 };

/** Frames a dropped receipt takes to land: the first frame its spring reaches rest. */
const landOf = (() => {
  let f = 0;
  while (f < 120 && spring({ frame: f, fps: FPS, config: DROP }) < 1) f++;
  return f;
})();

/** When things make noise, in frames from the start of the receipts, for sound-cues.ts: the printer feeds from
 *  `feed[0]` to `feed[1]` and the cutter snaps at `cut`; each dropped receipt lands at its `land`. */
export const RECEIPT_SOUND = {
  feed: [FEED_AT, PRINT_LEN - 3] as const,
  cut: PRINT_LEN - 3,
  drops: PILE.filter((p) => p.at >= 0).map((p) => ({ key: p.key, at: PRINT_LEN + p.at, land: PRINT_LEN + p.at + landOf })),
};

/** A hand-held drift: two slow sines per axis, so the camera never quite settles. */
const drift = (f: number, seed: number, amp: number) =>
  amp * (Math.sin(f / 17 + seed) * 0.6 + Math.sin(f / 7.3 + seed * 2.1) * 0.4);

/** The thermal printer's front at the bottom of the close-up: a dark body, the slot's lip catching the light, an LED. */
const Printer: React.FC<{ slot: number; width: number }> = ({ slot, width }) => (
  <div style={{ position: 'absolute', left: -200, top: slot, width: width + 400, height: 900,
    background: 'linear-gradient(180deg, #2b2b2f 0%, #18181b 12%, #0e0e10 60%, #070708 100%)' }}>
    <div style={{ position: 'absolute', left: 0, right: 0, top: -6, height: 10, background: 'linear-gradient(180deg, #050506 0%, #000 100%)' }} />
    <div style={{ position: 'absolute', left: 0, right: 0, top: 5, height: 3, background: 'linear-gradient(90deg, rgba(255,214,170,0) 0%, rgba(255,214,170,0.55) 45%, rgba(255,214,170,0.1) 100%)' }} />
    <div style={{ position: 'absolute', left: width / 2 + 420, top: 70, width: 10, height: 10, borderRadius: 5, background: '#5CFF8A', boxShadow: '0 0 14px 4px rgba(92,255,138,0.55)' }} />
    <div style={{ position: 'absolute', left: width / 2 - 520, top: 62, fontFamily: MONO, fontSize: 22, letterSpacing: 6, color: '#3a3a40' }}>KG-80  THERMAL</div>
  </div>
);

/** The close-up: the receipt rises out of the slot at the printer's speed; the head prints it as it passes, so all of
 *  what shows is printed. */
const CloseUp: React.FC<{ frame: number }> = ({ frame }) => {
  const lines = R.shibuya;
  const h = receiptHeight(lines);
  const W = 1920, SLOT = 760;
  const out = Math.min(h, Math.max(0, frame - FEED_AT) * FEED);
  // the lens: soft at first, pulling into focus as the paper comes
  const focus = interpolate(frame, [0, 14], [7, 0], { ...CLAMP, easing: Easing.out(Easing.quad) });
  const zoom = interpolate(frame, [0, PRINT_LEN], [1.9, 1.72], CLAMP);
  const shake = frame >= RECEIPT_SOUND.cut ? interpolate(frame, [RECEIPT_SOUND.cut, RECEIPT_SOUND.cut + 3], [5, 0], CLAMP) : 0;
  return (
    <AbsoluteFill style={{ background: '#050506' }}>
      <AbsoluteFill style={{
        transform: `translate(${drift(frame, 1, 6)}px, ${drift(frame, 4, 5) + shake}px) scale(${zoom.toFixed(4)})`, transformOrigin: '30% 62%',
        filter: focus > 0.05 ? `blur(${focus.toFixed(2)}px)` : undefined,
      }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: SLOT, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: W / 2 - 560, top: SLOT - out, transform: 'rotate(-0.6deg)' }}>
            <Receipt id="rc-close" lines={lines} seed={3} />
          </div>
        </div>
        <Printer slot={SLOT} width={W} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Dropped: React.FC<{ p: Placement; frame: number; focus: number }> = ({ p, frame, focus }) => {
  const { fps } = useVideoConfig();
  const t = frame - p.at;
  if (p.at >= 0 && t < 0) return null;
  // a drop from above the camera: big and high, settling flat onto the table, its shadow closing up under it
  const s = p.at < 0 ? 1 : spring({ frame: t, fps, config: DROP });
  const scale = 1 + (1 - s) * 0.55;
  const lift = (1 - s) * 60;
  const rot = p.rot + (1 - s) * (random(`spin-${p.key}`) > 0.5 ? 14 : -14);
  // depth of field: the table is tilted away, so the farther up it a receipt lies, the softer it is
  const soft = Math.max(0, (focus - p.top) / 130);
  return (
    <div style={{
      position: 'absolute', left: p.left, top: p.top - lift, transform: `rotate(${rot.toFixed(3)}deg) scale(${scale.toFixed(4)})`, transformOrigin: '50% 30%',
      opacity: p.at < 0 ? 1 : interpolate(t, [0, 3], [0, 1], CLAMP), filter: soft > 0.05 ? `blur(${soft.toFixed(2)}px)` : undefined,
    }}>
      <Receipt id={`rc-${p.key}`} lines={R[p.key]} seed={p.seed} />
    </div>
  );
};

/** The wide shot: the table plane, tilted away from the camera, which creeps in and turns a little. */
const Wide: React.FC<{ frame: number; frames: number }> = ({ frame, frames }) => {
  const e = Easing.inOut(Easing.cubic)(Math.min(1, frame / frames));
  const focus = interpolate(e, [0, 1], [330, 230]); // the focal plane: receipts above this line on the table go soft
  return (
    <AbsoluteFill style={{ background: '#09090a', perspective: 1700, perspectiveOrigin: '50% 20%' }}>
      <div style={{
        position: 'absolute', left: -400, top: -260, width: 2720, height: 1900,
        transform: `translateY(${(-60 * e).toFixed(2)}px) rotateX(${(36 - 4 * e).toFixed(3)}deg) rotateZ(${(-3 + 2.5 * e).toFixed(3)}deg) scale(${(1 + 0.1 * e).toFixed(4)})`,
        transformOrigin: '50% 60%',
        background: 'radial-gradient(ellipse 55% 50% at 45% 45%, #3b3631 0%, #1f1c19 50%, #0b0a09 100%)',
      }}>
        {PILE.map((p) => <Dropped key={p.key} p={p} frame={frame} focus={focus} />)}
      </div>
    </AbsoluteFill>
  );
};

/** The receipts, `frames` long on screen; frame 0 is their first. */
export const Receipts: React.FC<{ frames: number }> = ({ frames }) => {
  const frame = useCurrentFrame();
  return (
    <Layer id="receipts" effects={[grain(0.07, { seed: 41 })]}>
      <AbsoluteFill>
        {frame < PRINT_LEN ? <CloseUp frame={frame} /> : <Wide frame={frame - PRINT_LEN} frames={frames - PRINT_LEN} />}
        {/* the key light: warm, from the top left, falling off to dark */}
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse 70% 65% at 38% 30%, rgba(255,200,140,0.16) 0%, rgba(255,200,140,0) 60%)', mixBlendMode: 'screen' }} />
        <AbsoluteFill style={{ background: 'radial-gradient(ellipse 85% 80% at 50% 45%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.72) 100%)' }} />
      </AbsoluteFill>
    </Layer>
  );
};
