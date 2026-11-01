/** Where a picture of a composition comes from: the studio's frame route, at a fraction of the composition's size. */
export const frameSrc = (comp: string, frame: number, scale: number): string => `/api/frame?comp=${encodeURIComponent(comp)}&frame=${frame}&scale=${scale}&format=jpeg`;

/** A storyboard card is about 16rem wide (256 px, 144 px tall at 16:9); stills are drawn for twice that, for retina screens. */
const CARD_BOX = { width: 512, height: 288 };

/** The scale (above 0, at most 1) that fits a composition of this size in a storyboard card, or a fixed small one when it is not known. */
export function cardScale(size: { width: number; height: number } | undefined, box = CARD_BOX): number {
  if (!size || size.width <= 0 || size.height <= 0) return 0.25;
  const fit = Math.min(1, box.width / size.width, box.height / size.height);
  return Math.max(0.001, Math.round(fit * 1000) / 1000);
}
