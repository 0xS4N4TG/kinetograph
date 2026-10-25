import { describe, expect, it } from 'vitest';
import { blur } from '@kinetographdev/scene';
import { Gif, Layer, OffthreadVideo, Video, type VideoProps } from '../src/index.js';
import { renderAt, timeline } from './harness.js';

// What a frame of a Sequence starting at 30 looks like to a component 4 frames in.
const inSequence = (frame = 4, from = 30) => timeline(0, { frame, absoluteFrame: from + frame });

describe('<Video>', () => {
  it('becomes a video layer carrying its place on the timeline', () => {
    const tree = renderAt(<Video id="clip" src="/abs/city.mp4" />, 10);
    expect(tree.layers).toEqual([{ id: 'clip', type: 'video', src: '/abs/city.mp4', from: 0 }]);
  });

  it('is the same component as <OffthreadVideo>', () => {
    expect(OffthreadVideo).toBe(Video);
  });

  it('gets an automatic id like any layer', () => {
    const tree = renderAt(
      <Layer>
        <Video src="a.mp4" />
      </Layer>,
    );
    expect((tree.layers[0] as { children: { id: string }[] }).children[0]!.id).toBe('$0.0');
    expect(tree.audio[0]!.id).toBe('$0.0');
  });

  it('puts `from` at the frame of its Sequence, the way <Audio> does', () => {
    expect(renderAt(<Video id="v" src="a.mp4" />, inSequence()).layers[0]).toMatchObject({ from: 30 });
    expect(renderAt(<Video id="v" src="a.mp4" />, inSequence(0, 12)).layers[0]).toMatchObject({ from: 12 });
  });

  it('keeps `from` exact on a motion-blur sub-frame', () => {
    const state = timeline(0, { frame: 4.375, absoluteFrame: 34.375 });
    const from = (renderAt(<Video id="v" src="a.mp4" />, state).layers[0] as { from: number }).from;
    expect(from).toBe(30);
    // The same sub-frame time with floating point noise in both numbers.
    const noisy = timeline(0, { frame: 0.1 + 0.2, absoluteFrame: 10 + 0.1 + 0.2 });
    expect((renderAt(<Video id="v" src="a.mp4" />, noisy).layers[0] as { from: number }).from).toBe(10);
  });

  it('starts at its own `from`, within the Sequence, and shows nothing before it', () => {
    expect(renderAt(<Video id="v" src="a.mp4" from={10} />, 14).layers[0]).toMatchObject({ from: 10 });
    expect(renderAt(<Video id="v" src="a.mp4" from={10} />, inSequence(14)).layers[0]).toMatchObject({ from: 40 });
    const before = renderAt(<Video id="v" src="a.mp4" from={10} />, 9);
    expect(before.layers).toEqual([]);
    expect(before.audio).toEqual([]);
    expect(renderAt(<Video id="v" src="a.mp4" from={10} />, 10).audio[0]).toMatchObject({ from: 10, video: true });
  });

  it('has no `frame` outside a <Freeze>', () => {
    expect(renderAt(<Video id="v" src="a.mp4" />, inSequence()).layers[0]).not.toHaveProperty('frame');
  });

  it('holds the frozen picture inside a <Freeze>: `frame` is the composition frame, `from` makes that the frozen one', () => {
    // Freeze frame={5} in a Sequence: the component sees frame 5, the composition is at 40.
    const frozen = timeline(0, { frame: 5, absoluteFrame: 40, frozen: true });
    const layer = renderAt(<Video id="v" src="a.mp4" />, frozen).layers[0] as { from: number; frame: number };
    expect(layer).toMatchObject({ frame: 40, from: 35 });
    // The clip's own frame, frame - from, is the frozen 5 on this and every later frame.
    const later = timeline(0, { frame: 5, absoluteFrame: 52, frozen: true });
    const next = renderAt(<Video id="v" src="a.mp4" />, later).layers[0] as { from: number; frame: number };
    expect(next.frame - next.from).toBe(5);
    expect(layer.frame - layer.from).toBe(5);
  });

  describe('trims, rate and loop', () => {
    it('are passed through', () => {
      const layer = renderAt(<Video id="v" src="a.mp4" trimBefore={15} trimAfter={90} playbackRate={1.5} loop />).layers[0];
      expect(layer).toEqual({ id: 'v', type: 'video', src: 'a.mp4', from: 0, trimBefore: 15, trimAfter: 90, playbackRate: 1.5, loop: true });
    });

    it('take the older names, trimBefore and trimAfter first', () => {
      expect(renderAt(<Video id="v" src="a.mp4" startFrom={10} endAt={50} />).layers[0]).toMatchObject({ trimBefore: 10, trimAfter: 50 });
      expect(renderAt(<Video id="v" src="a.mp4" trimBefore={1} startFrom={10} />).layers[0]).toMatchObject({ trimBefore: 1 });
    });

    it('are left out when not given, so the scene defaults apply', () => {
      const layer = renderAt(<Video id="v" src="a.mp4" />).layers[0]!;
      for (const key of ['trimBefore', 'trimAfter', 'playbackRate', 'loop', 'width', 'height', 'fit']) {
        expect(layer).not.toHaveProperty(key);
      }
    });

    it('are checked, naming the file', () => {
      expect(() => renderAt(<Video id="v" src="a.mp4" playbackRate={0} />)).toThrow(/<Video src="a.mp4"> playbackRate must be above 0/);
      expect(() => renderAt(<Video id="v" src="a.mp4" trimBefore={-1} />)).toThrow(/trimBefore must not be negative/);
      expect(() => renderAt(<Video id="v" src="a.mp4" trimBefore={20} trimAfter={20} />)).toThrow(/trimAfter \(20\) must be greater than trimBefore \(20\)/);
      expect(() => renderAt(<Video id="v" {...({} as VideoProps)} />)).toThrow(/needs a src/);
    });
  });

  describe('box and fit', () => {
    it('map `style` as <Img> does', () => {
      const layer = renderAt(<Video id="v" src="a.mp4" style={{ width: 1080, height: '608px', objectFit: 'cover' }} />).layers[0];
      expect(layer).toMatchObject({ width: 1080, height: 608, fit: 'cover' });
    });

    it('take the props when there is no style, and the style over the props', () => {
      expect(renderAt(<Video id="v" src="a.mp4" width={320} height={180} fit="contain" />).layers[0]).toMatchObject({
        width: 320, height: 180, fit: 'contain',
      });
      expect(renderAt(<Video id="v" src="a.mp4" width={320} fit="contain" style={{ width: 640, objectFit: 'fill' }} />).layers[0]).toMatchObject({
        width: 640, fit: 'fill',
      });
    });

    it('read scale-down as contain, and leave a style the layer cannot take to the DOM engine (dom.test.tsx)', () => {
      expect(renderAt(<Video id="v" src="a.mp4" style={{ objectFit: 'scale-down' }} />).layers[0]).toMatchObject({ fit: 'contain' });
      // A percentage, `none`, position or filter is CSS: the video is a `<video>` of the DOM engine, which needs the composition's box.
      for (const style of [{ width: '100%' }, { objectFit: 'none' }, { position: 'absolute' }, { filter: 'blur(2px)' }]) {
        expect(() => renderAt(<Video id="v" src="a.mp4" style={style} />)).toThrow(/<video> is a DOM element/);
      }
    });
  });

  it('takes the common props of every layer', () => {
    const layer = renderAt(
      <Video id="v" src="a.mp4" x={10} y={20} scale={0.5} origin="center" opacity={0.8} blendMode="screen" effects={[blur(4)]} motionBlur={{ samples: 4, shutter: 0.5 }} />,
    ).layers[0];
    expect(layer).toEqual({
      id: 'v',
      type: 'video',
      src: 'a.mp4',
      from: 0,
      transform: { x: 10, y: 20, scale: 0.5, originX: 0.5, originY: 0.5 },
      opacity: 0.8,
      blendMode: 'screen',
      effects: [{ type: 'blur', radius: 4 }],
      motionBlur: { samples: 4, shutter: 0.5 },
    });
  });

  it('keeps a clip path on the layer (the sound is a separate clip)', () => {
    const tree = renderAt(<Video id="v" src="a.mp4" clip={{ kind: 'inset', radius: 24 }} />);
    expect(tree.layers[0]).toMatchObject({ clip: { kind: 'inset', radius: 24 } });
    expect(tree.audio[0]).not.toHaveProperty('kind');
    expect(tree.audio[0]).toMatchObject({ id: 'v', video: true });
  });

  it('accepts and ignores the props that only mean something in a browser', () => {
    const layer = renderAt(
      <Video
        id="v" src="a.mp4" transparent toneMapped={false} pauseWhenBuffering acceptableTimeShiftInSeconds={0.5}
        onError={() => {}} showInTimeline={false} name="Clip" delayRenderTimeoutInMilliseconds={5000}
      />,
    ).layers[0];
    expect(layer).toEqual({ id: 'v', type: 'video', src: 'a.mp4', from: 0 });
  });

});

describe('<Video datamosh>', () => {
  it('puts the window on the composition timeline, like `from`', () => {
    const mosh = { from: 10, to: 40, mix: 0.25 };
    expect(renderAt(<Video id="v" src="a.mp4" datamosh={mosh} />, 12).layers[0]).toMatchObject({
      datamosh: { from: 10, to: 40, mix: 0.25 },
    });
    // In a Sequence at 30 the window is 30 frames later.
    expect(renderAt(<Video id="v" src="a.mp4" datamosh={mosh} />, inSequence()).layers[0]).toMatchObject({
      datamosh: { from: 40, to: 70, mix: 0.25 },
    });
    expect(renderAt(<Video id="v" src="a.mp4" />, 12).layers[0]).not.toHaveProperty('datamosh');
  });

  it('carries the hold clip', () => {
    const hold = { src: 'b.mp4', frame: 20 };
    const layer = renderAt(<Video id="v" src="a.mp4" datamosh={{ from: 0, to: 5, hold }} />, 1).layers[0];
    expect(layer).toMatchObject({ datamosh: { from: 0, to: 5, hold } });
    const previous = renderAt(<Video id="v" src="a.mp4" datamosh={{ from: 0, to: 5, hold: 'previous' }} />, 1).layers[0];
    expect(previous).toMatchObject({ datamosh: { hold: 'previous' } });
  });

  it('checks the window, the mix and the hold', () => {
    const at = (datamosh: object) => () => renderAt(<Video id="v" src="a.mp4" datamosh={datamosh as never} />, 1);
    expect(at({ from: 5, to: 5 })).toThrow(/to above from/);
    expect(at({ from: 0, to: 601 })).toThrow(/at most 600/);
    expect(at({ from: 0, to: 5, mix: 2 })).toThrow(/mix must be 0 to 1/);
    expect(at({ from: 0, to: 5, hold: 'next' })).toThrow(/hold is 'previous'/);
    expect(at({ from: 0, to: 5, hold: { src: 'b.mp4', frame: -1 } })).toThrow(/hold/);
  });

  it('needs a plain video, not one with CSS', () => {
    const css = () =>
      renderAt(<Video id="v" src="a.mp4" style={{ borderRadius: 8 }} datamosh={{ from: 0, to: 5 }} />, 1);
    expect(css).toThrow(/plain video/);
  });
});

describe('the sound of <Video>', () => {
  it('is an AudioClipJson with video: true and the layer id, not a layer', () => {
    const tree = renderAt(<Video id="v" src="/abs/city.mp4" />, inSequence());
    expect(tree.layers).toHaveLength(1);
    expect(tree.audio).toEqual([
      {
        id: 'v', src: '/abs/city.mp4', from: 30, trimBefore: 0, trimAfter: null,
        playbackRate: 1, volume: 1, loop: false, muted: false, video: true,
      },
    ]);
  });

  it('carries toneFrequency when it is not 1, and checks its range', () => {
    expect(renderAt(<Video id="v" src="a.mp4" toneFrequency={1.5} />).audio[0]).toMatchObject({ toneFrequency: 1.5 });
    expect(renderAt(<Video id="v" src="a.mp4" toneFrequency={1} />).audio[0]).not.toHaveProperty('toneFrequency');
    expect(() => renderAt(<Video id="v" src="a.mp4" toneFrequency={2.5} />)).toThrow(/toneFrequency must be between 0.01 and 2/);
  });

  it('carries the trims, rate and loop of the layer', () => {
    const clip = renderAt(<Video id="v" src="a.mp4" startFrom={10} endAt={50} playbackRate={2} loop />).audio[0];
    expect(clip).toMatchObject({ trimBefore: 10, trimAfter: 50, playbackRate: 2, loop: true });
  });

  it('honours a volume number, and a function of the frame within the Sequence', () => {
    expect(renderAt(<Video id="v" src="a.mp4" volume={0.25} />).audio[0]).toMatchObject({ volume: 0.25 });
    const volume = (frame: number) => (frame < 5 ? frame / 10 : 1);
    // 4 frames into a Sequence at 30: the function sees 4, not 34.
    expect(renderAt(<Video id="v" src="a.mp4" volume={volume} />, inSequence(4)).audio[0]).toMatchObject({ volume: 0.4 });
    expect(renderAt(<Video id="v" src="a.mp4" volume={volume} />, inSequence(9)).audio[0]).toMatchObject({ volume: 1 });
  });

  it('is muted by `muted` and inside a <Freeze>, and not otherwise', () => {
    expect(renderAt(<Video id="v" src="a.mp4" muted />).audio[0]).toMatchObject({ muted: true });
    expect(renderAt(<Video id="v" src="a.mp4" />, timeline(3, { frozen: true })).audio[0]).toMatchObject({ muted: true, volume: 1 });
    expect(renderAt(<Video id="v" src="a.mp4" muted={false} />).audio[0]).toMatchObject({ muted: false });
  });

  it('is there even when muted, for the mix to decide', () => {
    expect(renderAt(<Video id="v" src="a.mp4" muted />).audio).toHaveLength(1);
  });

  it('rejects a volume that is not a finite number', () => {
    expect(() => renderAt(<Video id="v" src="a.mp4" volume={() => NaN} />)).toThrow(/volume must be a finite number/);
  });
});

describe('<Gif>', () => {
  it('becomes a gif layer whose time is the frame in seconds', () => {
    expect(renderAt(<Gif id="g" src="spin.gif" />, 0).layers).toEqual([{ id: 'g', type: 'gif', src: 'spin.gif', time: 0, loop: true }]);
    expect(renderAt(<Gif id="g" src="spin.gif" />, 45).layers[0]).toMatchObject({ time: 1.5 });
  });

  it('multiplies the time by playbackRate', () => {
    expect(renderAt(<Gif id="g" src="spin.gif" playbackRate={2} />, 45).layers[0]).toMatchObject({ time: 3 });
    expect(renderAt(<Gif id="g" src="spin.gif" playbackRate={0.5} />, 45).layers[0]).toMatchObject({ time: 0.75 });
  });

  it('reads the frame within its Sequence, fractional on a sub-frame', () => {
    expect(renderAt(<Gif id="g" src="spin.gif" />, inSequence(15)).layers[0]).toMatchObject({ time: 0.5 });
    expect(renderAt(<Gif id="g" src="spin.gif" />, timeline(0, { frame: 4.5, absoluteFrame: 34.5 })).layers[0]).toMatchObject({ time: 0.15 });
  });

  it('loops with loopBehavior loop (the default) and holds the last picture otherwise', () => {
    expect(renderAt(<Gif id="g" src="a.gif" loopBehavior="loop" />).layers[0]).toMatchObject({ loop: true });
    expect(renderAt(<Gif id="g" src="a.gif" loopBehavior="pause-after-finish" />).layers[0]).toMatchObject({ loop: false });
  });

  describe('unmount-after-finish', () => {
    it('holds the last picture on the layer and disappears once the duration has passed', () => {
      const gif = <Gif id="g" src="a.gif" loopBehavior="unmount-after-finish" durationInSeconds={1} />;
      expect(renderAt(gif, 29).layers[0]).toMatchObject({ type: 'gif', loop: false });
      // 30 frames at 30 fps is exactly the duration: past the end.
      expect(renderAt(gif, 30).layers).toEqual([]);
      expect(renderAt(gif, 80).layers).toEqual([]);
    });

    it('counts the duration in the GIF\'s own time, so playbackRate shortens it', () => {
      const gif = <Gif id="g" src="a.gif" loopBehavior="unmount-after-finish" durationInSeconds={2} playbackRate={2} />;
      expect(renderAt(gif, 29).layers).toHaveLength(1);
      expect(renderAt(gif, 30).layers).toEqual([]);
    });

    it('needs the duration, which @kinetographdev/core/gif supplies', () => {
      expect(() => renderAt(<Gif id="g" src="a.gif" loopBehavior="unmount-after-finish" />)).toThrow(/needs the GIF's duration/);
    });
  });

  it('maps style and the common props', () => {
    const layer = renderAt(<Gif id="g" src="a.gif" style={{ width: 120, height: 120, objectFit: 'contain' }} x={5} opacity={0.5} />, 3).layers[0];
    expect(layer).toEqual({
      id: 'g', type: 'gif', src: 'a.gif', width: 120, height: 120, fit: 'contain', time: 0.1, loop: true,
      transform: { x: 5 }, opacity: 0.5,
    });
  });

  it('is not an audio clip', () => {
    expect(renderAt(<Gif id="g" src="a.gif" />).audio).toEqual([]);
  });

  it('accepts onLoad and onError and checks the rest', () => {
    expect(renderAt(<Gif id="g" src="a.gif" onLoad={() => {}} onError={() => {}} />).layers).toHaveLength(1);
    expect(() => renderAt(<Gif id="g" src="a.gif" playbackRate={-1} />)).toThrow(/playbackRate must be above 0/);
    expect(() => renderAt(<Gif id="g" src="a.gif" loopBehavior={'spin' as 'loop'} />)).toThrow(/loopBehavior must be/);
  });
});
