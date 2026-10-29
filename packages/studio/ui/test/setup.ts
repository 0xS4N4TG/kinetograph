import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { decode, draws, installCanvasStubs } from './canvas';

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
