import type { CodecConfig } from './types.js';

/** A video track the machine's decoder cannot be set up for. */
export class VideoUndecodableError extends Error {
  config: CodecConfig;

  constructor({ message, config }: { message: string; config: CodecConfig }) {
    super(message);
    this.name = 'VideoUndecodableError';
    this.config = config;
    Object.setPrototypeOf(this, VideoUndecodableError.prototype);
  }
}

/** An audio track the machine's decoder cannot be set up for. */
export class AudioUndecodableError extends Error {
  config: CodecConfig;

  constructor({ message, config }: { message: string; config: CodecConfig }) {
    super(message);
    this.name = 'AudioUndecodableError';
    this.config = config;
    Object.setPrototypeOf(this, AudioUndecodableError.prototype);
  }
}
