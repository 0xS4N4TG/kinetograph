// The error an exported-but-unsupported API of a Remotion package throws. The packages that need a browser's media
// stack (`@remotion/webcodecs`, `@remotion/media-parser`'s readers, `@remotion/timeline-utils`' frame decoding,
// `@remotion/canvas`) export every name Remotion's does, so a project bundles; a call that needs what a render does
// not have fails with this, saying which call and why, rather than doing something else.

export class UnsupportedApiError extends Error {
  constructor(
    readonly pkg: string,
    readonly api: string,
    reason: string,
  ) {
    super(`${pkg}: ${api} is not supported by Kinetograph, ${reason}`);
    this.name = 'UnsupportedApiError';
  }
}
