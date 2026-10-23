// One thermal receipt: monospace and Japanese lines, a dithered photo, a QR code, a barcode, a serrated top and bottom,
// a faint paper gradient and a soft shadow. A receipt is a list of lines with known heights, so its own height (needed
// for the serrated clip-path) is the sum, and `shown` reveals it a printed line at a time.

import React from 'react';
import { GlslShader } from '@kinetograph/core';
import { staticFile } from 'remotion';
import { loadFont as loadCourier } from '@remotion/google-fonts/CourierPrime';
import { loadFont as loadNoto } from '@remotion/google-fonts/NotoSansJP';
import { Barcode, Qr } from './qr.js';
import { THERMAL } from './thermal.js';

export const COURIER = loadCourier('normal', { weights: ['400', '700'] }).fontFamily;
export const NOTO = loadNoto('normal', { weights: ['400', '700'] }).fontFamily;
const MIXED = `${COURIER}, ${NOTO}`;
const JP = `${NOTO}, ${COURIER}`;

export const RECEIPT_W = 460;
const PAD = 30;
const INNER = RECEIPT_W - PAD * 2;
const LINE = 31;
const TOOTH = 12;

export interface PhotoSpec { src: string; w: number; h: number; mid?: number; contrast?: number; bias?: number; dot?: number }

export type Line =
  | ['title', string]       // big, centred, Japanese first
  | ['c', string]           // centred
  | ['s', string]           // small, grey, centred
  | ['jp', string]          // Japanese, centred
  | ['r', string, string]   // left and right
  | ['b', string, string]   // bold left and right
  | ['rule' | 'dbl']
  | ['sp', number]
  | ['photo', PhotoSpec, number]  // photo and its height in px
  | ['qr', string, number]  // text and size
  | ['bar', string, number]; // seed and height

const heightOf = (l: Line): number => {
  switch (l[0]) {
    case 'title': return 62;
    case 'sp': return l[1];
    case 'photo': return l[2] + 14;
    case 'qr': return l[2] + 14;
    case 'bar': return l[2] + 40;
    case 'rule': case 'dbl': return 18;
    default: return LINE;
  }
};

export const receiptHeight = (lines: Line[]) => lines.reduce((a, l) => a + heightOf(l), 0) + 2 * (TOOTH + 16);

const INK = '#17171a';
const FADE = '#55555b';

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', whiteSpace: 'nowrap', height: LINE, alignItems: 'center' };

const Row: React.FC<{ line: Line; reveal: number; seed: number; id: string }> = ({ line, reveal, seed, id }) => {
  switch (line[0]) {
    case 'title':
      return <div style={{ height: 62, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: JP, fontWeight: 700, fontSize: 36, letterSpacing: 2, whiteSpace: 'nowrap' }}>{line[1]}</div>;
    case 'c': return <div style={{ ...row, justifyContent: 'center', fontFamily: MIXED, fontSize: 22 }}>{line[1]}</div>;
    case 's': return <div style={{ ...row, justifyContent: 'center', fontFamily: MIXED, fontSize: 17, color: FADE }}>{line[1]}</div>;
    case 'jp': return <div style={{ ...row, justifyContent: 'center', fontFamily: JP, fontWeight: 400, fontSize: 21 }}>{line[1]}</div>;
    case 'r': return <div style={{ ...row, fontFamily: MIXED, fontSize: 22 }}><span>{line[1]}</span><span>{line[2]}</span></div>;
    case 'b': return <div style={{ ...row, fontFamily: MIXED, fontWeight: 700, fontSize: 25 }}><span>{line[1]}</span><span>{line[2]}</span></div>;
    case 'rule': return <div style={{ height: 18, display: 'flex', alignItems: 'center' }}><div style={{ width: '100%', borderTop: `2px dashed ${FADE}` }} /></div>;
    case 'dbl': return <div style={{ height: 18, display: 'flex', alignItems: 'center' }}><div style={{ width: '100%', height: 6, borderTop: `2px solid ${INK}`, borderBottom: `2px solid ${INK}` }} /></div>;
    case 'sp': return <div style={{ height: line[1] }} />;
    case 'photo': {
      const p = line[1];
      return (
        <div style={{ height: line[2] + 14, paddingTop: 7 }}>
          {/* The shader's own box is 0 x 0 in HTML flow: a sized, positioned wrapper gives it a place. */}
          <div style={{ position: 'relative', width: INNER, height: line[2] }}>
          <GlslShader
            id={`${id}-photo`} width={INNER} height={line[2]} fragment={THERMAL}
            uniforms={{
              u_res: [INNER, line[2]], u_img_size: [p.w, p.h], u_dot: p.dot ?? 3, u_reveal: reveal, u_seed: seed,
              u_mid: p.mid ?? 0.5, u_contrast: p.contrast ?? 1.8, u_bias: p.bias ?? 0,
            }}
            textures={{ u_img: { src: staticFile(p.src), filter: 'linear', wrap: 'clamp' } }}
          />
          </div>
        </div>
      );
    }
    case 'qr':
      return <div style={{ height: line[2] + 14, display: 'flex', justifyContent: 'center', paddingTop: 7 }}><Qr text={line[1]} size={line[2]} /></div>;
    case 'bar':
      return (
        <div style={{ height: line[2] + 40, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
          <Barcode seed={line[1]} width={INNER - 40} height={line[2]} />
          <div style={{ fontFamily: COURIER, fontSize: 17, letterSpacing: 6, marginTop: 4 }}>{(4900000000000 + Math.floor(parseInt(line[1].replace(/\D/g, '') || '7', 10) * 7919) % 99999999999).toString()}</div>
        </div>
      );
  }
};

/** The serrated outline of the paper: teeth along the top and bottom edge. */
const serrated = (h: number): string => {
  const n = Math.round(RECEIPT_W / (TOOTH * 1.3));
  const tw = RECEIPT_W / n;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) pts.push(`${(i * tw).toFixed(1)}px ${TOOTH}px`, `${((i + 0.5) * tw).toFixed(1)}px 0px`);
  pts.push(`${RECEIPT_W}px ${TOOTH}px`, `${RECEIPT_W}px ${h - TOOTH}px`);
  for (let i = n; i > 0; i--) pts.push(`${(i * tw).toFixed(1)}px ${h - TOOTH}px`, `${((i - 0.5) * tw).toFixed(1)}px ${h}px`);
  pts.push(`0px ${h - TOOTH}px`);
  return `polygon(${pts.join(', ')})`;
};

/** `shown` is how many px of the receipt, from the top, are printed (the rest is not there yet). `photoReveal` 0..1. */
export const Receipt: React.FC<{ id: string; lines: Line[]; seed: number; shown?: number; photoReveal?: number }> = ({
  id, lines, seed, shown = Infinity, photoReveal = 1,
}) => {
  const h = receiptHeight(lines);
  const visible = Math.min(h, shown);
  return (
    // The shadow is a filter on the outside: a clip-path would cut a box-shadow off.
    <div style={{ width: RECEIPT_W, height: h, filter: 'drop-shadow(0px 16px 18px rgba(0,0,0,0.42))' }}>
      <div style={{ width: RECEIPT_W, height: h, clipPath: `inset(0px 0px ${Math.max(0, h - visible)}px 0px)` }}>
        <div style={{
          position: 'relative', width: RECEIPT_W, height: h, clipPath: serrated(h), color: INK,
          background: 'linear-gradient(180deg, #fbfaf6 0%, #f6f4ee 55%, #efede5 100%)',
        }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: RECEIPT_W, height: h, background: 'linear-gradient(90deg, rgba(0,0,0,0.07) 0%, rgba(0,0,0,0) 9%, rgba(0,0,0,0) 91%, rgba(0,0,0,0.08) 100%)' }} />
          <div style={{ position: 'absolute', left: PAD, top: TOOTH + 16, width: INNER }}>
            {lines.map((l, i) => <Row key={i} line={l} reveal={photoReveal} seed={seed} id={`${id}-${i}`} />)}
          </div>
        </div>
      </div>
    </div>
  );
};
