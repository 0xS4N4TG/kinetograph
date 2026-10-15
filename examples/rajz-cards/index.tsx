// A rebuild of five seconds of the reference video (docs/reference/, about
// 20.5 to 25.5 s of rajz-reference.mp4): a cluster of photo cards in 3D, an
// arc of cards with "gets" and "better" angled around it, "you … create" with
// a row of small cards receding between the words, and a whip transition that
// smears everything over an orange-pink glow.
//
// It is written the way an agent would write it for Remotion: the timeline
// API from `remotion`, a Google font from `@remotion/google-fonts`, plus
// Kinetograph's native elements and effects for the 3D cards and the blur.
// The reference's photos are third-party, so each card is a stand-in drawn
// from shapes: a pale studio backdrop and a dark figure in a pose picked by
// `random(seed)`.
//
// Render on the M4 (docs/HANDOFF.md §8, Phase 3):
//   npx kinetograph still examples/rajz-cards/index.tsx 60 -o out/rajz-60.png
//   npx kinetograph strip examples/rajz-cards/index.tsx -n 12 -o out/rajz-strip.png
//   npx kinetograph render examples/rajz-cards/index.tsx -o out/rajz-cards.mp4
// and compare with the reference from 20.5 s.

import React from 'react';
import {
  AbsoluteFill,
  Composition,
  Easing,
  Sequence,
  interpolate,
  random,
  registerRoot,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Inter';
import {
  Camera,
  Ellipse,
  Layer,
  Path,
  Rect,
  Text,
  blur,
  dropShadow,
  linearGradient,
} from '@kinetograph/core';
import { onFrame } from '@kinetograph/audio';

const { fontFamily } = loadFont('normal', { weights: ['400'] });

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 25;
const BACKDROP = '#e8e8e8';
const INK = '#111111';

// ---- one card ----

// The card is drawn on a 220 x 300 grid and scaled up: the reference's cards
// are about 450 px tall on the 1080 px frame.
const GRID_W = 220;
const GRID_H = 300;
const CARD_SCALE = 1.5;
const CARD_W = GRID_W * CARD_SCALE;
const CARD_H = GRID_H * CARD_SCALE;

/** A dark figure on a pale backdrop, centred on (0, 0): head, body and legs
 *  in a pose that `seed` picks, so every card in a stack differs. */
const Card: React.FC<{ seed: number; id?: string } & Record<string, unknown>> = ({
  seed,
  ...props
}) => {
  const lean = (random(`lean-${seed}`) - 0.5) * 40;
  const crouch = random(`crouch-${seed}`) * 50;
  const portrait = random(`portrait-${seed}`) > 0.6;
  const cx = GRID_W / 2 + (random(`x-${seed}`) - 0.5) * 40;
  const headR = portrait ? 34 : 18;
  const headY = portrait ? 105 : 62 + crouch;
  const shoulders = portrait ? 92 : 46;
  const bodyTop = headY + headR - 4;
  const hem = portrait ? GRID_H + 10 : 205 + crouch / 2;
  const body =
    `M ${cx - shoulders / 2} ${bodyTop + 10} ` +
    `Q ${cx} ${bodyTop - 6} ${cx + shoulders / 2} ${bodyTop + 10} ` +
    `L ${cx + shoulders / 2 + lean / 3 + 12} ${hem} L ${cx - shoulders / 2 + lean / 3 - 12} ${hem} Z`;
  const legs = portrait
    ? ''
    : `M ${cx - 16 + lean / 3} ${hem} L ${cx - 22 + lean} ${GRID_H - 22} L ${cx - 8 + lean} ${GRID_H - 22} ` +
      `L ${cx + lean / 3} ${hem + 10} L ${cx + 10 - lean / 2} ${GRID_H - 20} L ${cx + 24 - lean / 2} ${GRID_H - 20} ` +
      `L ${cx + 16 + lean / 3} ${hem} Z`;
  return (
    <Layer {...props}>
      <Layer x={-CARD_W / 2} y={-CARD_H / 2} scale={CARD_SCALE} anchorX={0} anchorY={0}>
        <Rect
          width={GRID_W}
          height={GRID_H}
          fill={linearGradient(['#fafafa', '#d9d9d9'], { angle: 160 })}
          effects={[dropShadow({ y: 8, blur: 12, color: '#00000030' })]}
        />
        <Ellipse
          x={cx - headR}
          y={headY - headR}
          width={headR * 2}
          height={headR * 2.2}
          fill={INK}
        />
        <Path d={body} fill={INK} />
        {legs ? <Path d={legs} fill="#1c1c1c" /> : null}
      </Layer>
    </Layer>
  );
};

// ---- words ----

/** A word whose letters rise into place one after another from `start`. */
const Word: React.FC<{
  text: string;
  start: number;
  size?: number;
  id?: string;
} & Record<string, unknown>> = ({ text, start, size = 64, ...props }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Text
      {...props}
      font={fontFamily}
      size={size}
      color={INK}
      chars={(_char, i) => {
        const s = spring({ frame: frame - start - i * 2, fps, config: { damping: 16 } });
        return { y: (1 - s) * size * 0.6, opacity: s };
      }}
    >
      {text}
    </Text>
  );
};

// ---- scene A: the cluster (0 to 40) ----

const Cluster: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cards = [0, 1, 2, 3, 4];
  const spin = interpolate(frame, [0, 45], [-38, -12], { easing: Easing.out(Easing.cubic) });
  return (
    <Layer id="cluster" x={WIDTH / 2} y={HEIGHT / 2} rotateY={spin} preserve3d>
      {cards.map((i) => {
        const s = spring({ frame: frame - i * 4, fps, config: { damping: 14 } });
        return (
          <Card
            key={i}
            id={`cluster-${i}`}
            seed={i}
            x={(i - 2) * 105 + (1 - s) * 300}
            y={(i % 2 === 0 ? -1 : 1) * 45}
            z={-i * 135}
            rotateY={(i - 2) * 6}
            scale={0.8 + 0.2 * s}
            opacity={s}
          />
        );
      })}
    </Layer>
  );
};

// ---- scene B: the arc, "gets" / "better" (0 to 40 of its Sequence) ----

const Arc: React.FC = () => {
  const frame = useCurrentFrame();
  const count = 9;
  const radius = 1500;
  const turn = interpolate(frame, [0, 40], [24, 4], { easing: Easing.out(Easing.quad) });
  return (
    <Layer id="arc" x={WIDTH / 2 - 120} y={HEIGHT / 2} rotateY={turn} preserve3d>
      {Array.from({ length: count }, (_, i) => {
        const angle = (i - 6.5) * 11;
        const rad = (angle * Math.PI) / 180;
        return (
          <Card
            key={i}
            id={`arc-${i}`}
            seed={10 + i}
            x={radius * Math.sin(rad)}
            z={radius * Math.cos(rad) - radius}
            y={(i % 3) * 27 - 27}
            rotateY={angle}
          />
        );
      })}
      <Word id="gets" text="gets" start={4} x={-30} y={-CARD_H / 2 - 80} rotateY={-14} />
      <Word id="better" text="better" start={9} x={-40} y={CARD_H / 2 + 6} rotateY={-14} rotateX={10} />
    </Layer>
  );
};

// ---- scene C: "you … create" (0 to 60 of its Sequence) ----

const YouCreate: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const big = spring({ frame, fps, config: { damping: 18, mass: 0.8 } });
  const row = Array.from({ length: 8 }, (_, i) => i);
  return (
    <Layer id="you-create">
      <Word id="you" text="you" start={0} x={560} y={HEIGHT / 2 - 40} />
      <Layer id="row" x={860} y={HEIGHT / 2} preserve3d>
        {row.map((i) => {
          const s = spring({ frame: frame - 3 - i * 2, fps, config: { damping: 15 } });
          return (
            <Card
              key={i}
              id={`row-${i}`}
              seed={30 + i}
              x={-200 + i * 75}
              y={(i % 2) * 60 - 30}
              z={-600 + i * 40 - (1 - s) * 700}
              rotateY={-18}
              opacity={s}
            />
          );
        })}
      </Layer>
      <Card
        id="hero"
        seed={47}
        x={1180}
        y={HEIGHT / 2}
        scale={0.5 + 0.7 * big}
        rotateY={(1 - big) * -30}
        opacity={Math.min(1, big * 2)}
      />
      <Word id="create" text="create" start={6} x={1400} y={HEIGHT / 2 - 40} />
    </Layer>
  );
};

// ---- the whole segment ----

export const RajzCards: React.FC = () => {
  const frame = useCurrentFrame();
  // The whip: everything slides out to the left, accelerating, over frames
  // 100 to 120, and motion blur smears it along the way. (`Easing.exp` is not
  // 0 at the start, so it would nudge the layers before the whip begins.)
  const whip = interpolate(frame, [100, 120], [0, -2600], {
    easing: Easing.in(Easing.poly(4)),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // The gradient wipe: a tall band, transparent at its top, that rises until it covers the frame.
  const wipe = interpolate(frame, [92, 124], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ backgroundColor: BACKDROP }}>
      <Camera perspective={1400} />
      <Rect
        id="glow"
        width={WIDTH * 1.2}
        height={HEIGHT * 1.8}
        x={-WIDTH * 0.1}
        y={HEIGHT - wipe * HEIGHT * 1.6}
        fill={linearGradient(
          [[0, '#b69cf600'], [0.25, '#b69cf6'], [0.5, '#ec6fd0'], [0.75, '#ff4d6e'], [1, '#ff9a2e']],
          { angle: 180 },
        )}
        effects={[blur(30)]}
        layoutItem={{ position: 'absolute' }}
      />
      <Layer
        id="whip"
        x={whip}
        // Only while it moves: a blurred layer is drawn once per sample.
        motionBlur={frame >= 99 ? { samples: 12, shutter: 1 } : undefined}
        layoutItem={{ position: 'absolute' }}
      >
        <Sequence from={0} durationInFrames={42}>
          <Cluster />
        </Sequence>
        <Sequence from={36} durationInFrames={36}>
          <Arc />
        </Sequence>
        <Sequence from={68}>
          <YouCreate />
        </Sequence>
      </Layer>
    </AbsoluteFill>
  );
};

// ---- sound: a tick as each scene lands, a whoosh for the whip ----

for (const frame of [4, 40, 70]) {
  onFrame(frame, (ctx, t) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.05);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  });
}

onFrame(98, (ctx, t) => {
  // Seeded white noise through a band-pass that sweeps up: the whoosh.
  const seconds = 0.9;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = random(`whoosh-${i}`) * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.2;
  band.frequency.setValueAtTime(300, t);
  band.frequency.exponentialRampToValueAtTime(4000, t + seconds * 0.8);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.6, t + seconds * 0.7);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  source.connect(band).connect(gain).connect(ctx.destination);
  source.start(t);
});

registerRoot(() => (
  <Composition
    id="RajzCards"
    component={RajzCards}
    durationInFrames={125}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
));
