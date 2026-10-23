// v2-receipts: a collage of thermal receipts on a dark ground. Some print out a line at a time, some drop in with a
// tilt; their photos print top to bottom through a dither shader; then the camera drifts and pushes in.
// Placeholder photos: frames of our own clips (public/receipts, public/pool).

import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FPS, H, W } from '../common.js';
import { Receipt, receiptHeight, type Line, type PhotoSpec } from './receipt.js';

export const RECEIPTS_FRAMES = 10 * FPS;

const SILHOUETTE: PhotoSpec = { src: 'receipts/photo-silhouette.png', w: 800, h: 450, mid: 0.74, contrast: 5.2, dot: 3 };
const EP13: PhotoSpec = { src: 'receipts/photo-ep13.png', w: 480, h: 854, mid: 0.45, contrast: 2.0, dot: 3 };
const PIG: PhotoSpec = { src: 'receipts/photo-pig.png', w: 800, h: 450, mid: 0.7, contrast: 2.6, dot: 3 };
const PIG_BALL: PhotoSpec = { src: 'receipts/photo-pig-ball.png', w: 800, h: 450, mid: 0.7, contrast: 2.6, dot: 3 };
const SHOW: PhotoSpec = { src: 'pool/12-showcase-3d.jpg', w: 1920, h: 1080, mid: 0.7, contrast: 2.8, dot: 3 };
const DESK: PhotoSpec = { src: 'pool/16-ep13-5s.jpg', w: 1920, h: 1080, mid: 0.45, contrast: 2.2, dot: 3 };

const R: Record<string, Line[]> = {
  shibuya: [
    ['sp', 6], ['title', 'キネトグラフ'], ['c', 'KINETOGRAPH MART'], ['jp', '渋谷スクランブル店'], ['s', 'Shibuya Scramble Branch'], ['sp', 6],
    ['r', '2026/10/23 (金)', '14:52'], ['r', 'レジ 03', 'No.0018-4472'], ['rule'],
    ['photo', SILHOUETTE, 250],
    ['rule'],
    ['r', 'フレーム描画 x1521', '¥0'], ['r', 'GPU compositor', '¥0'], ['r', 'ブラウザ (不要)', '-¥480'],
    ['r', 'JSON scene file', '¥120'], ['r', '消費税 10%', '¥12'], ['dbl'],
    ['b', '合計 TOTAL', '¥132'], ['r', 'お預り / CASH', '¥200'], ['r', 'お釣り / CHANGE', '¥68'], ['sp', 10],
    ['qr', 'https://kinetograph.dev/r/0018-4472', 150], ['s', 'ご来店ありがとうございます'], ['s', 'THANK YOU, COME AGAIN'], ['sp', 8],
    ['bar', 'a18', 64],
  ],
  browser: [
    ['sp', 6], ['title', 'ブラウザ堂'], ['c', 'BROWSER-DO  CO., LTD.'], ['s', '東京都新宿区 1-2-3'], ['sp', 4], ['rule'],
    ['r', '2026/10/23', '09:07'], ['r', 'TEL 03-0000-1521', ''], ['rule'],
    ['photo', EP13, 300],
    ['rule'],
    ['r', 'スクリーンショット', '¥30'], ['r', '  x 1,521 枚', '¥45,630'], ['r', 'Chrome タブ', '¥0'], ['r', '  (読み込み中...)', ''],
    ['r', 'headless 起動', '¥980'], ['r', 'メモリ 4GB', '¥1,200'], ['r', 'ファン騒音', '¥300'], ['dbl'],
    ['b', '小計', '¥48,110'], ['b', '合計 TOTAL', '¥52,921'], ['sp', 8],
    ['s', 'レシートは大切に保管してください'], ['bar', 'b21', 56], ['sp', 4],
  ],
  gpu: [
    ['sp', 6], ['title', 'GPU食堂'], ['c', 'GPU SHOKUDO'], ['jp', 'レンダー専門'], ['sp', 4], ['rule'],
    ['r', 'テーブル 7', '2名'], ['r', '2026/10/23', '19:30'], ['rule'],
    ['r', 'レンダー定食', '¥1,200'], ['r', '  Skia + wgpu', ''], ['r', 'シェーダー唐揚げ', '¥680'], ['r', '  GLSL ES 300', ''],
    ['r', '3D アイソメ丼', '¥890'], ['r', 'ガラス屈折プリン', '¥450'], ['r', 'canvas サラダ', '¥390'],
    ['r', '生ビール x2', '¥1,000'], ['rule'],
    ['photo', PIG, 210],
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
    ['photo', SHOW, 230],
    ['rule'],
    ['r', '雑誌 Motion Vol.98', '¥980'], ['r', 'ガム ミント', '¥130'], ['r', '缶コーヒー', '¥150'], ['dbl'],
    ['b', '合計 TOTAL', '¥1,260'], ['sp', 10], ['qr', 'https://kinetograph.dev', 140], ['s', 'DROP-IN REPLACEMENT'], ['sp', 4],
    ['bar', 'd12', 60],
  ],
  code: [
    ['sp', 6], ['title', 'コード喫茶'], ['c', 'CODE CAFE'], ['jp', 'ブレンド・トースト'], ['rule'],
    ['r', '2026/10/23', '11:15'], ['r', '席 / SEAT', 'A-04'], ['rule'],
    ['r', 'ドリップ coffee', '¥480'], ['r', 'トースト <Series>', '¥420'], ['r', 'ケーキ spring()', '¥560'], ['dbl'],
    ['b', '合計 TOTAL', '¥1,460'], ['sp', 8], ['photo', DESK, 170], ['bar', 'e40', 52], ['sp', 4],
  ],
  mart: [
    ['sp', 6], ['title', 'ピクセル商店'], ['c', 'PIXEL SHOTEN'], ['rule'],
    ['r', '2026/10/23', '16:20'], ['rule'],
    ['photo', PIG_BALL, 190],
    ['r', 'ドット絵 pig', '¥100'], ['r', '黒い球', '¥50'], ['dbl'], ['b', '合計', '¥150'], ['sp', 6],
    ['qr', 'pixel-shoten/0023', 120], ['sp', 4],
  ],
};

interface Placement { key: string; left: number; top: number; rot: number; at: number; mode: 'print' | 'drop'; seed: number }
// Painted in this order: later ones lie on top.
const PLACEMENTS: Placement[] = [
  { key: 'shibuya', left: 60, top: 40, rot: -3, at: 4, mode: 'print', seed: 3 },
  { key: 'browser', left: 410, top: 150, rot: 3, at: 22, mode: 'drop', seed: 11 },
  { key: 'gpu', left: 760, top: 30, rot: -2, at: 36, mode: 'print', seed: 5 },
  { key: 'lumen', left: 1120, top: 210, rot: 4, at: 56, mode: 'drop', seed: 17 },
  { key: 'frame', left: 1400, top: 20, rot: -4, at: 70, mode: 'print', seed: 23 },
  { key: 'code', left: 230, top: 650, rot: 6, at: 92, mode: 'drop', seed: 29 },
  { key: 'mart', left: 960, top: 620, rot: -5, at: 112, mode: 'drop', seed: 31 },
];

const LINE_STEP = 31;

const Placed: React.FC<{ p: Placement }> = ({ p }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = R[p.key];
  const h = receiptHeight(lines);
  const t = frame - p.at;
  let y = p.top, rot = p.rot, shown = Infinity, photo = 1;
  if (t < 0) return null;
  if (p.mode === 'drop') {
    const s = spring({ frame: t, fps, config: { damping: 13, stiffness: 95, mass: 0.9 } });
    y = p.top + (1 - s) * -(h + 500);
    rot = p.rot + (1 - s) * (random(`spin-${p.key}`) > 0.5 ? 16 : -16);
    photo = interpolate(t, [10, 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  } else {
    // Printing: the paper feeds a line at a time, so the reveal steps in whole lines.
    const dur = Math.round(h / 22);
    const p01 = interpolate(t, [0, dur], [0, 1], { extrapolateRight: 'clamp', easing: Easing.out(Easing.quad) });
    shown = Math.floor((p01 * h) / LINE_STEP) * LINE_STEP + (p01 >= 1 ? h : 0);
    photo = interpolate(t, [dur * 0.25, dur * 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }
  // Once down, the paper still breathes a little.
  const sway = t > 20 ? Math.sin((frame + p.seed * 9) / 38) * 0.45 : 0;
  return (
    <div style={{ position: 'absolute', left: p.left, top: y, transform: `rotate(${(rot + sway).toFixed(3)}deg)`, transformOrigin: '50% 30%' }}>
      <Receipt id={`rc-${p.key}`} lines={lines} seed={p.seed} shown={shown} photoReveal={photo} />
    </div>
  );
};

export const ReceiptsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const p = frame / RECEIPTS_FRAMES;
  // Slow drift down the paper and push-in across the collage, easing in and out.
  const e = Easing.inOut(Easing.cubic)(p);
  const scale = 1 + 0.12 * e;
  const tx = -90 * e, ty = -240 * e, rot = -1.2 * e;
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse 75% 80% at 50% 42%, #66666b 0%, #3a3a3e 55%, #1b1b1e 100%)' }}>
      <AbsoluteFill style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale}) rotate(${rot}deg)`, transformOrigin: '50% 50%' }}>
        {PLACEMENTS.map((pl) => <Placed key={pl.key} p={pl} />)}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 90% 90% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.45) 100%)' }} />
    </AbsoluteFill>
  );
};
