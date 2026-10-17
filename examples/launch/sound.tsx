// The soundtrack: the voiceover as <Audio>, and the music and sound design synthesised in sound-cues.ts through
// onFrame (deterministic: noise from random(seed)). The voiceover files come from tools/narration (the Tiny Agent narrator).

import React from 'react';
import { Audio, Sequence, staticFile } from 'remotion';
import { START, VO } from './sound-timing.js';
import './sound-cues.js';

export const Soundtrack: React.FC = () => (
  <>
    {VO.map((v) => (
      <Sequence key={v.file} from={START[v.shot] + v.at}>
        <Audio src={staticFile(`vo/${v.file}.wav`)} volume={0.85} />
      </Sequence>
    ))}
  </>
);
