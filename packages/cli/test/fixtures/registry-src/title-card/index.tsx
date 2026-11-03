import { AbsoluteFill, Img, Text, interpolate, staticFile, useCurrentFrame } from '@kinetographdev/core';
import { loadFont } from '@remotion/google-fonts/Inter';
import { z } from 'zod';

const { fontFamily } = loadFont('normal', { weights: ['400'] });

export const titleCardSchema = z.object({
  title: z.string().describe('The big line.'),
  subtitle: z.string().optional().describe('A smaller line under the title.'),
  background: z.string().default('#14171f').describe('Background colour.'),
  color: z.string().default('#ffffff').describe('Text colour.'),
});

export type TitleCardProps = z.input<typeof titleCardSchema>;

export const TitleCard = ({ title, subtitle, background = '#14171f', color = '#ffffff' }: TitleCardProps) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: background, opacity }}>
      <Img src={staticFile('images/title-card/dot.png')} style={{ position: 'absolute', left: 320, top: 140, width: 48, height: 48 }} />
      <Text x={320} y={200} font={fontFamily} size={96} color={color}>
        {title}
      </Text>
      {subtitle === undefined ? null : (
        <Text x={320} y={330} font={fontFamily} size={40} color={color}>
          {subtitle}
        </Text>
      )}
    </AbsoluteFill>
  );
};
