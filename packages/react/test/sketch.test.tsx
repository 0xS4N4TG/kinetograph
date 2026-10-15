import { describe, expect, it } from 'vitest';
import { dropShadow, linearGradient, motionBlur } from '@kinetograph/scene';
import { Image, Layer, Text, useTimeline } from '../src/index.js';
import { renderAt } from './harness.js';

// The component of HANDOFF.md §5, with plain arithmetic standing in for `spring` and `interpolate`.
const Card = () => {
  const { frame } = useTimeline();
  const s = Math.min(1, frame / 30);
  return (
    <Layer z={-400 * (1 - s)} rotateY={(1 - s) * 25} effects={[motionBlur({ samples: 8 }), dropShadow({ y: 12, blur: 24 })]}>
      <Image src="/public/model.jpg" fit="cover" />
      <Text font="Inter" size={64} fill={linearGradient(['#f9a', '#fc6'])}>
        gets better
      </Text>
    </Layer>
  );
};

describe('the HANDOFF.md §5 sketch', () => {
  it('emits the scene JSON of the contract at frame 15', () => {
    expect(renderAt(<Card />, 15).layers).toEqual([
      {
        id: '$0',
        type: 'group',
        transform: { z: -200, rotateY: 12.5 },
        effects: [{ type: 'dropShadow', y: 12, blur: 24 }],
        motionBlur: { samples: 8 },
        children: [
          { id: '$0.0', type: 'image', src: '/public/model.jpg', fit: 'cover' },
          {
            id: '$0.1',
            type: 'text',
            text: 'gets better',
            font: 'Inter',
            size: 64,
            color: {
              type: 'linear',
              x0: 0.5,
              y0: 0,
              x1: 0.5,
              y1: 1,
              stops: [
                { offset: 0, color: '#f9a' },
                { offset: 1, color: '#fc6' },
              ],
              units: 'box',
            },
          },
        ],
      },
    ]);
  });

  it('settles at frame 30, with the card flat', () => {
    expect(renderAt(<Card />, 30).layers[0]).toMatchObject({ transform: { z: -0, rotateY: 0 } });
  });
});
