import { createContext } from 'react';

import type { Player } from '@/lib/player';

/**
 * What a plugin panel needs to draw on the preview picture (CONTRACT.md section 10): the element inside the frame that
 * overlays are laid in (null until the preview shows one), the composition's size in pixels, and the player for the frame.
 */
export interface PreviewHost {
  layer: HTMLElement | null;
  width: number;
  height: number;
  player: Player;
}

export const PreviewContext = createContext<PreviewHost | null>(null);

/** Which plugin panel's overlay is on show: the one being edited. `null` is the first panel. */
export const ActivePanelContext = createContext<{ active: string | null; setActive(key: string): void }>({ active: null, setActive: () => {} });
