// Whether an island's CSS can move anything (`islandMoves`): the cases of crates/dom/src/moving.rs, which this check
// must agree with or be more cautious than.

import { describe, expect, it } from 'vitest';
import { islandMoves } from '../src/dom/moving.js';
import type { RequestNode } from '../src/request/build.js';

const tree = (classes: string[], style = ''): RequestNode => ({
  kind: 'element',
  tag: 'section',
  path: '$0',
  attrs: { id: 'Main' },
  style,
  children: classes.map((c) => ({ kind: 'element', tag: 'span', path: '$0.0', attrs: { class: c }, style: '', children: [] })),
});

const moves = (css: string, classes: string[]): boolean => islandMoves([css], [tree(classes)]);

const TAILWIND = `
  @layer theme { :root, :host { --default-transition-duration: 150ms; --animate-spin: spin 1s linear infinite; } }
  @layer utilities {
    .transition { transition-property: color, opacity; transition-duration: var(--tw-duration, var(--default-transition-duration)); }
    .animate-spin { animation: var(--animate-spin); }
    .hover-all { &:hover { @media (hover: hover) { transition-property: all; } } }
    .flex { display: flex; }
  }
  @keyframes spin { to { transform: rotate(360deg); animation-timing-function: linear; } }
  @property --tw-duration { syntax: "*"; inherits: false; }
  /* .flex { transition: all 1s } */
`;

describe('islandMoves', () => {
  it('leaves out rules no element can match', () => {
    expect(moves(TAILWIND, ['flex p-4'])).toBe(false);
    expect(moves(TAILWIND, ['flex transition'])).toBe(true);
    expect(moves(TAILWIND, ['animate-spin'])).toBe(true);
    expect(moves(TAILWIND, ['hover-all'])).toBe(true);
  });

  it('reads the rightmost compound of each selector', () => {
    expect(moves('.a .b { transition: opacity 1s }', ['b'])).toBe(true);
    expect(moves('.a .b { transition: opacity 1s }', ['a'])).toBe(false);
    expect(moves('.b.c { transition: opacity 1s }', ['b'])).toBe(false);
    expect(moves('.b.c::before { transition: opacity 1s }', ['b c'])).toBe(true);
    expect(moves('section { transition: opacity 1s }', [])).toBe(true);
    expect(moves('body > div { animation: x 1s }', [])).toBe(true);
    expect(moves('p { transition: opacity 1s }', [])).toBe(false);
    expect(moves('#main { transition: opacity 1s }', [])).toBe(true);
    expect(moves('#other { transition: opacity 1s }', [])).toBe(false);
    expect(moves('.x { &:hover { transition: all } }', [])).toBe(false);
    expect(moves('.x { &:hover { transition: all } }', ['x'])).toBe(true);
    expect(moves('.x { .y & { transition: all } }', ['x'])).toBe(true);
    expect(moves('@media (min-width: 1px) { .y { animation: z 1s } }', ['y'])).toBe(true);
    expect(moves('.y { color: red; --transition: 1s; }', ['y'])).toBe(false);
  });

  it('counts what it does not follow as moving', () => {
    expect(moves(':is(.q) { transition: opacity 1s }', [])).toBe(true);
    expect(moves('[data-x] { transition: opacity 1s }', [])).toBe(true);
    expect(moves('* { transition: opacity 1s }', [])).toBe(true);
    expect(moves('svg|rect { transition: opacity 1s }', [])).toBe(true);
    expect(moves('.a { transition: opacity 1s', [])).toBe(true);
    expect(moves("@import 'other.css'; .a { transition: opacity 1s }", [])).toBe(true);
    expect(moves('@starting-style { .a { opacity: 0 } } .t { transition: x }', [])).toBe(true);
    // Escapes and non-ASCII text are not followed here (the engine reads them).
    expect(moves('.\\31 0 { transition: opacity 1s }', ['1'])).toBe(true);
    expect(moves('.é { transition: opacity 1s }', [])).toBe(true);
    expect(moves('/* .flex { transition: all 1s } */ .flex { color: red }', ['flex'])).toBe(false);
    expect(moves(".a { content: '}'; transition: all 1s }", ['a'])).toBe(true);
  });

  it('counts a style or a <style> element that mentions one, in any tree', () => {
    expect(islandMoves([], [tree([], 'transition: opacity 1s')])).toBe(true);
    const sheet: RequestNode = { kind: 'element', tag: 'style', path: '$0.1', attrs: {}, style: '', children: [{ kind: 'text', text: '.z { animation: a 1s }' }] };
    expect(islandMoves([], [tree([]), { ...(tree([]) as Extract<RequestNode, { kind: 'element' }>), children: [sheet] }])).toBe(true);
    // A history tree's classes count.
    expect(islandMoves(['.transition { transition: all 1s }'], [tree(['flex']), tree(['transition'])])).toBe(true);
  });
});
