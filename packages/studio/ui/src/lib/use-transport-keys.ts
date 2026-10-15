import { useEffect } from 'react';

import type { Player } from '@/lib/player';

/** Where typing, a slider, tabs or a dialog already use the key. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [role=slider], [role=tab], [role=dialog], [role=separator]') !== null
  );
}

/** Space plays and pauses; Left and Right step a frame, ten with Shift. */
export function useTransportKeys(player: Player): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || ownsKeys(event.target)) return;
      if (event.key === ' ') {
        event.preventDefault();
        if (!event.repeat) player.toggle();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        player.step(event.key === 'ArrowLeft' ? -step : step);
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
