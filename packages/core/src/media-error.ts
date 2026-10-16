// `MediaPlaybackError`: the error Remotion's media tags report to `onError` when the browser cannot play a source. It is
// exported so `instanceof` checks and `new MediaPlaybackError(...)` in a project bundle; nothing here plays media.

export class MediaPlaybackError extends Error {
  readonly src: string;

  constructor({ message, src }: { message: string; src: string }) {
    super(message);
    this.name = 'MediaPlaybackError';
    this.src = src;
  }
}
