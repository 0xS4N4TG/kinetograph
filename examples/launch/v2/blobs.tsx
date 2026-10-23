// Blob-tracking overlay: thin boxes, crosshairs, mono labels and links between nearby blobs, drawn over footage from
// `blobs/<clip>.json` (tools/blobs/analyse.mjs). The analysis is offline; this only reads the JSON, and its jitter is
// random(seed) of the blob id and frame, so a frame is the same on every render.

import React from 'react';
import { AbsoluteFill, random } from 'remotion';

export interface Blob { id: number; x: number; y: number; w: number; h: number }
export interface BlobData { clip: string; fps: number; frames: number; blobs: Blob[][] }

const INK = '#FFFFFF';
const MONO = '"JetBrains Mono", monospace';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `frame` is the clip's frame (the caller wraps it when the clip loops); `invert` makes the largest boxes (and every
 *  third id) flip the picture inside them, with `mix-blend-mode: difference`. */
export const BlobOverlay: React.FC<{
  data: BlobData; frame: number; width: number; height: number; mono?: string; invert?: boolean; link?: number;
}> = ({ data, frame, width, height, mono = MONO, invert = true, link = 0.34 }) => {
  const list = data.blobs[Math.min(Math.max(frame, 0), data.blobs.length - 1)] ?? [];
  const boxes = list.map((b) => {
    // A little jitter every frame, and now and then a bigger twitch, like a tracker that is not quite sure.
    const big = random(`twitch-${b.id}-${frame}`) < 0.07 ? 4 : 1.4;
    const jx = (random(`jx-${b.id}-${frame}`) - 0.5) * 2 * big;
    const jy = (random(`jy-${b.id}-${frame}`) - 0.5) * 2 * big;
    const pad = 7 + random(`jp-${b.id}-${frame}`) * 2;
    const cx = b.x * width + jx, cy = b.y * height + jy;
    const w = Math.max(30, b.w * width + pad * 2), h = Math.max(30, b.h * height + pad * 2);
    return { b, cx, cy, left: cx - w / 2, top: cy - h / 2, w, h };
  });
  const flip = boxes.filter((o, i) => invert && (i === 0 || o.b.id % 3 === 0));
  const links: [typeof boxes[number], typeof boxes[number]][] = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach((c) => {
    if (Math.hypot((a.cx - c.cx) / width, (a.cy - c.cy) / width) < link) links.push([a, c]);
  }));
  return (
    <AbsoluteFill>
      {/* Boxes that invert the video under them: white, blended with difference. */}
      <AbsoluteFill style={{ mixBlendMode: 'difference' }}>
        {flip.map((o) => <div key={o.b.id} style={{ position: 'absolute', left: o.left, top: o.top, width: o.w, height: o.h, background: '#FFFFFF' }} />)}
      </AbsoluteFill>
      <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }}>
        {links.map(([a, c]) => (
          <line key={`${a.b.id}-${c.b.id}`} x1={a.cx} y1={a.cy} x2={c.cx} y2={c.cy} stroke={INK} strokeWidth={1.5} strokeOpacity={0.55} strokeDasharray="6 5" />
        ))}
        {boxes.map((o) => (
          <g key={o.b.id}>
            <rect x={o.left} y={o.top} width={o.w} height={o.h} fill="none" stroke={INK} strokeWidth={2} />
            {/* corner ticks, drawn heavier than the box */}
            {[[o.left, o.top, 1, 1], [o.left + o.w, o.top, -1, 1], [o.left, o.top + o.h, 1, -1], [o.left + o.w, o.top + o.h, -1, -1]].map(([x, y, sx, sy], k) => (
              <path key={k} d={`M${x + sx * 14} ${y} L${x} ${y} L${x} ${y + sy * 14}`} fill="none" stroke={INK} strokeWidth={4} />
            ))}
            {/* crosshair at the centre, with a gap in the middle */}
            <path d={`M${o.cx - 14} ${o.cy} H${o.cx - 4} M${o.cx + 4} ${o.cy} H${o.cx + 14} M${o.cx} ${o.cy - 14} V${o.cy - 4} M${o.cx} ${o.cy + 4} V${o.cy + 14}`} stroke={INK} strokeWidth={2} />
          </g>
        ))}
      </svg>
      <div style={{ position: 'absolute', left: 36, top: 30, color: INK, fontFamily: mono, fontWeight: 500, fontSize: 18, letterSpacing: 1, whiteSpace: 'pre', textShadow: '0 0 6px rgba(0,0,0,0.6)' }}>
        {`TRK  N=${pad2(boxes.length)}  F${String(frame).padStart(4, '0')}`}
      </div>
      {boxes.map((o) => (
        <div key={o.b.id} style={{
          position: 'absolute', left: o.left, top: o.top - 25, padding: '2px 7px', background: 'rgba(0,0,0,0.62)', color: INK,
          fontFamily: mono, fontWeight: 500, fontSize: 17, letterSpacing: 0.4, whiteSpace: 'pre',
        }}>{`ID ${pad2(o.b.id)}  x${o.b.x.toFixed(2)} y${o.b.y.toFixed(2)}`}</div>
      ))}
    </AbsoluteFill>
  );
};
