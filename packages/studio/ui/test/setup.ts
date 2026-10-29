import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';

import { decode, draws, installCanvasStubs } from './canvas';

// react-resizable-panels measures layout (the studio no longer uses it). In jsdom every rect is zero, so it takes each pointer for a drag on a separator
// and cancels pointerdown (no mousedown, no focus from a click). Panels render as plain boxes in tests.
vi.mock('react-resizable-panels', () => {
  const box = (role?: string) =>
    function Box({ children, className }: { children?: ReactNode; className?: string }) {
      return createElement('div', { className, role }, children);
    };
  return { Group: box(), Panel: box(), Separator: box('separator') };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Radix and the pointer scrubbing call these; jsdom has none.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.scrollIntoView = () => {};
// Base UI and motion ask for running animations; jsdom has none.
Element.prototype.getAnimations = () => [];

installCanvasStubs();

beforeEach(() => {
  draws.length = 0;
  decode.delay = () => 0;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});
