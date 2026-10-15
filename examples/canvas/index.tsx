// Canvas 2D (docs/SCENE.md, "canvas"), two ways, with nothing from a browser behind either.
//
// `<Chart>` is a Remotion project's canvas, written as a Remotion user writes one: a `<canvas>` element, a ref, and a
// `useEffect` that draws with `getContext('2d')`. The engine records the calls and draws them natively. It clears the
// canvas and draws all of it on every frame, as a canvas that moves has to.
//
// `<Badge>` is the native element: `<Canvas draw={(ctx) => ...}>` is given a fresh context each frame.
//
//   npx kinetograph still examples/canvas/index.tsx --frame 45 -o out/canvas.png

import React, { useEffect, useRef } from 'react';
import { AbsoluteFill, Canvas, Composition, interpolate, random, registerFont, registerRoot, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

registerFont({ family: 'DM Sans', path: staticFile('DMSans-Medium.ttf') });

const W = 640;
const H = 360;
const BARS = 8;

const Chart: React.FC = () => {
  const frame = useCurrentFrame();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, '#1d2b64');
    sky.addColorStop(1, '#f8cdda');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Bars that grow in one after another, with rounded tops.
    const slot = (canvas.width - 80) / BARS;
    for (let i = 0; i < BARS; i += 1) {
      const grow = interpolate(frame, [i * 3, i * 3 + 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      const height = (60 + random(`bar-${i}`) * 160) * grow;
      const x = 40 + i * slot + slot * 0.15;
      ctx.fillStyle = `hsl(${200 + i * 18}, 80%, ${55 + i * 2}%)`;
      ctx.beginPath();
      ctx.roundRect(x, canvas.height - 50 - height, slot * 0.7, height, [10, 10, 0, 0]);
      ctx.fill();
    }

    // A dashed line and a pulsing dot, under a transform.
    ctx.save();
    ctx.translate(canvas.width - 60, 60);
    ctx.rotate((frame / 60) * Math.PI * 2);
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(30, 0, 6 + 2 * Math.sin(frame / 4), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = '600 26px "DM Sans", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Weekly signups', 40, 24);
    const label = `${Math.round(frame * 1.5)} / day`;
    ctx.font = '16px "DM Sans"';
    ctx.textAlign = 'right';
    ctx.fillText(label, canvas.width - 40, canvas.height - 36);
  });

  return <canvas ref={ref} width={W} height={H} style={{ display: 'block', borderRadius: 16 }} />;
};

const Badge: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas
      width={160}
      height={160}
      x={W + 40}
      y={20}
      draw={(ctx) => {
        const g = ctx.createRadialGradient(80, 80, 6, 80, 80, 78);
        g.addColorStop(0, '#fff3b0');
        g.addColorStop(1, '#e09f3e');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(80, 80, 76, 0, Math.PI * 2);
        ctx.fill();
        ctx.translate(80, 80);
        ctx.rotate(frame / 30);
        ctx.fillStyle = '#9e2a2b';
        for (let i = 0; i < 6; i += 1) {
          ctx.rotate(Math.PI / 3);
          ctx.fillRect(-4, -62, 8, 28);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#335c67';
        ctx.font = '38px "DM Sans"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEW', 80, 80);
      }}
    />
  );
};

const Main: React.FC = () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: '#10131a' }}>
      <div style={{ position: 'absolute', left: 20, top: 20, width: W, height: H }}>
        <Chart />
      </div>
      <Badge />
      <div style={{ position: 'absolute', left: 20, top: H + 40, width: width - 40, height: height - H - 60 }} />
    </AbsoluteFill>
  );
};

const Root: React.FC = () => <Composition id="Canvas" component={Main} durationInFrames={60} fps={30} width={860} height={420} />;

registerRoot(Root);
