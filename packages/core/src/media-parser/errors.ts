import type { MediaParserDimensions } from './types.js';

export type ImageType = 'png' | 'jpeg' | 'bmp' | 'webp' | 'gif';

/** What a file turned out to be when it is not media: the answer of `parseMedia` for an image. */
export class IsAnImageError extends Error {
  imageType: ImageType;
  dimensions: MediaParserDimensions | null;
  mimeType: string | null;
  sizeInBytes: number | null;
  fileName: string | null;

  constructor({
    dimensions,
    imageType,
    message,
    mimeType,
    sizeInBytes,
    fileName,
  }: {
    message: string;
    imageType: ImageType;
    dimensions: MediaParserDimensions | null;
    mimeType: string | null;
    sizeInBytes: number | null;
    fileName: string | null;
  }) {
    super(message);
    this.name = 'IsAnImageError';
    this.imageType = imageType;
    this.dimensions = dimensions;
    this.mimeType = mimeType;
    this.sizeInBytes = sizeInBytes;
    this.fileName = fileName;
    // Instances stay recognisable after being rethrown across a bundle boundary.
    Object.setPrototypeOf(this, IsAnImageError.prototype);
  }
}

export class IsAPdfError extends Error {
  mimeType: string | null;
  sizeInBytes: number | null;
  fileName: string | null;

  constructor({
    message,
    mimeType,
    sizeInBytes,
    fileName,
  }: {
    message: string;
    mimeType: string | null;
    sizeInBytes: number | null;
    fileName: string | null;
  }) {
    super(message);
    this.name = 'IsAPdfError';
    this.mimeType = mimeType;
    this.sizeInBytes = sizeInBytes;
    this.fileName = fileName;
    Object.setPrototypeOf(this, IsAPdfError.prototype);
  }
}

export class IsAnUnsupportedFileTypeError extends Error {
  mimeType: string | null;
  sizeInBytes: number | null;
  fileName: string | null;

  constructor({
    message,
    mimeType,
    sizeInBytes,
    fileName,
  }: {
    message: string;
    mimeType: string | null;
    sizeInBytes: number | null;
    fileName: string | null;
  }) {
    super(message);
    this.name = 'IsAnUnsupportedFileTypeError';
    this.mimeType = mimeType;
    this.sizeInBytes = sizeInBytes;
    this.fileName = fileName;
    Object.setPrototypeOf(this, IsAnUnsupportedFileTypeError.prototype);
  }
}

/** What a parse rejects with once its controller has been aborted. */
export class MediaParserAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaParserAbortError';
    Object.setPrototypeOf(this, MediaParserAbortError.prototype);
  }
}

export const hasBeenAborted = (error: unknown): error is MediaParserAbortError =>
  error instanceof MediaParserAbortError ||
  (error instanceof Error && error.name === 'MediaParserAbortError');
