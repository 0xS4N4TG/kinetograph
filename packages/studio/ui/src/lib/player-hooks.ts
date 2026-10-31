import { useSyncExternalStore } from 'react';

import type { Player, PlayerState } from '@/lib/player';

/**
 * One value of the player's state. The component re-renders only when `select` returns something different, so a view
 * that needs the frame does not make a view that needs only `playing` render with it. `select` must return a primitive
 * (or a value that is stable between changes).
 */
export function usePlayerState<T>(player: Player, select: (state: PlayerState) => T): T {
  return useSyncExternalStore(player.subscribe, () => select(player.getState()));
}

export const useFrame = (player: Player): number => usePlayerState(player, (s) => s.frame);
