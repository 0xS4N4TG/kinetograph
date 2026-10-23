// <Audio> and <Video> inside a <Sequence> with `trimBefore`, `playbackRate` or `loop` (Remotion: the Sequence changes the
// speed "of the children, including their animations and media"; rates of nested Sequences and the media multiply, and
// `trimBefore` is in frames of the children's clock). Each test renders a frame and reads the position in the file
// (frames of the composition's fps) that the emitted clip reaches there: `(frame - from) * playbackRate + trimBefore`.

import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Audio, Video } from '@kinetographdev/react';
import type { AudioClipJson } from '@kinetographdev/scene';
import { Sequence } from '../src/timeline.js';
import { renderAt } from './scene-harness.js';

type Clip = Omit<AudioClipJson, 'id'>;

function clipAt(node: ReactNode, frame: number): Clip | undefined {
  return renderAt(node, frame).audio[0];
}

/** Where in the file, in frames, the clip is at composition frame `frame`. */
function position(clip: Clip, frame: number): number {
  return (frame - clip.from) * clip.playbackRate + clip.trimBefore;
}

describe('<Audio> in a <Sequence>', () => {
  it('starts where the Sequence starts and plays at the Sequence rate', () => {
    const node = (
      <Sequence from={10} playbackRate={2}>
        <Audio id="a" src="a.wav" />
      </Sequence>
    );
    const clip = clipAt(node, 14)!;
    expect(clip).toMatchObject({ from: 10, playbackRate: 2, trimBefore: 0 });
    expect(position(clip, 14)).toBe(8);
  });

  it('multiplies nested Sequence rates and its own rate', () => {
    const node = (
      <Sequence playbackRate={2}>
        <Sequence from={4} playbackRate={0.5}>
          <Audio id="a" src="a.wav" playbackRate={3} />
        </Sequence>
      </Sequence>
    );
    // The outer clock runs at 2: the inner Sequence starts at composition frame 2. Rates: 2 * 0.5 * 3.
    const clip = clipAt(node, 6)!;
    expect(clip.from).toBe(2);
    expect(clip.playbackRate).toBe(3);
    expect(position(clip, 6)).toBe(12);
  });

  it('keeps a Sequence at half speed and one at double speed at the original speed', () => {
    const node = (
      <Sequence playbackRate={0.5}>
        <Sequence playbackRate={2}>
          <Audio id="a" src="a.wav" />
        </Sequence>
      </Sequence>
    );
    expect(clipAt(node, 7)!.playbackRate).toBe(1);
  });

  it('folds the Sequence trimBefore (frames of its children) into the start, next to the clip trimBefore', () => {
    const node = (
      <Sequence from={10} trimBefore={20}>
        <Audio id="a" src="a.wav" trimBefore={5} />
      </Sequence>
    );
    const clip = clipAt(node, 13)!;
    // The children's clock is 20 at composition frame 10; the audio's own frame 0 was 20 of them ago.
    expect(clip.from).toBe(-10);
    expect(clip.trimBefore).toBe(5);
    expect(position(clip, 10)).toBe(25);
    expect(position(clip, 13)).toBe(28);
  });

  it('scales a trim by the rate: the children skip trimBefore of their own frames', () => {
    const node = (
      <Sequence from={10} trimBefore={20} playbackRate={2}>
        <Audio id="a" src="a.wav" />
      </Sequence>
    );
    const clip = clipAt(node, 15)!;
    expect(clip.from).toBe(0);
    // Children's clock at 15: (15 - 10) * 2 + 20 = 30.
    expect(position(clip, 15)).toBe(30);
  });

  it('honours `from` of nested Sequences', () => {
    const node = (
      <Sequence from={10}>
        <Sequence from={5} playbackRate={2}>
          <Sequence from={4}>
            <Audio id="a" src="a.wav" />
          </Sequence>
        </Sequence>
      </Sequence>
    );
    // The middle clock starts at 15 and runs at 2; the innermost starts at its frame 4, composition frame 17.
    const clip = clipAt(node, 20)!;
    expect(clip).toMatchObject({ from: 17, playbackRate: 2 });
    expect(position(clip, 20)).toBe(6);
  });

  it('starts again with each iteration of a looping Sequence', () => {
    const node = (
      <Sequence durationInFrames={15} loop>
        <Audio id="a" src="a.wav" />
      </Sequence>
    );
    expect(clipAt(node, 14)!.from).toBe(0);
    const second = clipAt(node, 15)!;
    expect(second.from).toBe(15);
    expect(position(second, 15)).toBe(0);
    expect(position(clipAt(node, 40)!, 40)).toBe(10);
  });

  it('loops at the Sequence rate: an iteration lasts durationInFrames / playbackRate', () => {
    const node = (
      <Sequence from={5} durationInFrames={20} playbackRate={2} loop>
        <Audio id="a" src="a.wav" />
      </Sequence>
    );
    // Period 10: iterations start at 5, 15, 25.
    expect(clipAt(node, 14)!.from).toBe(5);
    const third = clipAt(node, 27)!;
    expect(third).toMatchObject({ from: 25, playbackRate: 2 });
    expect(position(third, 27)).toBe(4);
  });

  it('restarts at the trim in each iteration', () => {
    const node = (
      <Sequence durationInFrames={10} trimBefore={6} loop>
        <Audio id="a" src="a.wav" />
      </Sequence>
    );
    const clip = clipAt(node, 12)!;
    expect(clip.from).toBe(4);
    expect(position(clip, 10)).toBe(-6 + 6 + 6);
    expect(position(clip, 12)).toBe(8);
  });

  it('is unchanged outside a Sequence with a rate', () => {
    expect(clipAt(<Audio id="a" src="a.wav" playbackRate={1.5} />, 3)).toMatchObject({ from: 0, playbackRate: 1.5 });
    expect(clipAt(<Sequence from={7}><Audio id="a" src="a.wav" /></Sequence>, 9)).toMatchObject({ from: 7, playbackRate: 1 });
  });

  it('is not scaled by a Sequence rate inside a Freeze, where its frame is pinned', () => {
    const tree = renderAt(<Video id="v" src="v.mp4" />, 5, { frozen: true, rate: 2, absoluteFrame: 8 });
    expect(tree.audio[0]).toMatchObject({ from: 3, playbackRate: 1, muted: true });
  });
});

describe('<Video> in a <Sequence>', () => {
  it('takes the Sequence rate on the layer and on its sound', () => {
    const node = (
      <Sequence from={10} playbackRate={2}>
        <Video id="v" src="v.mp4" playbackRate={1.5} />
      </Sequence>
    );
    const tree = renderAt(node, 14);
    const layer = (tree.layers[0] as { children: { from: number; playbackRate: number }[] }).children[0]!;
    expect(layer).toMatchObject({ from: 10, playbackRate: 3 });
    expect(tree.audio[0]).toMatchObject({ from: 10, playbackRate: 3, video: true });
  });

  it('folds the Sequence trimBefore into the start and keeps its own', () => {
    const node = (
      <Sequence from={10} trimBefore={20} playbackRate={2}>
        <Video id="v" src="v.mp4" trimBefore={4} />
      </Sequence>
    );
    const tree = renderAt(node, 16);
    const sound = tree.audio[0]!;
    expect(sound).toMatchObject({ from: 0, playbackRate: 2, trimBefore: 4 });
    // Children's clock at 16 is 32.
    expect(position(sound, 16)).toBe(36);
  });

  it('puts its own `from` in the children clock', () => {
    const node = (
      <Sequence from={10} playbackRate={2}>
        <Video id="v" src="v.mp4" from={6} />
      </Sequence>
    );
    expect(renderAt(node, 12).audio).toEqual([]);
    expect(renderAt(node, 13).audio[0]).toMatchObject({ from: 13, playbackRate: 2 });
  });

  it('restarts with each iteration of a looping Sequence', () => {
    const node = (
      <Sequence durationInFrames={12} loop>
        <Video id="v" src="v.mp4" />
      </Sequence>
    );
    expect(renderAt(node, 11).audio[0]!.from).toBe(0);
    expect(renderAt(node, 12).audio[0]!.from).toBe(12);
    expect(renderAt(node, 30).audio[0]!.from).toBe(24);
  });
});
