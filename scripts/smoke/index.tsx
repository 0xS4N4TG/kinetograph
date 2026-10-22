// The project the clean-install smoke test renders: 30 frames of a box sliding across the frame.
import React from 'react';
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from 'remotion';

const Box: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#14171f' }}>
      <div style={{ position: 'absolute', left: interpolate(frame, [0, 29], [20, 400]), top: 100, width: 120, height: 120, background: '#ff5a36', borderRadius: 24 }} />
    </AbsoluteFill>
  );
};

registerRoot(() => <Composition id="box" component={Box} width={640} height={360} fps={30} durationInFrames={30} />);
