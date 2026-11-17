import { describe, expect, it } from 'vitest';
import { installDomGlobals } from '../src/shim/index.js';

installDomGlobals();
const g = globalThis as any;

describe('UI event constructors', () => {
  it('are globals with the spec chain and init dictionaries, and dispatch to an element listener', () => {
    const event = new g.PointerEvent('pointermove', { clientX: 12, clientY: 34, pointerId: 7, pointerType: 'mouse', shiftKey: true });
    expect(event instanceof g.PointerEvent && event instanceof g.MouseEvent && event instanceof g.UIEvent && event instanceof Event).toBe(true);
    expect([event.type, event.clientX, event.pageY, event.pointerId, event.pointerType, event.width, event.isPrimary, event.button, event.getModifierState('Shift')]).toEqual([
      'pointermove', 12, 34, 7, 'mouse', 1, false, 0, true,
    ]);
    const wheel = new g.WheelEvent('wheel', { deltaY: -120, deltaMode: g.WheelEvent.DOM_DELTA_LINE });
    expect([wheel.deltaX, wheel.deltaY, wheel.deltaMode, wheel instanceof g.MouseEvent, wheel.cancelable]).toEqual([0, -120, 1, true, false]);
    const seen: string[] = [];
    const canvas = g.document.createElement('canvas');
    canvas.addEventListener('pointerdown', (e: any) => seen.push(`${e.type}:${e.clientX}`));
    canvas.dispatchEvent(new g.PointerEvent('pointerdown', { clientX: 5 }));
    expect(seen).toEqual(['pointerdown:5']);
  });
});
