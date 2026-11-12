// The history of an island's tree, for CSS transitions (packages/cli/skills/kinetograph-markup/references/ENGINE.md §7.12). A transition starts when a style
// value changes, so a frame needs the states before it; the Rust side replays `IslandRequest.history`. The frame
// loop makes that history a function of the frame alone: it renders the frames of the window before the one asked
// for, with recording on, and `mapDomIsland` keeps each island's request root whenever it differs from the last.

import { createHash } from 'node:crypto';

import type { IslandSnapshotJson, RequestNode } from '../request/build.js';

/** The longest `delay + duration` of any transition seen, in seconds (never more than twice the longest time). */
let windowSeconds = 0;
let recording = false;
let warming = false;
/** Per island path: the states in time order, the oldest being the one in force at the window's start. */
const trail = new Map<string, IslandSnapshotJson[]>();
const lastJson = new Map<string, string>();

const TIME = /(\d*\.?\d+)(ms|s)\b/g;

function noteText(text: string): void {
  let at = text.indexOf('transition');
  while (at !== -1) {
    let end = at;
    while (end < text.length && text[end] !== ';' && text[end] !== '}') end++;
    for (const m of text.slice(at, end).matchAll(TIME)) {
      const seconds = m[2] === 'ms' ? Number(m[1]) / 1000 : Number(m[1]);
      windowSeconds = Math.max(windowSeconds, 2 * seconds);
    }
    at = text.indexOf('transition', end);
  }
}

function noteNode(node: RequestNode): void {
  if (node.kind !== 'element') return;
  if (node.style.includes('transition')) noteText(node.style);
  const attrStyle = node.attrs.style;
  if (attrStyle !== undefined && attrStyle.includes('transition')) noteText(attrStyle);
  for (const child of node.children) {
    if (child.kind === 'text') {
      if (child.text.includes('transition')) noteText(child.text);
    } else noteNode(child);
  }
}

/** Looks for `transition` in an island's CSS, to learn how far back its history has to reach. */
export function noteTransitions(root: RequestNode, stylesheets: readonly string[]): void {
  for (const css of stylesheets) if (css.includes('transition')) noteText(css);
  noteNode(root);
}

/** Seconds a frame's history has to reach back (0 when no transition has been seen). */
export function transitionWindowSeconds(): number {
  return windowSeconds;
}

/** `record`: keep the islands' states. `warm`: only keep them (the addon is not called, nothing is drawn). */
export function setHistoryMode(mode: { record: boolean; warm?: boolean }): void {
  recording = mode.record;
  warming = mode.warm === true;
}

export function isWarming(): boolean {
  return warming;
}

export function clearHistory(): void {
  trail.clear();
  lastJson.clear();
}

export function resetTransitionWindow(): void {
  windowSeconds = 0;
  clearHistory();
}

/** The states of the island before `time`, oldest first (empty when nothing is recorded). */
export function historyFor(path: string, time: number): IslandSnapshotJson[] {
  if (!recording || windowSeconds === 0) return [];
  return (trail.get(path) ?? []).filter((s) => s.time < time);
}

/** A canvas's recording (`data-kg-webgl`, `data-kg-canvas`) is the picture, not a style: it never transitions. */
const RECORDING_ATTRS = ['data-kg-webgl', 'data-kg-canvas'] as const;

/** The tree with each canvas recording replaced by its hash (the same tree when it has none), so a state kept for the
 * history costs the tree, not a copy of every recording of the window. */
function withoutRecordings(node: RequestNode): RequestNode {
  if (node.kind !== 'element') return node;
  let attrs = node.attrs;
  for (const name of RECORDING_ATTRS) {
    const value = attrs[name];
    if (value !== undefined) attrs = { ...attrs, [name]: createHash('sha1').update(value).digest('hex') };
  }
  let children = node.children;
  for (let i = 0; i < node.children.length; i++) {
    const child = withoutRecordings(node.children[i]!);
    if (child !== node.children[i]) {
      if (children === node.children) children = node.children.slice();
      children[i] = child;
    }
  }
  return attrs === node.attrs && children === node.children ? node : { ...node, attrs, children };
}

/** Keeps the island's state at `time` if it is not the one before it. */
export function recordIsland(path: string, time: number, full: RequestNode): void {
  if (!recording || windowSeconds === 0) return;
  const root = withoutRecordings(full);
  const json = JSON.stringify(root);
  if (lastJson.get(path) === json) return;
  lastJson.set(path, json);
  const states = trail.get(path) ?? [];
  states.push({ time, root });
  // Only what the window reaches matters: the states inside it and the one in force at its start.
  const from = time - windowSeconds;
  let keep = 0;
  while (keep + 1 < states.length && states[keep + 1]!.time <= from) keep++;
  trail.set(path, keep > 0 ? states.slice(keep) : states);
}
