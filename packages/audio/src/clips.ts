import type { AudioClipJson } from '@kinetographdev/scene';

export interface AudioClipTimeline extends Omit<AudioClipJson, 'volume'> {
  /** frame → volume */
  volumes: Map<number, number>;
}

/**
 * Joins the per-frame `AudioClipJson`s of a render into one timeline per clip. A clip is the same `<Audio>` (or the
 * sound of the same `<Video>`) while its `id` and its fixed fields (`src`, `from`, trims, rate, `loop`, `video`, `toneFrequency`) stay
 * the same; if one of those changes, the clip from that frame on is a new timeline, since it no longer plays one continuous file. A frame the clip is muted in
 * (`muted`, or inside a `<Freeze>`) gets volume 0, and `muted` on the result is true only if every frame was muted.
 * A frame the clip is absent from has no entry, which the mix plays as silence.
 */
export function joinClips(frames: { frame: number; audio: AudioClipJson[] }[]): AudioClipTimeline[] {
  const ordered = [...frames].sort((a, b) => a.frame - b.frame);
  const timelines = new Map<string, AudioClipTimeline>();
  for (const { frame, audio } of ordered) {
    for (const clip of audio) {
      const key = JSON.stringify([
        clip.id,
        clip.src,
        clip.from,
        clip.trimBefore,
        clip.trimAfter,
        clip.playbackRate,
        clip.loop,
        clip.video === true,
        clip.toneFrequency ?? 1,
      ]);
      let timeline = timelines.get(key);
      if (!timeline) {
        timeline = {
          id: clip.id,
          src: clip.src,
          from: clip.from,
          trimBefore: clip.trimBefore,
          trimAfter: clip.trimAfter,
          playbackRate: clip.playbackRate,
          loop: clip.loop,
          ...(clip.video ? { video: true } : {}),
          ...(clip.toneFrequency !== undefined && clip.toneFrequency !== 1 ? { toneFrequency: clip.toneFrequency } : {}),
          muted: true,
          volumes: new Map(),
        };
        timelines.set(key, timeline);
      }
      if (!clip.muted) timeline.muted = false;
      timeline.volumes.set(frame, clip.muted ? 0 : clip.volume);
    }
  }
  return [...timelines.values()];
}
