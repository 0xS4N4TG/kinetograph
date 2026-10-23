// Deterministic codes for the receipts: a QR code (the qrcode-generator package) and a barcode from random(seed).

import React from 'react';
import { random } from 'remotion';
import qrcode from 'qrcode-generator';

/** A QR code of `text` as one SVG path: a module is a unit square, with a 2-module quiet zone. */
export const Qr: React.FC<{ text: string; size: number; ink?: string }> = ({ text, size, ink = '#141416' }) => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${n + 4} ${n + 4}`} shapeRendering="crispEdges">
      <path d={d} fill={ink} />
    </svg>
  );
};

/** A Code 128 look-alike: bars of 1 to 4 modules from random(seed), bar and space alternating, with a start and stop bar. */
export const Barcode: React.FC<{ seed: string; width: number; height: number; ink?: string }> = ({ seed, width, height, ink = '#141416' }) => {
  const runs: number[] = [2, 1, 1, 2];
  let total = 6;
  for (let i = 0; total < 96; i++) {
    const w = 1 + Math.floor(random(`${seed}-bar-${i}`) * 4);
    runs.push(w);
    total += w;
  }
  runs.push(2, 3, 1, 1);
  const sum = runs.reduce((a, b) => a + b, 0);
  let x = 0, d = '';
  runs.forEach((w, i) => { if (i % 2 === 0) d += `M${x} 0h${w}v1h-${w}z`; x += w; });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${sum} 1`} preserveAspectRatio="none" shapeRendering="crispEdges">
      <path d={d} fill={ink} />
    </svg>
  );
};
