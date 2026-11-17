// A timeout that re-arms itself from its own callback (a tween that restarts) must not keep a held frame firing for ever:
// the timer a hold timer's callback makes follows the frame clock, not the hold.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireHoldTimer, installDeterminism, resetVirtualClock, setHoldProbe, setVirtualFrame, uninstallDeterminism } from '../src/determinism.js';

beforeEach(() => {
  installDeterminism();
  resetVirtualClock();
  setHoldProbe(() => true);
});
afterEach(() => {
  setHoldProbe(() => false);
  uninstallDeterminism();
});

describe('hold timers', () => {
  it('fire a timer made while the frame is held, but not the one that timer makes', () => {
    let runs = 0;
    const again = (): void => {
      runs++;
      setTimeout(again, 100);
    };
    setTimeout(again, 100);
    expect(fireHoldTimer()).toBe(true);
    expect(fireHoldTimer()).toBe(false);
    expect(runs).toBe(1);
    // It runs when the frame clock reaches it.
    setVirtualFrame(3, 30);
    expect(runs).toBe(2);
  });
});
