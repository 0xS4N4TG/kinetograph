import { useEffect, useRef } from 'react';

import type { Player } from '@/lib/player';

/** Where typing, a slider, tabs, a menu or a dialog already use the key. */
function ownsKeys(target: EventTarget | null): boolean {
  // A dialog is open: it owns the keyboard whatever has focus.
  if (document.querySelector('[role=dialog][data-open]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [role=slider], [role=tab], [role=menu], [role=dialog], [role=separator]') !== null
  );
}

/**
 * Space plays and pauses; Left and Right step a frame, ten with Shift; Home and End go to the first and last frame; L
 * toggles loop. Any other key is looked up in `shortcuts` by `event.key` (letters lowercased).
 */
export function useTransportKeys(player: Player, shortcuts: Record<string, () => void> = {}): void {
  const latest = useRef(shortcuts);
  useEffect(() => {
    latest.current = shortcuts;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || ownsKeys(event.target)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === ' ') {
        event.preventDefault();
        if (!event.repeat) player.toggle();
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        player.step(key === 'ArrowLeft' ? -step : step);
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault();
        const comp = player.getState().comp;
        if (comp) player.seek(key === 'Home' ? 0 : comp.durationInFrames - 1);
      } else if (key === 'l') {
        if (!event.repeat) player.setLoop(!player.getState().loop);
      } else {
        // A capital letter (Shift) is looked up as typed before the lowercase one: Shift+M is not M.
        (latest.current[event.key] ?? latest.current[key])?.();
      }
    };
    // A focused button would also click on the Space key's release.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ' && !ownsKeys(event.target)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [player]);
}
