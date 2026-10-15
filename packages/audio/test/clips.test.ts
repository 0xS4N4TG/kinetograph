import { describe, expect, it } from 'vitest';
import type { AudioClipJson } from '@kinetograph/scene';
import { joinClips } from '../src/index.js';

const clip = (over: Partial<AudioClipJson> = {}): AudioClipJson => ({
  id: 'a',
  src: '/x/a.wav',
  from: 0,
  trimBefore: 0,
  trimAfter: null,
  playbackRate: 1,
  volume: 1,
  loop: false,
  muted: false,
  ...over,
});

describe('joinClips', () => {
  it('joins the frames a clip plays in into one timeline with a volume per frame', () => {
    const joined = joinClips([
      { frame: 2, audio: [clip({ volume: 0.5 })] },
      { frame: 0, audio: [clip({ volume: 0 })] },
      { frame: 1, audio: [clip({ volume: 0.25 })] },
    ]);
    expect(joined).toHaveLength(1);
    expect([...joined[0]!.volumes]).toEqual([
      [0, 0],
      [1, 0.25],
      [2, 0.5],
    ]);
    expect(joined[0]).not.toHaveProperty('volume');
    expect(joined[0]!.muted).toBe(false);
  });

  it('keeps clips with different ids apart, in order of first appearance', () => {
    const joined = joinClips([
      { frame: 0, audio: [clip({ id: 'b' }), clip({ id: 'a' })] },
      { frame: 1, audio: [clip({ id: 'a' }), clip({ id: 'b' })] },
    ]);
    expect(joined.map((j) => j.id)).toEqual(['b', 'a']);
    expect(joined[0]!.volumes.size).toBe(2);
  });

  it('starts a new timeline when a fixed field changes', () => {
    const joined = joinClips([
      { frame: 0, audio: [clip({ playbackRate: 1 })] },
      { frame: 1, audio: [clip({ playbackRate: 2 })] },
    ]);
    expect(joined).toHaveLength(2);
    expect(joined.map((j) => j.playbackRate)).toEqual([1, 2]);
  });

  it('keeps toneFrequency on the timeline, and a change of it starts a new one', () => {
    const joined = joinClips([
      { frame: 0, audio: [clip({ toneFrequency: 1.5 })] },
      { frame: 1, audio: [clip({ toneFrequency: 1.5 })] },
      { frame: 2, audio: [clip()] },
    ]);
    expect(joined.map((j) => j.toneFrequency)).toEqual([1.5, undefined]);
  });

  it('plays muted frames as volume 0 and is muted only if every frame is', () => {
    const some = joinClips([
      { frame: 0, audio: [clip({ muted: true, volume: 1 })] },
      { frame: 1, audio: [clip({ volume: 0.8 })] },
    ]);
    expect(some[0]!.muted).toBe(false);
    expect(some[0]!.volumes.get(0)).toBe(0);
    expect(some[0]!.volumes.get(1)).toBe(0.8);
    const all = joinClips([{ frame: 0, audio: [clip({ muted: true })] }]);
    expect(all[0]!.muted).toBe(true);
  });

  it('leaves out the frames a clip is absent from', () => {
    const joined = joinClips([
      { frame: 0, audio: [clip()] },
      { frame: 1, audio: [] },
      { frame: 2, audio: [clip()] },
    ]);
    expect([...joined[0]!.volumes.keys()]).toEqual([0, 2]);
  });
});
