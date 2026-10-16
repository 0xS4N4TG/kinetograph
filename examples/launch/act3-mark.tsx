// The Kinetograph mark for the logo-flicker slot: a film strip frame with sprocket holes and a lowercase k.
// Rendered by Kinetograph to a transparent PNG:
//   node ../../packages/cli/dist/cli.js still act3-mark.tsx 0 -o public/brand/kinetograph-mark.png
import React from 'react';
import { Composition, registerRoot } from 'remotion';

const S = 512;

export const Mark: React.FC = () => {
  const holes = Array.from({ length: 6 }, (_, i) => 72 + i * 68);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
      {/* the strip */}
      <rect x={24} y={24} width={464} height={464} rx={46} fill="none" stroke="#fff" strokeWidth={22} />
      {/* sprocket holes, both edges */}
      {holes.map((y) => (
        <React.Fragment key={y}>
          <rect x={58} y={y} width={26} height={38} rx={8} fill="#fff" />
          <rect x={428} y={y} width={26} height={38} rx={8} fill="#fff" />
        </React.Fragment>
      ))}
      {/* the k: a stem and two arms, round ends */}
      <g stroke="#fff" strokeWidth={46} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M205 120 V392" />
        <path d="M312 190 L205 275" />
        <path d="M244 258 L318 392" />
      </g>
    </svg>
  );
};

registerRoot(() => <Composition id="mark" component={Mark} width={S} height={S} fps={30} durationInFrames={1} />);
