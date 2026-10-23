// The six React Native Skia components that draw an object or a list rather than a shape: `Atlas`, `Patch`, `Glyphs`,
// `TextBlob`, `Picture` and `ImageSVG` (packages/cli/skills/kinetograph/references/AUTHORING.md §7.7), one composition each, written the way a
// `@remotion/skia` project writes them. Skia (the optional `@kinetographdev/skia` addon) draws them.
//
//   npx kinetograph still examples/skia-components/index.tsx 20 --comp Atlas -o out/atlas.png
//   (and Patch, Glyphs, TextBlob, Picture, ImageSVG)

import React, { useMemo } from 'react';
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'remotion';
import {
  Atlas,
  Canvas,
  createPicture,
  Fill,
  Glyphs,
  ImageSVG,
  Group,
  Patch,
  Picture,
  Skia,
  TextBlob,
  useFont,
  useImage,
  type SkFont,
} from '@shopify/react-native-skia';

const W = 480;
const H = 270;
const BG = '#14161c';

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: BG }}>
    <Canvas style={{ width: W, height: H }}>
      <Fill color={BG} />
      {children}
    </Canvas>
  </AbsoluteFill>
);

/** 48 sprites of a four-sprite sheet on a grid, each turning at its own rate. */
const AtlasDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const sheet = useImage(staticFile('sprites.png'));
  const sprites = [];
  const transforms = [];
  for (let i = 0; i < 48; i += 1) {
    const col = i % 8;
    const row = Math.floor(i / 8);
    sprites.push(Skia.XYWHRect((i % 2) * 32, (Math.floor(i / 2) % 2) * 32, 32, 32));
    transforms.push(Skia.RSXformFromRadians(0.8, (frame + i * 7) * 0.08 * (i % 2 ? 1 : -1), 40 + col * 56, 28 + row * 42, 16, 16));
  }
  return (
    <Frame>
      <Atlas image={sheet} sprites={sprites} transforms={transforms} />
    </Frame>
  );
};

/** A Coons patch: four corners with their control points, four colours, the corners bobbing. */
const PatchDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const bob = Math.sin(frame * 0.2) * 24;
  const C = 80;
  const x0 = 100;
  const y0 = 30;
  const w = 280;
  const h = 210;
  const patch = [
    { pos: { x: x0, y: y0 }, c1: { x: x0, y: y0 + C }, c2: { x: x0 + C, y: y0 - bob } },
    { pos: { x: x0 + w, y: y0 }, c1: { x: x0 + w - C, y: y0 + bob }, c2: { x: x0 + w, y: y0 + C } },
    { pos: { x: x0 + w, y: y0 + h }, c1: { x: x0 + w, y: y0 + h - C }, c2: { x: x0 + w - C, y: y0 + h + bob } },
    { pos: { x: x0, y: y0 + h }, c1: { x: x0 + C, y: y0 + h - bob }, c2: { x: x0, y: y0 + h - C } },
  ];
  return (
    <Frame>
      <Patch patch={patch} colors={['#61dafb', '#fb61da', '#61fbcf', '#dafb61']} />
    </Frame>
  );
};

/** The glyphs of a word, each at a position of its own: a wave. */
const GlyphsDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const font = useFont(staticFile('DMSans-Medium.ttf'), 44) as SkFont;
  const text = 'Glyphs on a wave';
  const ids = font.getGlyphIDs(text);
  const widths = font.getGlyphWidths(text);
  let x = 0;
  const glyphs = ids.map((id, i) => {
    const pos = { x, y: Math.sin(frame * 0.2 + i * 0.6) * 18 };
    x += widths[i]!;
    return { id, pos };
  });
  return (
    <Frame>
      <Glyphs font={font} glyphs={glyphs} x={(W - x) / 2} y={H / 2 + 14} color="#f4efe6" />
    </Frame>
  );
};

/** A blob of a text, and a blob with one transform for each glyph, on an arc. */
const TextBlobDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const font = useFont(staticFile('DMSans-Medium.ttf'), 34) as SkFont;
  const text = 'Text blobs on a curve';
  const widths = font.getGlyphWidths(text);
  let along = 0;
  const xforms = widths.map((width, i) => {
    const angle = -0.9 + ((along + width / 2) / 360) * 1.8 + Math.sin(frame * 0.15) * 0.1;
    const at = { x: 60 + along, y: 150 - Math.sin((along / 360) * Math.PI) * 60 };
    along += width;
    return Skia.RSXformFromRadians(1, angle, at.x, at.y, 0, 0);
  });
  const arc = Skia.TextBlob.MakeFromRSXform(text, xforms, font);
  const flat = Skia.TextBlob.MakeFromText('MakeFromText', font);
  return (
    <Frame>
      <TextBlob blob={arc} color="#ff5a36" />
      <TextBlob blob={flat} x={140} y={235} color="#f4efe6" />
    </Frame>
  );
};

/** A picture recorded once and drawn three times. */
const PictureDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const picture = useMemo(
    () =>
      createPicture((canvas) => {
        const red = Skia.Paint().setColor(Skia.Color('#ff5a36'));
        const blue = Skia.Paint().setColor(Skia.Color('#28a0f0'));
        const outline = Skia.Paint().setColor(Skia.Color('#f4efe6')).setStyle('stroke').setStrokeWidth(3);
        canvas.drawRRect({ rect: Skia.XYWHRect(0, 0, 100, 70), rx: 14, ry: 14 }, red);
        canvas.save();
        canvas.translate(50, 35);
        canvas.rotate(30);
        canvas.drawRect(Skia.XYWHRect(-22, -22, 44, 44), blue);
        canvas.restore();
        canvas.drawCircle(50, 35, 30, outline);
      }),
    [],
  );
  return (
    <Frame>
      <Group transform={[{ translateX: 30 }, { translateY: 30 }]}>
        <Picture picture={picture} />
      </Group>
      <Group transform={[{ translateX: 190 }, { translateY: 40 + Math.sin(frame * 0.2) * 20 }, { scale: 1.3 }]}>
        <Picture picture={picture} />
      </Group>
      <Group transform={[{ translateX: 360 }, { translateY: 80 }, { rotate: frame * 0.05 }, { scale: 0.8 }]}>
        <Picture picture={picture} />
      </Group>
    </Frame>
  );
};

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5a36"/><stop offset="1" stop-color="#fb61da"/></linearGradient></defs>
  <circle cx="50" cy="50" r="46" fill="url(#g)"/>
  <path d="M30 52 L45 67 L72 34" fill="none" stroke="#14161c" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/** An SVG made from a string, drawn at two sizes. */
const ImageSVGDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const svg = useMemo(() => Skia.SVG.MakeFromString(SVG), []);
  const size = 110 + Math.sin(frame * 0.2) * 20;
  return (
    <Frame>
      <ImageSVG svg={svg} x={40} y={30} width={size} height={size} />
      <ImageSVG svg={svg} x={250} y={60} width={160} height={160} />
    </Frame>
  );
};

const Root: React.FC = () => (
  <>
    {[
      ['Atlas', AtlasDemo],
      ['Patch', PatchDemo],
      ['Glyphs', GlyphsDemo],
      ['TextBlob', TextBlobDemo],
      ['Picture', PictureDemo],
      ['ImageSVG', ImageSVGDemo],
    ].map(([id, component]) => (
      <Composition key={id as string} id={id as string} component={component as React.FC} width={W} height={H} fps={30} durationInFrames={60} />
    ))}
  </>
);

registerRoot(Root);
