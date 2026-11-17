// How a source plays a frame it does not draw. A worker that starts a chunk at frame N has to bring a page whose scripts
// count frames or start tweens as the timeline passes (GSAP) through frames 1 to N-1, and none of those is drawn.
// Rendering the composition for each does what only a drawn frame needs (React's render, the sounds, the picture's
// attributes); a source that knows what its scripts can see of a frame hands that alone here, and the frame loop plays
// the skipped frames through it. A composition that has none is played by rendering it.

/** Plays `frame` of a composition of `fps` and `durationInFrames`, drawing nothing. */
export type FrameReplay = (frame: number, fps: number, durationInFrames: number) => void;

let replay: FrameReplay | null = null;

/** Sets how skipped frames are played (the HyperFrames runtime does, when a project defines its composition); null: by rendering. */
export function setFrameReplay(play: FrameReplay | null): void {
  replay = play;
}

export function frameReplay(): FrameReplay | null {
  return replay;
}
