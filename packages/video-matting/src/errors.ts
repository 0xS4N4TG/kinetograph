/**
 * What the package throws (apart from an `AbortSignal`'s reason). `code` is one of: `UNKNOWN_MODEL`, `INVALID_ARG`,
 * `MODEL_NOT_DOWNLOADED`, `MODEL_DOWNLOAD` (the network or Hugging Face failed), `MODEL_CHECKSUM` (a download did not
 * match its pinned SHA-256), `MATTING_UNAVAILABLE` (this build of the addon has no matting, or no backend), `IO`.
 */
export class VideoMattingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoMattingError';
  }
}
