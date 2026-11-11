// Draws that wait for the frame to settle. A 3D canvas draws once the frame's loads (textures, models, fetches) are done
// and every Suspense has revealed, not when its own effect runs: a load a page starts after the draw (a texture loader's
// image, a `useTexture` inside the page's own `<Suspense>`) would otherwise be drawn black or not at all. The frame loop
// calls `drawSettled` each time nothing is pending; it draws what asked, and says whether it drew anything, so the loop
// waits again for what the draw started.

const waiting = new Map<symbol, () => void>();

/** Asks for `draw` to run once, when the frame has settled. `key` is the asker's: asking again replaces the draw. */
export function drawWhenSettled(key: symbol, draw: () => void): void {
  waiting.set(key, draw);
}

/** Forgets an asked draw (the asker unmounted). */
export function cancelDraw(key: symbol): void {
  waiting.delete(key);
}

/** Runs the asked draws, in the order they were asked. Returns whether there were any. */
export function drawSettled(): boolean {
  if (waiting.size === 0) return false;
  const draws = [...waiting.values()];
  waiting.clear();
  for (const draw of draws) draw();
  return true;
}
