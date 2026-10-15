// `@remotion/gif` (docs/AUTHORING.md §11.3): the native <Gif> element and
// `getGifDurationInSeconds`. Stream 2.

export { Gif } from '@kinetograph/react';
export type { GifProps } from '@kinetograph/react';

export function getGifDurationInSeconds(_src: string): Promise<number> {
  throw new Error('not implemented: getGifDurationInSeconds (docs/AUTHORING.md §11.3)');
}
