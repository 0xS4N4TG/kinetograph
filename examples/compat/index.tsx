// A Remotion project written as a Remotion user would write it (docs/COMPAT.md):
// DOM elements with inline styles, SVG, `Img`, and nothing from Kinetograph.
// Compat mode renders it without a port. It is written for this repo (none of
// the papercut kit, which is private) and leans on what the kit leans on:
// absolute positioning, flex rows, `translate(-50%, -50%)`, box shadows,
// gradients, `filter`, `clipPath`, `mixBlendMode`, rounded cards and SVG icons.
//
// Frames 96 to 119 underline the headline (`textDecoration`, which the native
// path does not draw in this pass), so `doctor` reports one Chrome run there
// and `render` switches to Chrome for those frames only.
//
// On the M4:
//   npx kinetograph doctor examples/compat/index.tsx
//   npx kinetograph render examples/compat/index.tsx -o out/compat.mp4
//   npx kinetograph doctor examples/compat/index.tsx --compare 6
// and compare with Remotion rendering the same file.

import React from 'react';
import {
  AbsoluteFill,
  Composition,
  Img,
  Sequence,
  interpolate,
  registerRoot,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';

const { fontFamily } = loadFont('normal', { weights: ['400', '700'] });

const INK = '#14161c';
const PAPER = '#f4efe6';
const ACCENT = '#ff5a36';

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** A torn-paper card: a rounded box with a shadow and a polygon edge. */
const Card: React.FC<{ index: number; title: string; color: string }> = ({ index, title, color }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - index * 6, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        width: 260,
        height: 320,
        borderRadius: 18,
        backgroundColor: PAPER,
        boxShadow: '0 18px 40px rgba(0, 0, 0, 0.35), inset 0 0 0 2px rgba(20, 22, 28, 0.08)',
        transform: `translateY(${(1 - pop) * 80}px) rotate(${(index - 1) * 4 * pop}deg) scale(${0.8 + 0.2 * pop})`,
        opacity: pop,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 24,
        boxSizing: 'border-box',
        clipPath: 'polygon(0 0, 100% 0, 100% 92%, 82% 100%, 60% 94%, 34% 100%, 0 95%)',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          backgroundImage: `linear-gradient(135deg, ${color}, ${ACCENT})`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width={32} height={32} viewBox="0 0 24 24">
          <path d="M5 12l5 5L19 7" fill="none" stroke="#ffffff" strokeWidth={3} />
        </svg>
      </div>
      <p style={{ margin: 0, fontFamily, fontWeight: 700, fontSize: 34, lineHeight: 1.1, color: INK }}>{title}</p>
    </div>
  );
};

const Headline: React.FC = () => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [0, 20], [0, 100], clamp);
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: 170,
        transform: 'translate(-50%, 0)',
        clipPath: `inset(0 ${100 - reveal}% 0 0)`,
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily,
          fontWeight: 700,
          fontSize: 96,
          color: PAPER,
          whiteSpace: 'nowrap',
          // Not drawn natively in this pass: these frames go to Chrome.
          textDecoration: frame >= 96 && frame < 120 ? 'underline' : 'none',
        }}
      >
        Three <span style={{ color: ACCENT }}>small</span> steps
      </h1>
    </div>
  );
};

const Compat: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 150], [0, -60]);
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      {/* A soft photo backdrop, blurred and multiplied into the ink. */}
      <Img
        src={staticFile('swatch.png')}
        style={{
          position: 'absolute',
          width: 1400,
          height: 933,
          left: -100 + drift,
          top: 0,
          objectFit: 'cover',
          filter: 'blur(24px) saturate(1.4)',
          opacity: 0.45,
          mixBlendMode: 'screen',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(circle at 50% 120%, rgba(255, 90, 54, 0.35), rgba(20, 22, 28, 0) 60%)',
        }}
      />
      <Headline />
      <Sequence from={10} name="cards">
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 360,
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 36,
          }}
        >
          <Card index={0} title="Write the scene" color="#5ad1ff" />
          <Card index={1} title="Look at a frame" color="#ffd23f" />
          <Card index={2} title="Render it" color="#7cff8a" />
        </div>
      </Sequence>
      <Sequence from={60} name="footer">
        <div
          style={{
            position: 'absolute',
            bottom: 48,
            left: '50%',
            transform: `translateX(-50%) translateY(${interpolate(frame - 60, [0, 15], [30, 0], clamp)}px)`,
            opacity: interpolate(frame - 60, [0, 15], [0, 1], clamp),
            padding: '12px 28px',
            borderRadius: 999,
            border: `2px solid ${ACCENT}`,
            fontFamily,
            fontSize: 28,
            color: PAPER,
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
          }}
        >
          rendered without a port
        </div>
      </Sequence>
    </AbsoluteFill>
  );
};

registerRoot(() => (
  <Composition id="Compat" component={Compat} durationInFrames={150} fps={30} width={1200} height={1000} />
));
