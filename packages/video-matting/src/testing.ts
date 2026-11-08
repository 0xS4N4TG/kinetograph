// For tests only: stand-ins for the addon, the network and the model list.

import type { ModelSpec } from './registry.js';
import { hooks, resetState, type MattingAddon } from './state.js';

export type { MattingAddon, MatteVideoOptions, MatteVideoResult, MattingSupport } from './state.js';
export type { ModelSpec } from './registry.js';

/** `null` is an addon that cannot be loaded; `undefined` loads the real one again. */
export function setAddonForTests(addon: MattingAddon | null | undefined): void {
  hooks.addon = addon;
}

export function setFetchForTests(fetchImpl: typeof fetch): void {
  hooks.fetch = fetchImpl;
}

export function setModelsForTests(models: ModelSpec[]): void {
  hooks.models = models;
}

/** Forgets every stand-in and what is loaded. */
export function resetVideoMattingForTests(): void {
  resetState();
}
