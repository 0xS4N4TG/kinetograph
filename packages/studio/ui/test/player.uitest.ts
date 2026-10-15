import { describe, expect, it } from 'vitest';

import type { FrameArgs, ReceivedFrame } from '../src/api';
import { Player } from '../src/lib/player';
import { intro, outro } from './fixtures';

function setup() {
  let t = 0;
  let nextId = 1;
  const sent: (FrameArgs & { id: number })[] = [];
  const shown: number[] = [];
  let queue: (() => void)[] = [];
  const player = new Player({
    requestFrame: (args) => {
      sent.push({ ...args, id: nextId });
      return nextId++;
    },
    onImage: (frame) => shown.push(frame.header.requestId),
    now: () => t,
    schedule: (cb) => queue.push(cb),
    cancelSchedule: () => {
      queue = [];
    },
  });
  const reply = (id: number): void => {
    const frame: ReceivedFrame = {
      header: { type: 'frame', requestId: id, comp: 'Intro', frame: 0, buildId: 1, width: 1, height: 1, mime: 'image/png', ms: 1 },
      image: new Uint8Array(1),
    };
    player.handleFrame(frame);
  };
  /** Moves the clock and runs the animation frame callbacks scheduled so far. */
  const advance = (ms: number): void => {
    t += ms;
    const callbacks = queue;
    queue = [];
    for (const cb of callbacks) cb();
  };
  return { player, sent, shown, reply, advance, last: () => sent[sent.length - 1]! };
}

describe('Player quality', () => {
  it('asks for scale 1 PNG when paused', () => {
    const { player, last } = setup();
    player.setComposition(intro);
    expect(last()).toMatchObject({ comp: 'Intro', frame: 0, scale: 1, format: 'png' });
    player.seek(40);
    expect(last()).toMatchObject({ frame: 40, scale: 1, format: 'png' });
    player.step(10);
    expect(last()).toMatchObject({ frame: 50, scale: 1, format: 'png' });
  });

  it('asks for scale 0.5 JPEG while scrubbing, and for PNG again when the scrub ends', () => {
    const { player, last, sent } = setup();
    player.setComposition(intro);
    player.beginScrub();
    player.seek(20);
    player.seek(30);
    expect(last()).toMatchObject({ frame: 30, scale: 0.5, format: 'jpeg' });
    player.endScrub();
    expect(last()).toMatchObject({ frame: 30, scale: 1, format: 'png' });
    expect(sent.map((s) => s.frame)).toEqual([0, 20, 30, 30]);
  });

  it('asks for scale 0.5 JPEG while playing and full quality once paused', () => {
    const { player, last, reply } = setup();
    player.setComposition(intro);
    reply(1);
    player.play();
    expect(last()).toMatchObject({ scale: 0.5, format: 'jpeg' });
    player.pause();
    expect(last()).toMatchObject({ scale: 1, format: 'png' });
  });

  it('sends the props override with every request, and asks again when it changes', () => {
    const { player, sent } = setup();
    player.setComposition(intro, { title: 'Hi' });
    expect(sent[0]!.props).toEqual({ title: 'Hi' });
    player.setComposition(intro, { title: 'Hi' });
    expect(sent).toHaveLength(1);
    player.setComposition(intro, { title: 'Bye' });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.props).toEqual({ title: 'Bye' });
    player.setComposition(intro, undefined);
    expect(sent[2]!.props).toBeUndefined();
  });
});

describe('Player latest frame wins', () => {
  it('never shows a frame older than the last one shown', () => {
    const { player, shown, reply } = setup();
    player.setComposition(intro);
    player.seek(1);
    player.seek(2);
    reply(3);
    reply(2);
    reply(1);
    expect(shown).toEqual([3]);
  });

  it('shows frames that arrive in order, and skips an older one that arrives late', () => {
    const { player, shown, reply } = setup();
    player.setComposition(intro);
    player.seek(1);
    player.seek(2);
    reply(1);
    reply(3);
    reply(2);
    expect(shown).toEqual([1, 3]);
  });

  it('drops replies to requests made before the composition, props or build changed', () => {
    const { player, shown, reply, last } = setup();
    player.setComposition(intro);
    player.setComposition(outro);
    reply(1);
    expect(shown).toEqual([]);
    reply(2);
    expect(shown).toEqual([2]);

    player.setComposition(outro, { a: 1 });
    reply(2);
    player.reload();
    expect(last().id).toBe(4);
    reply(3);
    expect(shown).toEqual([2]);
    reply(4);
    expect(shown).toEqual([2, 4]);
  });

  it('asks again when the socket reopens', () => {
    const { player, sent } = setup();
    player.setComposition(intro);
    player.handleConnection(false);
    expect(sent).toHaveLength(1);
    player.handleConnection(true);
    expect(sent).toHaveLength(2);
  });
});

describe('Player playback', () => {
  it('paces at the composition fps and skips frames the server cannot keep up with', () => {
    const { player, sent, reply, advance } = setup();
    player.setComposition(intro); // 30 fps
    reply(1);
    player.play();
    expect(sent.map((s) => s.frame)).toEqual([0, 0]);

    advance(100); // three frames pass while request 2 is out
    expect(player.getState().frame).toBe(3);
    expect(sent).toHaveLength(2);

    reply(2); // the reply frees the line: ask for where the clock is now, not for 1 and 2
    expect(sent.map((s) => s.frame)).toEqual([0, 0, 3]);

    advance(100);
    expect(player.getState().frame).toBe(6);
    expect(sent).toHaveLength(3);
    reply(3);
    expect(sent.map((s) => s.frame)).toEqual([0, 0, 3, 6]);
  });

  it('does not ask again for a frame it already asked for when the server is faster than the clock', () => {
    const { player, sent, reply, advance } = setup();
    player.setComposition(intro);
    reply(1);
    player.play();
    reply(2);
    expect(sent).toHaveLength(2);
    advance(10);
    expect(sent).toHaveLength(2);
    advance(30);
    expect(sent.map((s) => s.frame)).toEqual([0, 0, 1]);
  });

  it('stops on the last frame at the end, and shows it at full quality', () => {
    const { player, last, reply, advance } = setup();
    player.setComposition(outro); // 24 fps, 48 frames
    reply(1);
    player.seek(40);
    reply(2);
    player.play();
    reply(3);
    advance(500);
    expect(player.getState()).toMatchObject({ playing: false, frame: 47 });
    expect(last()).toMatchObject({ frame: 47, scale: 1, format: 'png' });
  });

  it('wraps to the start when looping', () => {
    const { player, reply, advance } = setup();
    player.setComposition(outro);
    reply(1);
    player.setLoop(true);
    player.seek(40);
    reply(2);
    player.play();
    reply(3);
    advance(500); // 12 frames: 52 wraps to 4
    expect(player.getState()).toMatchObject({ playing: true, frame: 4 });
  });

  it('starts over from frame 0 when played at the end', () => {
    const { player, reply } = setup();
    player.setComposition(outro);
    reply(1);
    player.seek(47);
    reply(2);
    player.play();
    expect(player.getState().frame).toBe(0);
  });

  it('measures the fps it shows', () => {
    const { player, reply, advance } = setup();
    player.setComposition(intro);
    reply(1);
    player.play();
    let id = 2;
    for (let i = 0; i < 30; i++) {
      advance(50);
      reply(id++);
    }
    expect(player.getState().fps).toBeGreaterThan(18);
    expect(player.getState().fps).toBeLessThan(22);
  });

  it('keeps the frame in range', () => {
    const { player } = setup();
    player.setComposition(outro);
    player.seek(-5);
    expect(player.getState().frame).toBe(0);
    player.seek(1000);
    expect(player.getState().frame).toBe(47);
    player.step(1);
    expect(player.getState().frame).toBe(47);
  });
});
