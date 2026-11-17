// Scripted input (`--input`): a page that starts on a click ("Play", "Click to start") or draws only for a pointer or a key
// never gets one in a render, and the engine cannot guess intent. The events a project lists are dispatched on the
// virtual clock instead: those of frame f (and any before it not yet sent) go out when the clock reaches f, before that
// frame's animation-frame callbacks. A page is built once and never rebuilt, so the list is walked once, in order; a
// frame reached by a jump sends the events of the frames it skipped on the way.

import { KeyboardEventShim, MouseEventShim, PointerEventShim, WheelEventShim } from './events.js';

export interface PageInputEvent {
  frame: number;
  type: string;
  /** The element the event is dispatched at (the first match); the page's `body` when left out. */
  selector?: string;
  x?: number;
  y?: number;
  key?: string;
  button?: number;
  deltaX?: number;
  deltaY?: number;
}

const POINTER = new Set(['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave']);
const MOUSE = new Set(['click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'contextmenu']);
const KEY = new Set(['keydown', 'keyup', 'keypress']);

/** `--input`: a JSON list of events (or an object with the list under `events`), each checked. */
export function parsePageInput(text: string): PageInputEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value)) throw new Error('--input must be a JSON list of { frame, type, selector?, x?, y?, key? }');
  return value.map((item, i): PageInputEvent => {
    const at = `--input[${i}]`;
    if (typeof item !== 'object' || item === null) throw new Error(`${at} must be an object`);
    const e = item as Record<string, unknown>;
    if (typeof e.frame !== 'number' || !Number.isInteger(e.frame) || e.frame < 0) throw new Error(`${at}.frame must be a whole frame number from 0`);
    if (typeof e.type !== 'string' || !(POINTER.has(e.type) || MOUSE.has(e.type) || KEY.has(e.type) || e.type === 'wheel')) {
      throw new Error(`${at}.type must be a pointer, mouse, key or wheel event ("click", "pointerdown", "keydown", ...), got ${JSON.stringify(e.type)}`);
    }
    if (e.selector !== undefined && typeof e.selector !== 'string') throw new Error(`${at}.selector must be a CSS selector`);
    if (KEY.has(e.type) && typeof e.key !== 'string') throw new Error(`${at}.key is needed for a key event ("a", "ArrowLeft", " ")`);
    for (const name of ['x', 'y', 'button', 'deltaX', 'deltaY']) {
      if (e[name] !== undefined && typeof e[name] !== 'number') throw new Error(`${at}.${name} must be a number`);
    }
    return e as unknown as PageInputEvent;
  });
}

let events: PageInputEvent[] = [];
let next = 0;
let armed = false;

/** Sets the list (replacing the last) and starts walking it from the first event. */
export function setPageInput(list: PageInputEvent[]): void {
  // Stable: events of one frame keep the order they were listed in.
  events = list.map((event, index) => ({ event, index })).sort((a, b) => a.event.frame - b.event.frame || a.index - b.index).map((x) => x.event);
  next = 0;
  armed = false;
}

export function pageInputCount(): number {
  return events.length;
}

/** Whether an event is due at or before `frame` and not yet sent (a jump must step the frames up to it). */
export function pageInputDue(frame: number): boolean {
  return armed && next < events.length && events[next]!.frame <= frame;
}

/** The page's scripts have run, so its listeners exist: events are sent from now on, not before. */
export function armPageInput(): void {
  armed = true;
}

type Node_ = { parentElement?: unknown; dispatchEvent?: (event: Event) => boolean };

function build(input: PageInputEvent): Event {
  const common = { bubbles: true, cancelable: true, clientX: input.x ?? 0, clientY: input.y ?? 0, button: input.button ?? 0 };
  if (POINTER.has(input.type)) return new PointerEventShim(input.type, { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: input.type === 'pointerdown' ? 1 : 0 });
  if (MOUSE.has(input.type)) return new MouseEventShim(input.type, { ...common, buttons: input.type === 'mousedown' ? 1 : 0 });
  if (input.type === 'wheel') return new WheelEventShim('wheel', { ...common, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 });
  return new KeyboardEventShim(input.type, { bubbles: true, cancelable: true, key: input.key ?? '', code: input.key ?? '' });
}

/** The target, its ancestors, the document, the window: the order a bubbling event visits them. */
function dispatchBubbling(target: Node_, event: Event): void {
  const g = globalThis as unknown as Record<string, Node_>;
  const path: Node_[] = [];
  for (let n: Node_ | null = target; n !== null && n !== undefined; n = (n.parentElement as Node_ | null) ?? null) path.push(n);
  path.push(g.document!, g);
  Object.defineProperty(event, 'target', { value: target, configurable: true });
  for (const node of path) {
    Object.defineProperty(event, 'currentTarget', { value: node, configurable: true });
    const handler = (node as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === 'function') handler.call(node, event);
    node.dispatchEvent?.(event);
    if ((event as Event & { cancelBubble?: boolean }).cancelBubble) break;
  }
  Object.defineProperty(event, 'currentTarget', { value: null, configurable: true });
}

/** Sends the events due at `frame` that have not gone out. `report` is told of one whose selector matches nothing. */
export function dispatchPageInput(frame: number, report: (message: string) => void = () => {}): void {
  if (!armed || !Number.isInteger(frame)) return;
  const g = globalThis as unknown as { document: { querySelector(selector: string): Node_ | null; body: Node_ } };
  while (next < events.length && events[next]!.frame <= frame) {
    const input = events[next++]!;
    const target = input.selector === undefined ? g.document.body : g.document.querySelector(input.selector);
    if (target === null) {
      report(`--input: no element matches "${input.selector}" for the ${input.type} at frame ${input.frame}, so it was not sent`);
      continue;
    }
    try {
      dispatchBubbling(target, build(input));
    } catch (error) {
      report(`--input: the page's ${input.type} handler threw at frame ${input.frame}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
